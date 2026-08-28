import asyncio
import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")

import aiohttp


TABBY_RUNTIME = pathlib.Path(os.environ.get("TABBY_RUNTIME_ROOT", r"D:\AI\Tabby"))
sys.path.insert(0, str(TABBY_RUNTIME))
PATCHED_DOWNLOADER = pathlib.Path(
    os.environ.get("PATCHED_DOWNLOADER_PATH", pathlib.Path(__file__).with_name("downloader.py"))
)
spec = importlib.util.spec_from_file_location("ollamastudio_tabby_downloader", PATCHED_DOWNLOADER)
downloader = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = downloader
spec.loader.exec_module(downloader)


class FakeProgress:
    def __init__(self):
        self.stopped = False

    def start(self):
        pass

    def stop(self):
        self.stopped = True


class FakeSession:
    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class DownloaderLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_sibling_is_cancelled_and_closed_before_cleanup_preserves_primary_error(self):
        with tempfile.TemporaryDirectory() as temp:
            target = pathlib.Path(temp) / "model"
            items = [
                downloader.RepoItem("failed.bin", 10, "https://example.invalid/a"),
                downloader.RepoItem("open.bin", 10, "https://example.invalid/b"),
            ]
            sibling_started = asyncio.Event()
            sibling_closed = asyncio.Event()
            primary = aiohttp.ClientPayloadError("response payload is not completed")
            cleanup_observations = []
            progress = FakeProgress()

            async def fake_download(_session, item, **_kwargs):
                if item.path == "failed.bin":
                    await sibling_started.wait()
                    raise primary
                target.mkdir(parents=True, exist_ok=True)
                with (target / "open.bin").open("wb") as open_file:
                    open_file.write(b"partial")
                    sibling_started.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        sibling_closed.set()

            def fake_cleanup(_path):
                cleanup_observations.append(sibling_closed.is_set())
                return PermissionError("simulated WinError 32 after bounded retries")

            def original_cleanup(_path):
                cleanup_observations.append(sibling_closed.is_set())
                raise PermissionError("simulated WinError 32")

            with (
                patch.object(downloader, "_get_repo_info", return_value=items),
                patch.object(downloader, "_get_download_folder", return_value=target),
                patch.object(downloader, "_download_file", side_effect=fake_download),
                patch.object(
                    downloader,
                    "_remove_download_path",
                    side_effect=fake_cleanup,
                    create=True,
                ),
                patch.object(downloader.shutil, "rmtree", side_effect=original_cleanup),
                patch.object(downloader, "get_progress_bar", return_value=progress),
                patch.object(downloader.aiohttp, "ClientSession", FakeSession),
            ):
                with self.assertRaises(aiohttp.ClientPayloadError) as raised:
                    await downloader.hf_repo_download(
                        repo_id="org/model",
                        folder_name="model",
                        revision=None,
                        token=None,
                        include=["*"],
                        exclude=[],
                    )

            self.assertIs(raised.exception, primary)
            self.assertEqual(cleanup_observations, [True])
            self.assertTrue(progress.stopped)

    def test_winerror_32_cleanup_is_retried_with_bounded_backoff(self):
        self.assertTrue(
            hasattr(downloader, "_remove_download_path"),
            "runtime patch must provide bounded cleanup",
        )
        with tempfile.TemporaryDirectory() as temp:
            target = pathlib.Path(temp) / "model"
            target.mkdir()
            locked = PermissionError(13, "locked")
            locked.winerror = 32

            with (
                patch.object(downloader.shutil, "rmtree", side_effect=[locked, None]) as remove,
                patch.object(downloader.time, "sleep") as sleep,
            ):
                result = downloader._remove_download_path(target)

            self.assertIsNone(result)
            self.assertEqual(remove.call_count, 2)
            sleep.assert_called_once_with(0.15)


if __name__ == "__main__":
    unittest.main()
