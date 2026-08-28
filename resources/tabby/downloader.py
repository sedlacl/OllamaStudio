import aiofiles
import aiohttp
import asyncio
import errno
import math
import pathlib
import shutil
import time
from dataclasses import dataclass
from fnmatch import fnmatch
from huggingface_hub import HfApi, hf_hub_url
from huggingface_hub.hf_api import RepoFile
from rich.progress import Progress
from typing import List, Optional

from common.logger import get_progress_bar, xlogger
from common.tabby_config import config
from common.utils import unwrap


FILE_DOWNLOAD_ATTEMPTS = 3
CLEANUP_ATTEMPTS = 5
_RETRYABLE_DOWNLOAD_ERRORS = (
    aiohttp.ClientPayloadError,
    aiohttp.ClientConnectionError,
    asyncio.TimeoutError,
)
_RETRYABLE_CLEANUP_ERRNOS = {
    errno.EACCES,
    errno.EBUSY,
    errno.ENOTEMPTY,
    errno.EPERM,
}


@dataclass
class RepoItem:
    path: str
    size: int
    url: str


async def _download_file_once(
    session: aiohttp.ClientSession,
    repo_item: RepoItem,
    token: Optional[str],
    partial_path: pathlib.Path,
    chunk_limit_bytes: int,
    progress: Progress,
    progress_task: int,
):
    req_headers = {"Authorization": f"Bearer {token}"} if token else {}
    received = 0

    async with session.get(repo_item.url, headers=req_headers) as response:
        if not response.ok:
            error_text = await response.text()
            raise aiohttp.ClientResponseError(
                response.request_info,
                response.history,
                status=response.status,
                message=f"HTTP {response.status}: {error_text}",
            )

        async with aiofiles.open(str(partial_path), "wb") as file:
            async for chunk in response.content.iter_chunked(chunk_limit_bytes):
                await file.write(chunk)
                received += len(chunk)
                progress.update(progress_task, advance=len(chunk))

    if received != repo_item.size:
        raise aiohttp.ClientPayloadError(
            f"Incomplete response for {repo_item.path}: "
            f"expected {repo_item.size} bytes, received {received} bytes"
        )


async def _download_file(
    session: aiohttp.ClientSession,
    repo_item: RepoItem,
    token: Optional[str],
    download_path: pathlib.Path,
    chunk_limit: int,
    progress: Progress,
):
    """Download one file, retrying interrupted responses from byte zero."""

    chunk_limit_bytes = math.ceil(unwrap(chunk_limit, 2000000) * 100000)
    filepath = download_path / repo_item.path
    partial_path = filepath.with_name(f"{filepath.name}.part")
    filepath.parent.mkdir(parents=True, exist_ok=True)
    progress_task = progress.add_task(
        f"[cyan]Downloading {repo_item.path}",
        total=repo_item.size,
    )

    for attempt in range(1, FILE_DOWNLOAD_ATTEMPTS + 1):
        progress.reset(progress_task, total=repo_item.size, completed=0)
        try:
            await _download_file_once(
                session,
                repo_item,
                token,
                partial_path,
                chunk_limit_bytes,
                progress,
                progress_task,
            )
            partial_path.replace(filepath)
            return
        except _RETRYABLE_DOWNLOAD_ERRORS as exc:
            if attempt >= FILE_DOWNLOAD_ATTEMPTS:
                raise
            xlogger.warning(
                "Interrupted Hugging Face file download; retrying",
                {
                    "file": repo_item.path,
                    "attempt": attempt,
                    "max_attempts": FILE_DOWNLOAD_ATTEMPTS,
                    "error_type": type(exc).__name__,
                },
            )
            await asyncio.sleep(attempt)


def _get_repo_info(repo_id, revision, token):
    """Fetch information about a Hugging Face repository."""
    revision = revision or None
    token = token or None
    api_client = HfApi()
    repo_tree = api_client.list_repo_tree(repo_id, revision=revision, token=token, recursive=True)

    return [
        RepoItem(
            path=item.path,
            size=item.size,
            url=hf_hub_url(repo_id, item.path, revision=revision),
        )
        for item in repo_tree
        if isinstance(item, RepoFile)
    ]


def _get_download_folder(repo_id: str, repo_type: str, folder_name: Optional[str]):
    """Get the download folder for the repo."""
    if repo_type == "lora":
        download_path = pathlib.Path(config.lora.lora_dir)
    else:
        download_path = pathlib.Path(config.model.model_dir)

    return download_path / (folder_name or repo_id.split("/")[-1])


def _check_exclusions(filename: str, include_patterns: List[str], exclude_patterns: List[str]):
    include_result = any(fnmatch(filename, pattern) for pattern in include_patterns)
    exclude_result = any(fnmatch(filename, pattern) for pattern in exclude_patterns)
    return include_result and not exclude_result


def _is_retryable_cleanup_error(exc: OSError) -> bool:
    return exc.errno in _RETRYABLE_CLEANUP_ERRNOS or getattr(exc, "winerror", None) == 32


def _remove_download_path(download_path: pathlib.Path) -> Optional[OSError]:
    """Remove a failed download with bounded Windows lock retries."""
    last_error = None
    for attempt in range(1, CLEANUP_ATTEMPTS + 1):
        try:
            if download_path.is_dir():
                shutil.rmtree(download_path)
            else:
                download_path.unlink(missing_ok=True)
            return None
        except OSError as exc:
            last_error = exc
            if not _is_retryable_cleanup_error(exc) or attempt >= CLEANUP_ATTEMPTS:
                return exc
            time.sleep(0.15 * attempt)
    return last_error


async def _cancel_and_wait(tasks: List[asyncio.Task]):
    """Cancel siblings and wait until every response/file context has exited."""
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def hf_repo_download(
    repo_id: str,
    folder_name: Optional[str],
    revision: Optional[str],
    token: Optional[str],
    include: Optional[List[str]],
    exclude: Optional[List[str]],
    chunk_limit: Optional[float] = None,
    timeout: Optional[int] = None,
    repo_type: Optional[str] = "model",
):
    """Get repository information and download all selected files."""
    file_list = await asyncio.to_thread(_get_repo_info, repo_id, revision, token)

    if not repo_type:
        lora_filter = filter(
            lambda repo_item: repo_item.path.endswith(("adapter_config.json", "adapter_model.bin")),
            file_list,
        )
        if any(lora_filter):
            repo_type = "lora"

    if include or exclude:
        include_patterns = unwrap(include, ["*"])
        exclude_patterns = unwrap(exclude, [])
        file_list = [
            file
            for file in file_list
            if _check_exclusions(file.path, include_patterns, exclude_patterns)
        ]

    if not file_list:
        raise ValueError(f"File list for repo {repo_id} is empty. Check your filters?")

    download_path = _get_download_folder(repo_id, repo_type, folder_name)
    if download_path.exists():
        raise FileExistsError(
            f"The path {download_path} already exists. Remove the folder and try again."
        )

    download_path.parent.mkdir(parents=True, exist_ok=True)
    xlogger.info(f"Saving {repo_id} to {str(download_path)}")
    progress = get_progress_bar()
    progress.start()

    try:
        client_timeout = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(timeout=client_timeout) as session:
            xlogger.info(f"Starting download for {repo_id}")
            tasks = [
                asyncio.create_task(
                    _download_file(
                        session,
                        repo_item,
                        token=token,
                        download_path=download_path.resolve(),
                        chunk_limit=chunk_limit,
                        progress=progress,
                    )
                )
                for repo_item in file_list
            ]
            try:
                await asyncio.gather(*tasks)
            except BaseException:
                await _cancel_and_wait(tasks)
                raise

        xlogger.info(f"Finished download for {repo_id}")
        return download_path
    except BaseException:
        cleanup_error = await asyncio.to_thread(_remove_download_path, download_path)
        if cleanup_error is not None:
            xlogger.warning(
                "Failed download cleanup left a partial folder",
                {
                    "error_type": type(cleanup_error).__name__,
                    "error_code": getattr(cleanup_error, "errno", None),
                    "winerror": getattr(cleanup_error, "winerror", None),
                },
            )
        raise
    finally:
        progress.stop()
