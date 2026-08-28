"""Synthetic-key tests for the Tabby auth.py runtime patch."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")

import py_compile
from loguru import logger

REPO = pathlib.Path(__file__).resolve().parent
PATCHED = REPO / "auth.py"
ORIGINAL = REPO / "original-auth.py"
TABBY_RUNTIME = pathlib.Path(os.environ.get("TABBY_RUNTIME_ROOT", r"D:\AI\Tabby"))


class AuthPatchTests(unittest.TestCase):
    def test_patched_sources_compile(self):
        with tempfile.TemporaryDirectory() as cache_dir:
            for source in (PATCHED, ORIGINAL):
                cfile = pathlib.Path(cache_dir) / f"{source.stem}.pyc"
                py_compile.compile(str(source), cfile=str(cfile), doraise=True)
            self.assertFalse(PATCHED.with_suffix(".pyc").exists())
            self.assertFalse((PATCHED.parent / "__pycache__").exists())

    def test_patched_source_does_not_contain_plaintext_key_banner(self):
        text = PATCHED.read_text(encoding="utf-8")
        self.assertNotIn("Your API key is:", text)
        self.assertNotIn("_format_api_keys", text)
        self.assertIn("Auth keys loaded", text)

    def test_load_auth_keys_does_not_print_plaintext_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            tokens_file = pathlib.Path(tmp) / "api_tokens.yml"
            self.assertFalse(tokens_file.exists())

            if TABBY_RUNTIME.is_dir():
                sys.path.insert(0, str(TABBY_RUNTIME))
            spec = importlib.util.spec_from_file_location("ollamastudio_tabby_auth", PATCHED)
            patched = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            sys.modules[spec.name] = patched
            spec.loader.exec_module(patched)

            synthetic_api = "synthetic_runtime_api_key_001"
            synthetic_admin = "synthetic_runtime_admin_key_002"

            class FakeKeys:
                api_key = synthetic_api
                admin_key = synthetic_admin

                class _Set:
                    def __len__(self):
                        return 1

                _api_key_set = _Set()

            patched.AUTH_KEYS = FakeKeys()
            patched.DISABLE_AUTH = False
            patched._watch_task = None

            captured: list[str] = []
            sink_id = logger.add(lambda message: captured.append(str(message)))
            try:
                with patch.object(patched, "_read_auth_file", return_value=FakeKeys()):
                    asyncio.run(patched.load_auth_keys(False))
            finally:
                logger.remove(sink_id)

            combined = "\n".join(captured)
            self.assertNotIn(synthetic_api, combined)
            self.assertNotIn(synthetic_admin, combined)
            self.assertIn("Auth keys loaded", combined)
            self.assertFalse(tokens_file.exists())
            self.assertFalse(pathlib.Path.cwd().joinpath("api_tokens.yml").exists())


if __name__ == "__main__":
    unittest.main()
