#!/bin/sh
set -eu
exec python3 /usr/local/lib/lobby-goblin/entrypoint.py "$@"
