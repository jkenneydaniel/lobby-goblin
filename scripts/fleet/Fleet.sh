#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root="$script_dir"
if [ "$(basename "$(dirname "$script_dir")")" = scripts ] && [ -f "$script_dir/../../panel/package.json" ] && [ -f "$script_dir/../../compose.yaml" ]; then
  root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
fi
config="$root/.env.fleet"
compose_file="$root/deploy/fleet/compose.yaml"
[ -f "$compose_file" ] || compose_file="$root/fleet.compose.yaml"
address=${FLEET_ADDRESS:-localhost}
case "$address" in ''|*[!A-Za-z0-9.-]*) echo 'Use an IPv4 address or local hostname.' >&2; exit 1;; esac
command -v docker >/dev/null || { echo 'Start Docker with Linux containers first.' >&2; exit 1; }
host_type=$(docker info --format '{{.OSType}}/{{.Architecture}}/{{.ServerVersion}}')
case "$host_type" in linux/x86_64/*|linux/amd64/*) ;; *) echo 'The host manager requires Linux amd64 containers.' >&2; exit 1;; esac
version=${host_type##*/}
[ "${version%%.*}" -ge 26 ] || { echo 'Docker Engine 26+ is required.' >&2; exit 1; }
if [ ! -f "$config" ]; then
 id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
 umask 077
 cat > "$config" <<EOF
FLEET_ID=$id
FLEET_IMAGE=ghcr.io/jkenneydaniel/lobby-goblin:0.3.19-alpha
FLEET_ADDRESS=$address
FLEET_PANEL_PORT=${FLEET_PANEL_PORT:-8082}
FLEET_PANEL_BIND=0.0.0.0
FLEET_GAME_BIND=0.0.0.0
FLEET_GAME_PORT_BASE=35000
FLEET_MEMORY_GIB=${FLEET_MEMORY_GIB:-16}
EOF
fi
id=$(sed -n 's/^FLEET_ID=\([a-f0-9]\{32\}\)$/\1/p' "$config")
[ ${#id} -eq 32 ] || { echo 'Invalid FLEET_ID in .env.fleet.' >&2; exit 1; }
if [ "${1:-}" = '--build-only' ]; then
 docker compose --project-directory "$root" --env-file "$config" -f "$compose_file" -p "lobby-goblin-fleet-$id" build fleet-controller
 exit 0
fi
# Enrolled updates keep their private records inside Docker on every host OS.
# Read only public startup selection; never bind a native host folder to a helper.
volume="lobby-goblin-fleet-$id-management-updates"
listed=$(docker volume ls --filter "name=^$volume$" --format '{{.Name}}')
set --
if [ -n "$listed" ]; then
 [ "$listed" = "$volume" ] || { echo 'Ambiguous management recovery storage.' >&2; exit 1; }
 engine=$(docker info --format '{{.ID}}')
 case "$engine" in ''|*[!A-Za-z0-9:_-]*) echo 'Invalid Docker engine identity.' >&2; exit 1;; esac
 identity=$(docker volume inspect --format '{{.Driver}}|{{json .Options}}|{{index .Labels "io.lobby-goblin.fleet"}}|{{index .Labels "io.lobby-goblin.role"}}|{{index .Labels "io.lobby-goblin.engine"}}' "$volume")
 case "$identity" in "local|null|$id|management-update-ledger|$engine"|"local|{}|$id|management-update-ledger|$engine") ;; *) echo 'Management recovery storage changed.' >&2; exit 1;; esac
 anchor="lobby-goblin-management-lock-$id"
 identity=$(docker inspect --format '{{.State.Status}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{len .Mounts}}|{{index .Config.Labels "io.lobby-goblin.fleet"}}|{{index .Config.Labels "io.lobby-goblin.role"}}|{{index .Config.Labels "io.lobby-goblin.engine"}}' "$anchor")
 [ "$identity" = "created|none|true|0|$id|management-update-anchor|$engine" ] || { echo 'Management enrollment changed.' >&2; exit 1; }
 reader=$(docker inspect --format '{{.Image}}' "$anchor")
 [ "${#reader}" -eq 71 ] && case "$reader" in sha256:*[!a-f0-9:]*) false;; sha256:*) true;; *) false;; esac || { echo 'Invalid management reader image.' >&2; exit 1; }
 profile=legacy
 if grep -q 'MODE: docker-broker' "$compose_file"; then profile=brokered; fi
 request="{\"action\":\"runtime\",\"fleet\":\"$id\",\"engine\":\"$engine\",\"output\":\"compose\",\"profile\":\"$profile\"}"
 task_runtime_overlay=$(mktemp)
 trap 'rm -f "$task_runtime_overlay"' EXIT HUP INT TERM
 docker run --rm --network none --user 0:0 --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 256m --pids-limit 64 --mount "type=volume,source=$volume,target=/management,readonly,volume-nocopy" --env "MANAGEMENT_REQUEST=$request" --entrypoint node "$reader" /app/management-volume-worker.js > "$task_runtime_overlay"
 set -- -f "$task_runtime_overlay"
fi
if [ -z "$listed" ]; then
if sed -n '/^FLEET_IMAGE=local\/lobby-goblin-host:/p' "$config" | grep -q .; then
 task_fleet_tmp=$(mktemp "$config.XXXXXX")
 sed 's|^FLEET_IMAGE=local/lobby-goblin-host:.*|FLEET_IMAGE=ghcr.io/jkenneydaniel/lobby-goblin:0.3.19-alpha|' "$config" > "$task_fleet_tmp"
 mv "$task_fleet_tmp" "$config"
fi
fi
docker compose --project-directory "$root" --env-file "$config" -f "$compose_file" "$@" -p "lobby-goblin-fleet-$id" pull fleet-controller fleet-web
docker compose --project-directory "$root" --env-file "$config" -f "$compose_file" "$@" -p "lobby-goblin-fleet-$id" up -d --no-build
printf '%s\n' 'Host manager started. Register with this private one-time invitation:'
docker compose --project-directory "$root" --env-file "$config" -f "$compose_file" "$@" -p "lobby-goblin-fleet-$id" exec -T fleet-controller cat /web-state/registration-link.txt
