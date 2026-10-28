#!/bin/sh
set -eu
# Public downloads are pinned to an explicit release; local invocation keeps its historical behavior.
goblin_bootstrap() (
  set -eu
  if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then
    printf '%s\n' 'Lobby Goblin public installer' 'Usage: bash -s -- --version VERSION [--host-agent] [Install.sh options]' 'Use the release version shown by your panel. Source is downloaded from that GitHub tag.' 'Example: --version 0.3.14-alpha --host-agent --start --host host.example.com --address host.example.com --memory 16'
    exit 0
  fi
  [ "${1:-}" = --version ] && [ "$#" -ge 2 ] || { printf '%s\n' 'Specify --version VERSION matching your panel, followed by the installation options.' >&2; exit 1; }
  bootstrap_version=${2#v}; shift 2
  printf '%s\n' "$bootstrap_version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$' || { printf '%s\n' 'Invalid release version.' >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { printf '%s\n' 'Install tar before running the public installer.' >&2; exit 1; }
  umask 077
  bootstrap_tmp=$(mktemp -d "${TMPDIR:-/tmp}/lobby-goblin-install.XXXXXXXX")
  bootstrap_tmp=$(CDPATH= cd -- "$bootstrap_tmp" && pwd -P)
  trap 'rm -rf -- "$bootstrap_tmp"' 0
  trap 'exit 130' INT
  trap 'exit 143' HUP TERM
  bootstrap_url="https://github.com/jkenneydaniel/lobby-goblin/archive/refs/tags/v$bootstrap_version.tar.gz"
  printf 'Downloading Lobby Goblin %s source from GitHub…\n' "$bootstrap_version"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --output "$bootstrap_tmp/source.tar.gz" "$bootstrap_url"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --https-only --timeout=30 --tries=2 --output-document="$bootstrap_tmp/source.tar.gz" "$bootstrap_url"
  else
    printf '%s\n' 'Install curl or wget before running the public installer.' >&2; exit 1
  fi
  tar -tzf "$bootstrap_tmp/source.tar.gz" > "$bootstrap_tmp/paths"
  bootstrap_root=$(sed -n '1s,/.*,,p' "$bootstrap_tmp/paths")
  case "$bootstrap_root" in lobby-goblin-*) ;; *) printf '%s\n' 'Unexpected GitHub source archive.' >&2; exit 1 ;; esac
  # Reject links/special files and path escapes before extraction. Only regular
  # files/directories from one archive root enter this private temporary folder.
  tar -tvzf "$bootstrap_tmp/source.tar.gz" | LC_ALL=C awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}' || { printf '%s\n' 'Source archive contains unsupported file types.' >&2; exit 1; }
  LC_ALL=C awk -v root="$bootstrap_root" 'index($0, root "/")!=1 || /\\/ {exit 1} {n=split($0,p,"/"); for(i=1;i<=n;i++)if(p[i]=="..")exit 1}' "$bootstrap_tmp/paths" || { printf '%s\n' 'Unsafe path in source archive.' >&2; exit 1; }
  mkdir "$bootstrap_tmp/source"
  tar -xzf "$bootstrap_tmp/source.tar.gz" --no-same-owner --no-same-permissions --strip-components=1 -C "$bootstrap_tmp/source"
  bootstrap_package="$bootstrap_tmp/source/panel/package.json"
  [ -f "$bootstrap_package" ] && [ -f "$bootstrap_tmp/source/Install.sh" ] || { printf '%s\n' 'Release source is missing its installer.' >&2; exit 1; }
  bootstrap_actual=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)".*/\1/p' "$bootstrap_package")
  [ "$bootstrap_actual" = "$bootstrap_version" ] || { printf '%s\n' 'Downloaded source version does not match the requested release.' >&2; exit 1; }
  # Restore terminal input for guided setup after the complete piped script was
  # parsed. Explicit noninteractive options also work without a terminal.
  if [ -r /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
    sh "$bootstrap_tmp/source/Install.sh" "$@" </dev/tty
  else
    sh "$bootstrap_tmp/source/Install.sh" "$@"
  fi
)

goblin_local_install() {
source_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
installer_script=install.js
if [ "${1:-}" = --host-agent ]; then installer_script=host-install.js; shift; fi
# sudo is needed for Docker bootstrap, but the resulting files belong to the
# invoking user in both the native Node and temporary-container setup paths.
installer_uid=$(id -u)
installer_gid=$(id -g)
if [ "$installer_uid" -eq 0 ]; then
  installer_uid=${SUDO_UID:-$installer_uid}
  installer_gid=${SUDO_GID:-$installer_gid}
fi
for owner_id in "$installer_uid" "$installer_gid"; do
  case "$owner_id" in ''|*[!0-9]*) printf '%s\n' 'Invalid installer ownership ID.' >&2; exit 1 ;; esac
  [ "${#owner_id}" -le 9 ] || { printf '%s\n' 'Invalid installer ownership ID.' >&2; exit 1; }
done
export GOBLIN_INSTALL_UID="$installer_uid" GOBLIN_INSTALL_GID="$installer_gid"
if [ "${1:-}" = --install-docker ]; then
  for choice do
    case "$choice" in --check|--help|-h) printf '%s\n' 'Do not combine --install-docker with --check or --help. Inspect prerequisites separately before installing.' >&2; exit 1 ;; esac
  done
  shift
  docker_installer="$source_root/scripts/install/Install-Docker.sh"
  [ -f "$docker_installer" ] || docker_installer="$source_root/Install-Docker.sh"
  sh "$docker_installer" --install
fi
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  exec node "$source_root/panel/$installer_script" "$@"
fi
if [ "${1:-}" = --help ]; then
  printf '%s\n' 'Lobby Goblin installer: run without arguments for guided setup.' '--prepare / --start / --check; --mode local|hosted; --domain HOST; --address HOST; --memory GiB; --directory PATH' 'Linux: --install-docker as the first option explicitly installs missing Docker on supported Ubuntu hosts.' 'Use --host-agent first for game-host setup; see docs/REMOTE_HOSTS.md. Node 22+ is optional when Docker is installed.'
  exit 0
fi
command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Install Docker Desktop (Mac) or Docker Engine (Linux), or run sudo sh Install.sh --install-docker on a fresh supported Ubuntu server.' >&2; exit 1; }
endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
case "$endpoint" in unix://*) ;; *) printf '%s\n' 'Run installation on the target machine with a local Docker context.' >&2; exit 1 ;; esac
# --check must not create even a temporary setup container.
if [ "${1:-}" = --check ]; then
  [ "$#" -eq 1 ] || { printf '%s\n' 'Install Node 22+ to check installation files with --directory.' >&2; exit 1; }
  details=$(docker info --format '{{.OSType}}|{{.Architecture}}|{{.ServerVersion}}|{{json .SecurityOptions}}')
  case "$details" in linux\|amd64\|*|linux\|x86_64\|*) ;; *) printf '%s\n' 'The host manager needs Linux x86-64 containers.' >&2; exit 1 ;; esac
  case "$details" in *rootless*) printf '%s\n' 'Rootless Docker is unsupported by this controller layout.' >&2; exit 1 ;; esac
  engine=$(printf '%s' "$details" | cut -d '|' -f 3)
  [ "${engine%%.*}" -ge 26 ] || { printf '%s\n' 'Docker Engine 26+ is required.' >&2; exit 1; }
  compose=$(docker compose version --short)
  printf '%s\n' "$compose" | awk -F. '{sub(/^v/, "", $1); exit !(($1>2)||($1==2&&$2>=24))}' || { printf '%s\n' 'Compose 2.24+ is required.' >&2; exit 1; }
  printf 'Docker %s, Compose %s. No files changed or containers started.\n' "$engine" "$compose"
  exit 0
fi
# Docker supplies the installer runtime when Node is absent. The host CLI owns
# the connection; do not forward arbitrary remote contexts into this helper.
work_root=$(pwd -P)
case "$source_root$work_root" in *,*) printf '%s\n' 'Use a directory without commas, or install Node 22+ to run the installer directly.' >&2; exit 1 ;; esac
directory_next=no
for choice do
  if [ "$directory_next" = yes ]; then
    case "/$choice/" in */../*) printf '%s\n' 'Docker-based setup needs a destination inside your current directory. Use Node 22+ for other paths.' >&2; exit 1 ;; esac
    case "$choice" in /*) case "$choice" in "$work_root"/*) ;; *) printf '%s\n' 'Docker-based setup needs a destination inside your current directory. Use Node 22+ for other paths.' >&2; exit 1 ;; esac ;; esac
    directory_next=no
  fi
  [ "$choice" != --directory ] || directory_next=yes
done
runtime_version=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)".*/\1/p' "$source_root/panel/package.json")
set -- --rm --user 0:0 --env "GOBLIN_INSTALL_UID=$GOBLIN_INSTALL_UID" --env "GOBLIN_INSTALL_GID=$GOBLIN_INSTALL_GID" --mount "type=bind,source=$source_root,target=/installer,readonly" --mount "type=bind,source=$work_root,target=$work_root" --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock --workdir "$work_root" --entrypoint node "ghcr.io/jkenneydaniel/lobby-goblin:$runtime_version" "/installer/panel/$installer_script" "$@"
if [ -t 0 ]; then set -- -it "$@"; fi
exec docker run "$@"

}

goblin_install_entry() {
  if [ "${1:-}" = --version ]; then goblin_bootstrap "$@"; return; fi
  case "$0" in bash|sh|-bash|-sh|*/bash|*/sh|dash|zsh)
    if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then goblin_bootstrap --help; return; fi
    printf '%s\n' 'For a piped public installer, specify --version VERSION matching your panel.' >&2; return 1 ;;
  esac
  goblin_local_install "$@"
}
goblin_install_entry "$@"
