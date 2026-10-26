#!/usr/bin/env python3
"""Small stdlib-only Source RCON client; compatible with `rcon '<command>'`."""
import os
from pathlib import Path
import socket
import struct
import sys

LIMIT = 8 * 1024 * 1024


def packet(identifier, kind, text):
    body = text.encode("utf-8")
    if b"\0" in body or len(body) > LIMIT:
        raise ValueError("Invalid command")
    return struct.pack("<iii", len(body) + 10, identifier, kind) + body + b"\0\0"


def read_exact(sock, length):
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise ConnectionError("Server closed the connection")
        data.extend(chunk)
    return bytes(data)


def receive(sock):
    size = struct.unpack("<i", read_exact(sock, 4))[0]
    if not 10 <= size <= LIMIT:
        raise ValueError("Invalid packet size")
    data = read_exact(sock, size)
    if data[-2:] != b"\0\0":
        raise ValueError("Invalid packet terminator")
    identifier, kind = struct.unpack("<ii", data[:8])
    return identifier, kind, data[8:-2]


def execute(command, password, host="127.0.0.1", port=27015):
    with socket.create_connection((host, port), timeout=10) as sock:
        sock.settimeout(10)
        sock.sendall(packet(1, 3, password))
        for _ in range(8):
            identifier, kind, _ = receive(sock)
            if identifier == -1:
                raise ValueError("Authentication failed")
            if identifier == 1 and kind == 2:
                break
        else:
            raise ValueError("Authentication response missing")
        # A harmless second command marks the end of a possibly split response.
        sock.sendall(packet(2, 2, command) + packet(3, 2, "/version"))
        chunks, total = [], 0
        for _ in range(4096):
            identifier, kind, body = receive(sock)
            if identifier == 3:
                return b"".join(chunks).decode("utf-8", errors="replace")
            if identifier != 2 or kind != 0:
                raise ValueError("Unexpected command response")
            total += len(body)
            if total > LIMIT:
                raise ValueError("Response too large")
            chunks.append(body)
        raise ValueError("Too many response packets")


if __name__ == "__main__":
    try:
        if len(sys.argv) < 2:
            raise ValueError("A command is required")
        password = (Path(os.getenv("CONFIG", "/factorio/config")) / "rconpw").read_text().strip()
        output = execute(" ".join(sys.argv[1:]), password, port=int(os.getenv("RCON_PORT", "27015")))
        sys.stdout.write(output)
        if output and not output.endswith("\n"):
            sys.stdout.write("\n")
    except (ValueError, OSError, ConnectionError):
        print("RCON command failed. Check server readiness and the existing RCON configuration.", file=sys.stderr)
        sys.exit(1)
