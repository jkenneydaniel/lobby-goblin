"""Verified, persistent Wube headless releases. Never updates on an ordinary restart."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

VERSION = re.compile(r"2\.\d{1,3}\.\d{1,4}\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
PROVIDER = "factorio-headless"
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_TREE = 2 * 1024 * 1024 * 1024


def ordinary(file, directory=False):
    if file.is_symlink() or not (file.is_dir() if directory else file.is_file()):
        raise ValueError("Runtime storage must contain ordinary files and directories")


def read_json(file):
    ordinary(file)
    if file.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Oversized runtime metadata")
    return json.loads(file.read_text())


def atomic_json(file, value):
    if file.exists() or file.is_symlink():
        ordinary(file)
    with tempfile.NamedTemporaryFile(dir=file.parent, prefix=".receipt-", delete=False) as stream:
        pending = Path(stream.name)
        try:
            stream.write((json.dumps(value, sort_keys=True) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            pending.unlink(missing_ok=True)
            raise
    os.replace(pending, file)
    fd = os.open(file.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class HTTPSRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        host = urllib.parse.urlsplit(url)
        if host.scheme != "https" or host.username or host.password or not (
                host.hostname == "factorio.com" or host.hostname.endswith(".factorio.com")):
            raise ValueError("Download redirected outside Wube HTTPS storage")
        return super().redirect_request(request, fp, code, message, headers, url)


def fetch(url, output, limit):
    opener = urllib.request.build_opener(HTTPSRedirects())
    with opener.open(urllib.request.Request(url, headers={"User-Agent": "LobbyGoblin/1"}), timeout=60) as response:
        if response.status != 200:
            raise ValueError("Official release download failed")
        total = 0
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > limit:
                raise ValueError("Official release exceeds download limit")
            output.write(block)


def official_text(url):
    import io
    output = io.BytesIO()
    fetch(url, output, 2 * 1024 * 1024)
    return output.getvalue().decode("utf-8")


def selection(version):
    if version in ("stable", "experimental"):
        version = json.loads(official_text("https://factorio.com/api/latest-releases"))[version]["headless"]
    if not VERSION.fullmatch(version):
        raise ValueError("Choose an exact Factorio 2.x release or a first-install channel")
    name = "factorio-headless_linux_" + version + ".tar.xz"
    matches = [line.split()[0] for line in official_text("https://factorio.com/download/sha256sums/").splitlines()
               if len(line.split()) == 2 and line.split()[1] == name]
    if len(matches) != 1 or not SHA.fullmatch(matches[0]):
        raise ValueError("Official headless checksum is unavailable")
    return {"version": 1, "provider": PROVIDER, "softwareVersion": version, "sha256": matches[0]}


def checked(value):
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("provider") != PROVIDER or not VERSION.fullmatch(value.get("softwareVersion", "")) or not SHA.fullmatch(value.get("sha256", "")):
        raise ValueError("Invalid Factorio release receipt")
    return value


def release_key(value):
    checked(value)
    return value["softwareVersion"] + "-" + value["sha256"]


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(root):
    files = []
    total = 0
    for parent, directories, names in os.walk(root, followlinks=False):
        for name in directories:
            ordinary(Path(parent) / name, True)
        for name in sorted(names):
            file = Path(parent) / name
            ordinary(file)
            info = file.stat()
            if info.st_nlink != 1:
                raise ValueError("Hard-linked runtime file")
            total += info.st_size
            if total > MAX_TREE or len(files) >= 20000:
                raise ValueError("Oversized installed release")
            files.append({"name": file.relative_to(root).as_posix(), "size": info.st_size, "sha256": digest(file)})
    return sorted(files, key=lambda entry: entry["name"])


def verify(root, receipt):
    checked(receipt)
    ordinary(root, True)
    if inventory(root) != receipt.get("files"):
        raise ValueError("Installed release no longer matches its verified receipt")
    return root


def extract(archive, root):
    # Do not delegate path/link interpretation to tar's extraction machinery.
    total, seen = 0, set()
    with tarfile.open(archive, "r:xz") as package:
        for member in package:
            parts = member.name.rstrip("/").split("/")
            if not parts or parts[0] != "factorio" or any(part in ("", ".", "..") for part in parts) or "\\" in member.name or not (member.isdir() or member.isfile()):
                raise ValueError("Unsafe official release archive")
            relative = "/".join(parts[1:])
            if not relative:
                if not member.isdir():
                    raise ValueError("Invalid archive root")
                continue
            if relative in seen or len(seen) >= 20000:
                raise ValueError("Duplicate or excessive archive entries")
            seen.add(relative)
            target = root.joinpath(*parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                total += member.size
                if total > MAX_TREE:
                    raise ValueError("Oversized official release archive")
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if relative == "bin/x64/factorio" else 0o644)


def install(root, wanted, downloader=fetch, probe=None):
    checked(wanted)
    releases = root / "releases"
    releases.mkdir(exist_ok=True)
    ordinary(releases, True)
    destination = releases / release_key(wanted)
    metadata = releases / (release_key(wanted) + ".json")
    if destination.exists() or destination.is_symlink():
        receipt = checked(read_json(metadata))
        if release_key(receipt) != release_key(wanted):
            raise ValueError("Stored release identity differs")
        # The cached inventory describes immutable bytes, while operation and
        # previous belong to this activation, including crash-replay detection.
        return verify(destination, receipt), {**wanted, "files": receipt["files"]}
    with tempfile.TemporaryDirectory(dir=root, prefix=".install-") as scratch:
        archive = Path(scratch) / "release.tar.xz"
        with archive.open("xb") as output:
            downloader("https://factorio.com/get-download/" + wanted["softwareVersion"] + "/headless/linux64", output, MAX_ARCHIVE)
        if digest(archive) != wanted["sha256"]:
            raise ValueError("Official release checksum mismatch")
        staged = Path(scratch) / "game"
        staged.mkdir()
        extract(archive, staged)
        binary = staged / "bin/x64/factorio"
        ordinary(binary)
        output = probe(binary) if probe else subprocess.check_output([str(binary), "--version"], text=True, timeout=30)
        if not re.search(r"^Version: " + re.escape(wanted["softwareVersion"]) + r"(?:\s|$)", output, re.MULTILINE):
            raise ValueError("Downloaded binary reports a different release")
        # The release itself stays immutable. All writable game paths use /factorio.
        (staged / "config").mkdir(exist_ok=True)
        (staged / "config/config.ini").write_text("[path]\nread-data=__PATH__executable__/../../data\nwrite-data=/factorio\n[other]\ncheck-updates=false\n")
        receipt = {**wanted, "files": inventory(staged)}
        atomic_json(metadata, receipt)
        os.rename(staged, destination)
        return destination, receipt


def boot(data, initial="stable", downloader=fetch, resolver=selection, probe=None):
    ordinary(data, True)
    root = data / "runtime"
    root.mkdir(exist_ok=True)
    ordinary(root, True)
    lock_file = root / ".lock"
    fd = os.open(lock_file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Keep this descriptor open across exec so offline installers cannot race the game.
        os.set_inheritable(fd, True)
        # A SIGKILL during download/extraction cannot run TemporaryDirectory's
        # cleanup. The exclusive runtime lock makes these reserved staging
        # directories safe to retire before a deliberate retry or normal boot.
        for staged in root.glob(".install-*"):
            ordinary(staged, True)
            shutil.rmtree(staged)
        active = root / "installed.json"
        receipt = checked(read_json(active)) if active.exists() or active.is_symlink() else None
        request = root / "request.json"
        if request.exists() or request.is_symlink():
            wanted = checked(read_json(request))
            if not re.fullmatch(r"[a-f0-9-]{36}", wanted.get("operation", "")):
                raise ValueError("Invalid runtime update operation")
            if receipt and receipt.get("operation") == wanted["operation"] and release_key(receipt) == release_key(wanted):
                request.unlink()
            else:
                if not receipt or wanted.get("previous") != release_key(receipt):
                    raise ValueError("Runtime selection changed after review")
                game, receipt = install(root, wanted, downloader, probe)
                atomic_json(active, receipt)
                request.unlink()
        elif receipt is None:
            # Existing worlds require an explicit version; never guess an upgrade.
            existing = any((data / "saves").glob("*.zip")) or (data / "config/server-id.json").exists() or (data / "config/rconpw").exists()
            bootstrap = root / "bootstrap.json"
            if bootstrap.exists() or bootstrap.is_symlink():
                wanted = checked(read_json(bootstrap))
            else:
                if existing:
                    raise ValueError("Existing worlds need an explicit verified runtime bootstrap receipt")
                wanted = resolver(initial)
            game, receipt = install(root, wanted, downloader, probe)
            atomic_json(active, receipt)
        game = verify(root / "releases" / release_key(receipt), receipt)
        return game, fd
    except BaseException:
        os.close(fd)
        raise
