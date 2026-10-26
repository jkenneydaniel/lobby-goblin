"""Lobby Goblin startup; preserve existing files and exec the game as PID 1."""
import json
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import subprocess
import sys


def enabled(env, key, default=False):
    value = env.get(key, "true" if default else "false").lower()
    if value not in ("true", "false"):
        raise ValueError(key + " must be true or false")
    return value == "true"


def create_once(file, data):
    try:
        with file.open("x") as stream:
            stream.write(data)
        file.chmod(0o600)
    except FileExistsError:
        if file.is_symlink() or not file.is_file():
            raise ValueError("Configuration must use ordinary files")


def prepare(env, data=Path("/factorio"), game=Path("/opt/factorio")):
    if enabled(env, "UPDATE_MODS_ON_START"):
        raise ValueError("Automatic mod updates are unsupported; set UPDATE_MODS_ON_START=false")
    paths = {key: Path(env.get(key, str(data / folder))) for key, folder in (
        ("SAVES", "saves"), ("CONFIG", "config"), ("MODS", "mods"),
        ("SCENARIOS", "scenarios"), ("SCRIPTOUTPUT", "script-output"))}
    for directory in (data, *paths.values()):
        if directory.is_symlink():
            raise ValueError("Data directories must not be symlinks")
        directory.mkdir(parents=True, exist_ok=True)
    config, saves, mods = paths["CONFIG"], paths["SAVES"], paths["MODS"]
    existing = [file for file in saves.glob("*.zip") if file.is_file() and not file.name.endswith(".tmp.zip")]
    identity = (config / "server-id.json").exists()
    previous = (config / "rconpw").exists() or identity
    pending = config / ".initial-world-pending"
    if pending.is_symlink() or pending.exists() and not pending.is_file():
        raise ValueError("Invalid first-world generation marker")
    generate = enabled(env, "GENERATE_NEW_SAVE")
    if not existing and previous and not generate and not (pending.exists() and not identity):
        raise ValueError("Existing server identity has no saves. Restore its data; no replacement world was generated")
    # Record fresh-install intent before creating the RCON identity. A restart
    # can retry only this first world; established identities remain protected.
    if not existing and not previous:
        create_once(pending, "")
    if existing:
        pending.unlink(missing_ok=True)
    for name in ("server-settings", "map-gen-settings", "map-settings"):
        target = config / (name + ".json")
        if not target.exists():
            create_once(target, (game / "data" / (name + ".example.json")).read_text())
        elif target.is_symlink() or not target.is_file():
            raise ValueError("Configuration must use ordinary files")
    for name in ("server-adminlist", "server-banlist", "server-whitelist"):
        create_once(config / (name + ".json"), "[]\n")
    create_once(config / "rconpw", secrets.token_hex(32))
    password = (config / "rconpw").read_text().strip()
    if not password or "\n" in password or "\x00" in password:
        raise ValueError("The existing RCON password is invalid; it was not replaced")
    # Existing mod selections, including DLC choices, remain byte-for-byte intact.
    dlc = enabled(env, "DLC_SPACE_AGE", True)
    create_once(mods / "mod-list.json", json.dumps({"mods": [
        {"name": name, "enabled": name == "base" or dlc}
        for name in ("base", "quality", "elevated-rails", "space-age")
    ]}, indent=2) + "\n")
    binary = str(game / "bin/x64/factorio")
    common = ["--config", str(game / "config/config.ini"), "--mod-directory", str(mods)]
    creation = None
    if generate or not existing:
        name = env.get("SAVE_NAME", "World")
        if not name or name in (".", "..") or any(char in name for char in "/\\\n\r\x00"):
            raise ValueError("SAVE_NAME must be a filename")
        destination = saves / (name if name.endswith(".zip") else name + ".zip")
        if destination.is_symlink():
            raise ValueError("Save destination must not be a symlink")
        if not destination.exists():
            # Never expose scratch output to load-latest or the panel's world
            # list, including after a kill between generation and publication.
            workspace = config / ".lobby-goblin-generation"
            if workspace.is_symlink() or workspace.exists() and not workspace.is_dir():
                raise ValueError("Generation workspace must use an ordinary directory")
            workspace.mkdir(mode=0o700, exist_ok=True)
            temporary = workspace / (destination.stem + ".tmp.zip")
            if temporary.is_symlink() or temporary.exists() and not temporary.is_file():
                raise ValueError("Temporary save must use an ordinary file")
            creation = [binary, *common, "--create", str(temporary), "--map-gen-settings", str(config / "map-gen-settings.json"), "--map-settings", str(config / "map-settings.json")]
            if env.get("PRESET"):
                creation.extend(["--preset", env["PRESET"]])
    args = [binary, *common, "--port", str(int(env.get("PORT", "34197"))),
            "--rcon-port", str(int(env.get("RCON_PORT", "27015"))), "--rcon-password", password,
            "--server-settings", str(config / "server-settings.json"),
            "--server-adminlist", str(config / "server-adminlist.json"),
            "--server-banlist", str(config / "server-banlist.json"),
            "--server-whitelist", str(config / "server-whitelist.json"),
            "--server-id", str(config / "server-id.json")]
    # Match the existing wrapper's enabled-whitelist startup behavior.
    args.append("--use-server-whitelist" if enabled(env, "USE_SERVER_WHITELIST", True) else "--use-server-whitelist=false")
    for key, option in (("BIND", "--bind"), ("CONSOLE_LOG_LOCATION", "--console-log")):
        if env.get(key):
            args.extend([option, env[key]])
    if enabled(env, "LOAD_LATEST_SAVE", True):
        args.append("--start-server-load-latest")
    else:
        name = env.get("SAVE_NAME", "World")
        if not name or name in (".", "..") or any(char in name for char in "/\\\n\r\x00"):
            raise ValueError("SAVE_NAME must be a filename")
        selected = saves / (name if name.endswith(".zip") else name + ".zip")
        if not selected.is_file() and not creation:
            raise ValueError("Selected save is missing; no replacement world was generated")
        args.extend(["--start-server", str(selected)])
    return args, creation, paths


def generate_save(creation, paths):
    temporary = Path(creation[creation.index("--create") + 1])
    destination = paths["SAVES"] / (temporary.name[:-len(".tmp.zip")] + ".zip")
    # A failed/killed generator leaves only an ignored temporary save. Retry it
    # with the same configuration and password, never load its partial output.
    if temporary.is_symlink() or temporary.exists() and not temporary.is_file():
        raise ValueError("Temporary save must use an ordinary file")
    temporary.unlink(missing_ok=True)
    subprocess.run(creation, check=True)
    if temporary.is_symlink() or not temporary.is_file():
        raise ValueError("Generated save must use an ordinary file")
    # CONFIG and SAVES may be on different filesystems. Stream into a private
    # non-ZIP staging file on the destination filesystem, then publish atomically
    # without overwriting a save that appeared during generation. A kill during
    # the copy cannot leave a discoverable world in SAVES.
    staged = None
    try:
        with tempfile.NamedTemporaryFile(dir=paths["SAVES"], prefix=".lobby-goblin-", suffix=".pending", delete=False) as output:
            staged = Path(output.name)
            with temporary.open("rb") as source:
                shutil.copyfileobj(source, output)
        os.link(staged, destination, follow_symlinks=False)
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
    (paths["CONFIG"] / ".initial-world-pending").unlink(missing_ok=True)


def ownership_entries(paths):
    """Visit overlapping roots once; do not follow links encountered inside them."""
    visited = set()
    roots = {Path(os.path.abspath(directory)) for directory in paths}
    for directory in sorted(roots, key=lambda item: (len(item.parts), str(item))):
        if directory in visited:
            continue
        for parent, directories, files in os.walk(directory, followlinks=False):
            parent = Path(parent)
            if parent in visited:
                directories.clear()
                continue
            visited.add(parent)
            yield parent
            for name in files:
                yield parent / name
            # Ordinary directories are visited as parents on the next walk step.
            for name in directories:
                link = parent / name
                if link.is_symlink():
                    yield link


def ensure_ownership(paths, uid, gid):
    for file in ownership_entries(paths):
        info = file.lstat()
        if (info.st_uid, info.st_gid) != (uid, gid):
            os.chown(file, uid, gid, follow_symlinks=False)


def main():
    runtime = enabled(os.environ, "FACTORIO_RUNTIME") and not enabled(os.environ, "FACTORIO_RUNTIME_HELPER")
    game = Path("/opt/factorio")
    if runtime:
        from runtime import boot
        game, runtime_lock = boot(Path("/factorio"), os.getenv("FACTORIO_VERSION", "stable"))
    args, creation, paths = prepare(os.environ, game=game)
    uid, gid = int(os.getenv("PUID", "845")), int(os.getenv("PGID", "845"))
    if uid <= 0 or gid <= 0:
        raise ValueError("PUID and PGID must be positive")
    if os.geteuid() == 0:
        # Change only mismatched ownership, never file contents or permissions.
        if runtime:
            os.chown("/factorio", uid, gid)
            ensure_ownership(paths.values(), uid, gid)
        else:
            ensure_ownership([Path("/factorio"), *paths.values()], uid, gid)
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    if creation:
        generate_save(creation, paths)
    os.execv(args[0], args + sys.argv[1:])


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError):
        # Never print the generated command: it includes the RCON password.
        print("Factorio startup refused. Check data mounts, existing saves, configuration and permissions. Existing files were preserved.", file=sys.stderr)
        sys.exit(1)
