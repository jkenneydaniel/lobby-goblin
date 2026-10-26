"""Temporary-file and simulated-socket tests; no Docker or real world data."""
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


startup = load("startup", "entrypoint.py")
rcon = load("client", "rcon.py")


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data, self.game = self.root / "data", self.root / "game"
        (self.game / "data").mkdir(parents=True)
        for name in ("server-settings", "map-gen-settings", "map-settings"):
            (self.game / "data" / (name + ".example.json")).write_text("{}")
        self.env = {"DLC_SPACE_AGE": "false", "UPDATE_MODS_ON_START": "false"}

    def prepare(self):
        return startup.prepare(self.env, self.data, self.game)

    def test_existing_world_configuration_identity_mods_and_password_remain_exact(self):
        files = {
            "saves/Existing world.zip": b"original-save",
            "config/server-settings.json": b'{"name":"Keep my settings"}\n',
            "config/map-gen-settings.json": b'{"seed":12345}',
            "config/map-settings.json": b'{"pollution":{"enabled":false}}',
            "config/rconpw": b"existing-private-password\n",
            "config/server-id.json": b'"existing-server-identity"',
            "config/server-adminlist.json": b'["Existing admin"]',
            "config/server-banlist.json": b'["Existing ban"]',
            "config/server-whitelist.json": b'["Existing player"]',
            "mods/mod-list.json": b'{"mods":[{"name":"custom-mod","enabled":true}]}',
            "mods/custom-mod.zip": b"existing-mod",
            "mods/mod-settings.dat": b"existing-mod-settings",
        }
        for name, content in files.items():
            file = self.data / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(content)
        args, creation, _ = self.prepare()
        self.assertIsNone(creation)
        self.assertIn("--start-server-load-latest", args)
        self.assertIn("--use-server-whitelist", args)
        self.assertEqual(args[args.index("--rcon-password") + 1], "existing-private-password")
        for name, content in files.items():
            self.assertEqual((self.data / name).read_bytes(), content, name)

    def test_fresh_install_generates_one_world_and_configures_vanilla_defaults(self):
        args, creation, _ = self.prepare()
        self.assertIn("--create", creation)
        self.assertTrue(creation[creation.index("--create") + 1].endswith("World.tmp.zip"))
        mods = json.loads((self.data / "mods/mod-list.json").read_text())["mods"]
        self.assertEqual([mod["name"] for mod in mods if mod["enabled"]], ["base"])
        self.assertIn("--start-server-load-latest", args)

    def test_interrupted_first_generation_retries_without_replacing_configuration(self):
        self.env["GENERATE_NEW_SAVE"] = "false"
        _, creation, paths = self.prepare()
        password = (self.data / "config/rconpw").read_bytes()
        settings = (self.data / "config/map-gen-settings.json").read_bytes()
        # Simulate a generator killed before it can produce a complete save.
        with patch.object(startup.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "factorio")):
            with self.assertRaises(subprocess.CalledProcessError):
                startup.generate_save(creation, paths)
        _, retry, paths = self.prepare()
        self.assertEqual(retry, creation)
        self.assertEqual((self.data / "config/rconpw").read_bytes(), password)
        self.assertEqual((self.data / "config/map-gen-settings.json").read_bytes(), settings)
        def complete(command, **kwargs):
            Path(command[command.index("--create") + 1]).write_bytes(b"completed world")
        with patch.object(startup.subprocess, "run", side_effect=complete):
            startup.generate_save(retry, paths)
        self.assertIsNone(self.prepare()[1])
        self.assertEqual((self.data / "saves/World.zip").read_bytes(), b"completed world")
        # Successful first generation retires permission to create a new world.
        (self.data / "saves/World.zip").unlink()
        with self.assertRaisesRegex(ValueError, "no saves"):
            self.prepare()

    def test_interrupted_prepare_retries_and_partial_generation_is_not_loaded(self):
        self.env["GENERATE_NEW_SAVE"] = "false"
        _, creation, _ = self.prepare()
        temporary = Path(creation[creation.index("--create") + 1])
        self.assertTrue(temporary.name.endswith(".tmp.zip"))
        temporary.write_bytes(b"unfinished world")
        _, retry, _ = self.prepare()
        self.assertEqual(retry, creation)
        self.assertFalse((self.data / "saves/World.zip").exists())

    def test_pending_marker_cannot_override_an_established_identity(self):
        self.prepare()
        (self.data / "config/server-id.json").write_text('"existing identity"')
        with self.assertRaisesRegex(ValueError, "no saves"):
            self.prepare()

    def test_completed_save_retires_a_marker_left_by_an_interrupted_publication(self):
        _, creation, paths = self.prepare()
        (self.data / "saves/World.zip").write_bytes(b"complete")
        self.assertIsNone(self.prepare()[1])
        self.assertFalse((self.data / "config/.initial-world-pending").exists())
        (self.data / "saves/World.zip").unlink()
        with self.assertRaisesRegex(ValueError, "no saves"):
            self.prepare()

    def test_generation_cannot_overwrite_a_save_that_appears_while_creating(self):
        _, creation, paths = self.prepare()
        def complete(command, **kwargs):
            Path(command[command.index("--create") + 1]).write_bytes(b"generated")
            (self.data / "saves/World.zip").write_bytes(b"preserve")
        with patch.object(startup.subprocess, "run", side_effect=complete):
            with self.assertRaises(FileExistsError):
                startup.generate_save(creation, paths)
        self.assertEqual((self.data / "saves/World.zip").read_bytes(), b"preserve")
        self.assertFalse(Path(creation[creation.index("--create") + 1]).exists())
        self.assertIsNone(self.prepare()[1])
        self.assertEqual([file.name for file in (self.data / "saves").glob("*.zip")], ["World.zip"])

    def test_killed_publication_cannot_expose_a_competing_temporary_world(self):
        _, creation, _ = self.prepare()
        temporary = Path(creation[creation.index("--create") + 1])
        temporary.write_bytes(b"competing generated world")
        (self.data / "saves/World.zip").write_bytes(b"world that won the race")
        # Simulate interruption after generation but before publication/cleanup.
        self.assertIsNone(self.prepare()[1])
        self.assertNotIn(self.data / "saves", temporary.parents)
        self.assertEqual([file.name for file in (self.data / "saves").glob("*.zip")], ["World.zip"])
        self.assertEqual((self.data / "saves/World.zip").read_bytes(), b"world that won the race")

    def test_publication_uses_non_zip_staging_on_the_saves_filesystem(self):
        _, creation, paths = self.prepare()
        original_link = startup.os.link
        def complete(command, **kwargs):
            Path(command[command.index("--create") + 1]).write_bytes(b"generated world")
        def publish(source, destination, **kwargs):
            self.assertEqual(source.parent, destination.parent)
            self.assertEqual(source.suffix, ".pending")
            self.assertEqual(list(paths["SAVES"].glob("*.zip")), [])
            self.assertEqual(source.read_bytes(), b"generated world")
            original_link(source, destination, **kwargs)
        with patch.object(startup.subprocess, "run", side_effect=complete), patch.object(startup.os, "link", side_effect=publish):
            startup.generate_save(creation, paths)
        self.assertEqual([file.name for file in paths["SAVES"].iterdir()], ["World.zip"])

    def test_temporary_save_links_and_invalid_pending_markers_are_refused(self):
        _, creation, _ = self.prepare()
        external = self.root / "outside.zip"
        external.write_bytes(b"preserve")
        temporary = Path(creation[creation.index("--create") + 1])
        temporary.symlink_to(external)
        with self.assertRaisesRegex(ValueError, "ordinary file"):
            self.prepare()
        self.assertEqual(external.read_bytes(), b"preserve")
        temporary.unlink()
        (self.data / "config/.initial-world-pending").unlink()
        (self.data / "config/.initial-world-pending").mkdir()
        with self.assertRaisesRegex(ValueError, "marker"):
            self.prepare()

    def test_missing_saves_with_existing_identity_refuses_before_creating_files(self):
        (self.data / "config").mkdir(parents=True)
        (self.data / "config/rconpw").write_text("existing")
        with self.assertRaisesRegex(ValueError, "no saves"):
            self.prepare()
        self.assertFalse((self.data / "config/server-settings.json").exists())

    def test_generation_never_overwrites_an_existing_save(self):
        (self.data / "saves").mkdir(parents=True)
        (self.data / "saves/World.zip").write_bytes(b"existing")
        self.env["GENERATE_NEW_SAVE"] = "true"
        self.assertIsNone(self.prepare()[1])
        self.assertEqual((self.data / "saves/World.zip").read_bytes(), b"existing")

    def test_custom_ports_and_explicit_selected_save(self):
        self.env.update(PORT="34200", RCON_PORT="27020", LOAD_LATEST_SAVE="false", SAVE_NAME="My world", BIND="127.0.0.1", CONSOLE_LOG_LOCATION="/factorio/server.log")
        args, creation, _ = self.prepare()
        self.assertEqual(args[args.index("--port") + 1], "34200")
        self.assertEqual(args[args.index("--rcon-port") + 1], "27020")
        self.assertEqual(args[args.index("--bind") + 1], "127.0.0.1")
        self.assertEqual(args[args.index("--console-log") + 1], "/factorio/server.log")
        self.assertTrue(args[-1].endswith("My world.zip"))
        self.assertIsNotNone(creation)

    def test_symlinks_and_traversal_do_not_overwrite_external_data(self):
        self.data.mkdir()
        external = self.root / "outside"
        external.mkdir()
        (self.data / "config").symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            self.prepare()
        self.assertEqual(list(external.iterdir()), [])
        (self.data / "config").unlink()
        self.env["SAVE_NAME"] = "../outside"
        with self.assertRaisesRegex(ValueError, "filename"):
            self.prepare()

    def test_mod_auto_updates_are_explicitly_refused_without_changing_files(self):
        self.env["UPDATE_MODS_ON_START"] = "true"
        with self.assertRaisesRegex(ValueError, "unsupported"):
            self.prepare()
        self.assertFalse(self.data.exists())


class OwnershipTests(unittest.TestCase):
    def test_overlapping_trees_and_external_config_paths_are_visited_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, external = root / "data", root / "external-mods"
            nested = data / "mods/unpacked-mod"
            nested.mkdir(parents=True)
            external.mkdir()
            (nested / "control.lua").write_text("preserve")
            (external / "mod.zip").write_bytes(b"preserve")
            paths = [nested, external, data / "mods", data]
            entries = list(startup.ownership_entries(paths))
            self.assertEqual(len(entries), len(set(entries)))
            self.assertEqual(set(entries), {data, data / "mods", nested,
                                           nested / "control.lua", external, external / "mod.zip"})
            with patch.object(startup.os, "chown") as change:
                startup.ensure_ownership(paths, data.stat().st_uid, data.stat().st_gid)
                change.assert_not_called()
                startup.ensure_ownership(paths, 123456, 123456)
                self.assertEqual(change.call_count, len(entries))
                self.assertTrue(all(call.kwargs == {"follow_symlinks": False}
                                    for call in change.call_args_list))
            self.assertEqual((nested / "control.lua").read_text(), "preserve")

    def test_directory_links_are_processed_without_following_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, external = root / "data", root / "outside"
            data.mkdir()
            (external / "nested").mkdir(parents=True)
            (external / "nested/keep").write_bytes(b"preserve")
            link = data / "linked"
            link.symlink_to(external, target_is_directory=True)
            (data / "broken").symlink_to(root / "missing")
            self.assertEqual(set(startup.ownership_entries([data])),
                             {data, link, data / "broken"})
            # A separately configured directory beneath a link must still be
            # visited: the parent walk deliberately never followed that link.
            entries = list(startup.ownership_entries([data, link / "nested"]))
            self.assertEqual(len(entries), len(set(entries)))
            self.assertIn(link / "nested/keep", entries)
            self.assertEqual((external / "nested/keep").read_bytes(), b"preserve")


class FakeSocket:
    def __init__(self, data):
        self.data, self.sent = bytearray(data), []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def settimeout(self, value):
        pass

    def sendall(self, data):
        self.sent.append(data)

    def recv(self, size):
        count = min(size, 3)  # Deliberately fragment headers and UTF-8 responses.
        data = bytes(self.data[:count])
        del self.data[:count]
        return data


class RconTests(unittest.TestCase):
    def test_authentication_and_multipart_unicode_response(self):
        sock = FakeSocket(rcon.packet(1, 0, "") + rcon.packet(1, 2, "") +
                          rcon.packet(2, 0, "Hello ") + rcon.packet(2, 0, "工程師") + rcon.packet(3, 0, "Version: 2.0.77"))
        with patch.object(rcon.socket, "create_connection", return_value=sock):
            self.assertEqual(rcon.execute("/players", "secret"), "Hello 工程師")
        self.assertEqual(sock.sent[0], rcon.packet(1, 3, "secret"))
        self.assertEqual(sock.sent[1], rcon.packet(2, 2, "/players") + rcon.packet(3, 2, "/version"))

    def test_authentication_rejection_does_not_send_a_command(self):
        sock = FakeSocket(rcon.packet(-1, 2, ""))
        with patch.object(rcon.socket, "create_connection", return_value=sock):
            with self.assertRaisesRegex(ValueError, "Authentication"):
                rcon.execute("/players", "secret")
        self.assertEqual(len(sock.sent), 1)

    def test_empty_response_and_invalid_packets(self):
        sock = FakeSocket(rcon.packet(1, 2, "") + rcon.packet(2, 0, "") + rcon.packet(3, 0, "Version"))
        with patch.object(rcon.socket, "create_connection", return_value=sock):
            self.assertEqual(rcon.execute("/silent-command", "secret"), "")
        for size in (-1, 0, rcon.LIMIT + 1):
            with self.assertRaises(ValueError):
                rcon.receive(FakeSocket(struct.pack("<i", size)))
        with self.assertRaises(ConnectionError):
            rcon.receive(FakeSocket(b"\x01"))
        with self.assertRaises(ValueError):
            rcon.packet(2, 2, "invalid\0command")


if __name__ == "__main__":
    unittest.main()
