import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import runtime


def archive(version="2.0.77", extra=None):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w:xz") as output:
        for name, data in {"bin/x64/factorio": b"fixture binary", "data/map-settings.example.json": b"{}", "data/server-settings.example.json": b"{}", "data/map-gen-settings.example.json": b"{}"}.items():
            entry = tarfile.TarInfo("factorio/" + name)
            entry.size = len(data)
            output.addfile(entry, io.BytesIO(data))
        if extra:
            output.addfile(extra)
    body = result.getvalue()
    return body, {"version": 1, "provider": runtime.PROVIDER, "softwareVersion": version, "sha256": hashlib.sha256(body).hexdigest()}


class RuntimeInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.body, self.wanted = archive()
        self.downloads = []

    def download(self, url, output, limit):
        self.downloads.append(url)
        output.write(self.body)

    def boot(self, **kwargs):
        game, fd = runtime.boot(self.data, downloader=self.download, resolver=lambda channel: self.wanted, probe=lambda binary: "Version: " + self.wanted["softwareVersion"] + " (fixture)", **kwargs)
        os.close(fd)
        return game

    def test_fresh_install_resolves_once_and_recreated_container_reuses_exact_release_offline(self):
        game = self.boot()
        self.assertEqual(len(self.downloads), 1)
        receipt = json.loads((self.data / "runtime/installed.json").read_text())
        self.assertTrue(receipt["files"])
        with patch.object(runtime, "selection", side_effect=AssertionError("No upstream lookup on restart")):
            self.assertEqual(self.boot(), game)
        self.assertEqual(len(self.downloads), 1)

    def test_checksum_failure_preserves_previous_release_and_world_bytes(self):
        old = self.boot()
        (self.data / "saves").mkdir()
        (self.data / "saves/World.zip").write_bytes(b"existing world")
        before = (self.data / "runtime/installed.json").read_bytes()
        wanted = {**self.wanted, "softwareVersion": "2.0.78", "sha256": "a" * 64, "operation": "12345678-1234-1234-1234-123456789abc", "previous": runtime.release_key(self.wanted)}
        (self.data / "runtime/request.json").write_text(json.dumps(wanted))
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.boot()
        self.assertEqual((self.data / "runtime/installed.json").read_bytes(), before)
        self.assertEqual((self.data / "saves/World.zip").read_bytes(), b"existing world")
        self.assertTrue(old.is_dir())

    def test_existing_world_without_receipt_needs_explicit_bootstrap(self):
        (self.data / "saves").mkdir()
        (self.data / "saves/World.zip").write_bytes(b"existing")
        with self.assertRaisesRegex(ValueError, "explicit verified runtime bootstrap"):
            self.boot()
        self.assertEqual(self.downloads, [])
        (self.data / "runtime/bootstrap.json").write_text(json.dumps(self.wanted))
        self.boot()
        self.assertEqual((self.data / "saves/World.zip").read_bytes(), b"existing")

    def test_upgrade_retains_previous_release_and_handles_crash_after_receipt_commit(self):
        old = self.boot()
        wanted = {**self.wanted, "softwareVersion": "2.0.78", "operation": "12345678-1234-1234-1234-123456789abc", "previous": runtime.release_key(self.wanted)}
        (self.data / "runtime/request.json").write_text(json.dumps(wanted))
        self.wanted = wanted
        new = self.boot()
        self.assertNotEqual(new, old)
        self.assertTrue(old.is_dir())
        # Simulate a kill after receipt publication and before request unlink.
        (self.data / "runtime/request.json").write_text(json.dumps(wanted))
        self.downloads.clear()
        self.assertEqual(self.boot(), new)
        self.assertEqual(self.downloads, [])
        self.assertFalse((self.data / "runtime/request.json").exists())

    def test_cached_release_activation_records_current_operation_and_replays_offline_after_commit(self):
        old = self.boot()
        root = self.data / "runtime"
        original = json.loads((root / "installed.json").read_text())
        metadata = root / "releases" / (runtime.release_key(original) + ".json")
        cached_metadata = metadata.read_bytes()
        newer = {**self.wanted, "softwareVersion": "2.0.78", "operation": "12345678-1234-1234-1234-123456789abc", "previous": runtime.release_key(original)}
        request = root / "request.json"
        request.write_text(json.dumps(newer))
        self.wanted = newer
        new = self.boot()
        returning = {**original, "operation": "87654321-1234-1234-1234-123456789abc", "previous": runtime.release_key(newer), "files": []}
        request.write_text(json.dumps(returning))
        unlink = Path.unlink

        def interrupted_unlink(file, *args, **kwargs):
            if file == request:
                raise RuntimeError("Killed after receipt publication")
            return unlink(file, *args, **kwargs)

        with patch.object(self, "download", side_effect=AssertionError("Cached activation must stay offline")):
            with patch.object(Path, "unlink", interrupted_unlink):
                with self.assertRaisesRegex(RuntimeError, "Killed after receipt publication"):
                    self.boot()
            receipt = json.loads((root / "installed.json").read_text())
            self.assertEqual(receipt["operation"], returning["operation"])
            self.assertEqual(receipt["previous"], returning["previous"])
            self.assertEqual(receipt["files"], original["files"])
            self.assertTrue(request.exists())
            self.assertEqual(self.boot(), old)
        self.assertFalse(request.exists())
        self.assertTrue(new.is_dir())
        self.assertEqual(metadata.read_bytes(), cached_metadata)
        self.assertEqual(len(self.downloads), 2)

    def test_modified_missing_and_linked_releases_fail_closed_without_installing_latest(self):
        game = self.boot()
        (game / "bin/x64/factorio").write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "no longer matches"):
            self.boot()
        self.assertEqual(len(self.downloads), 1)
        (game / "bin/x64/factorio").unlink()
        (game / "bin/x64/factorio").symlink_to("/etc/passwd")
        with self.assertRaises(ValueError):
            self.boot()

    def test_lock_blocks_another_installer_while_game_owns_release(self):
        game, fd = runtime.boot(self.data, downloader=self.download, resolver=lambda channel: self.wanted, probe=lambda binary: "Version: 2.0.77")
        try:
            with self.assertRaises(BlockingIOError):
                self.boot()
        finally:
            os.close(fd)

    def test_abandoned_install_staging_is_cleaned_without_following_links(self):
        self.boot()
        abandoned = self.data / "runtime/.install-killed"
        abandoned.mkdir()
        (abandoned / "partial-download").write_bytes(b"partial")
        self.boot()
        self.assertFalse(abandoned.exists())
        private = self.data / "private"
        private.mkdir()
        (private / "sentinel").write_text("preserve")
        abandoned.symlink_to(private, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.boot()
        self.assertEqual((private / "sentinel").read_text(), "preserve")

    def test_archive_links_traversal_duplicates_and_wrong_binary_are_rejected(self):
        for name, kind in [("factorio/../../escape", tarfile.REGTYPE), ("factorio/data/link", tarfile.SYMTYPE), ("factorio/data/hard", tarfile.LNKTYPE), ("factorio/bin/x64/factorio", tarfile.REGTYPE)]:
            with self.subTest(name=name):
                entry = tarfile.TarInfo(name)
                entry.type, entry.linkname = kind, "/etc/passwd"
                self.body, self.wanted = archive(extra=entry)
                with self.assertRaises(ValueError):
                    self.boot()
        self.body, self.wanted = archive()
        with self.assertRaisesRegex(ValueError, "different release"):
            runtime.boot(self.data, downloader=self.download, resolver=lambda channel: self.wanted, probe=lambda binary: "Version: 2.1.23")
        self.assertFalse((self.data / "runtime/installed.json").exists())


if __name__ == "__main__":
    unittest.main()
