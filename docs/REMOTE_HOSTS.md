# Connect game hosts

Open **Hosts → Add host** in the multi-game manager. A host is a machine running
your game servers. It needs the Lobby Goblin host agent, Docker and a reachable
agent address on a dedicated TCP port (24443 by default). It does not need
another panel, accounts or SSH for daily use.
Your main panel can run locally or on another machine.

Both methods create a fresh installation. They do not adopt standalone games,
other Docker projects, accounts or worlds. Creating games is a separate action.
This feature requires a matching published runtime that includes host-agent
support; older release images are refused rather than silently reused.

## Set up with SSH

1. Choose an IP address or hostname the panel can reach, including a private
   or VPN address. Allow the panel to reach SSH during setup and the dedicated
   agent port afterwards. Ports 80/443 are not required for the agent.
2. Choose **Set up with SSH**. Enter a display name, SSH address/user and
   password or private key. The agent address defaults to the SSH address.
   Advanced options include the dedicated agent port, SSH port, key passphrase,
   game address, memory budget and passwordless sudo.
3. Review the SSH fingerprint and installation plan. Compare the fingerprint
   with your provider's console or another trusted record before confirming.
4. Choose **Install and connect**. Progress appears under Hosts. Setup installs
   the agent in a new `/opt/lobby-goblin-host-<id>/` directory, obtains a pairing
   code and connects it automatically.

Automatic installation supports x86-64 Linux with root or existing passwordless
sudo access. Do not grant new unattended administrator access just for setup.
Use manual installation when these requirements do not fit your machine.
An optional Docker installation is available for supported fresh Ubuntu
22.04/24.04/26.04 LTS hosts. It uses Docker's official package repository, refuses
conflicting packages/configuration and leaves an existing Docker daemon in place.

The fingerprint is checked before authentication. Login details are sent only
after confirmation, used for that attempt and never saved in plans, job records
or logs. SSH is not used for ongoing game management or agent updates. Failed or
interrupted setup retains its directory and resources for inspection; retrying
does not automatically remove a partial installation.

## Install manually and pair

Copy the matching command from **Hosts → Add host → I have a pairing code →
I need to install the agent**. Run it on the game-host machine. For example:

```sh
curl -fsSL https://raw.githubusercontent.com/jkenneydaniel/lobby-goblin/main/Install.sh | bash -s -- --version 0.3.14-alpha --host-agent --start --host host.example.com --agent-port 24443 --address play.example.com --memory 16
```

Or use wget:

```sh
wget -qO- https://raw.githubusercontent.com/jkenneydaniel/lobby-goblin/main/Install.sh | bash -s -- --version 0.3.14-alpha --host-agent --start --host host.example.com --agent-port 24443 --address play.example.com --memory 16
```

Use your panel's release version. The public script downloads source from that
GitHub tag into a private temporary directory, checks archive paths and the
requested version, and runs the existing installer. Temporary source is removed
when it finishes. It needs curl or wget and tar; Node remains optional when
Docker is available. Docker installation still requires the explicit
`--install-docker` option after `--host-agent` on supported hosts. Run as root,
or use `sudo bash` in the pipe when Docker installation needs administrator access. The command
prints the agent address and one-time pairing code; paste them into your panel.
Replace `--start` with `--prepare` to review generated files before starting.

Existing extracted-release commands remain supported:

Extract a complete matching release on the game host. Install Docker first, then
prepare files without starting anything:

```sh
sh ./Install.sh --host-agent --prepare --host host.example.com --agent-port 24443 --address play.example.com --memory 16 --directory ./lobby-goblin-host
```

Inspect `host.compose.json` and `host-installation.json`, then explicitly start:

```sh
sh ./Install.sh --host-agent --start --directory ./lobby-goblin-host
```

Windows uses the extracted release and `./Install.ps1`; omit the public
bootstrap’s `--version` argument. The launchers accept Node
22+ or use the published Docker runtime when Node is absent. Hosts require Linux
x86-64 containers, Docker Engine 26+, Compose 2.24+ and the selected game budget
plus at least 2 GiB of management headroom. Windows/macOS require compatible
Docker Desktop hardware. `--check` performs read-only Docker checks.

`--host` accepts IPv4, IPv6 or a hostname, including private/VPN addresses.
`--domain` remains an alias. Choose the dedicated port with `--agent-port`
(1024–65535; default 24443). For an IPv6 agent, specify a separate IPv4 address
or hostname with `--address`, because game listeners currently use IPv4. In the
SSH form, an IPv6 agent defaults the game address to the SSH hostname/IPv4;
set **Game address** explicitly if the SSH address is also IPv6.

Both methods create a persistent, encrypted HTTP/2 connection initiated by the
panel. The agent generates its own private certificate identity once and stores
it in its management volume. Its one-time pairing code includes that identity's
SHA-256 certificate fingerprint. The panel verifies the exact fingerprint before
sending the pairing secret or any credentials, and pins it for every reconnect.
A public certificate, DNS name and Let's Encrypt are not required for this agent
connection. Browser access to a hosted panel can still use automatically renewing
[Let's Encrypt HTTPS](INSTALLATION.md#hosted-reachability).

Startup prints the agent address (for example `https://host.example.com:24443`)
and a private **Pairing code** beginning `lg1.`. Copy the entire code using a
trusted channel; it contains both the identity fingerprint and a one-time secret.
In the main panel choose **I have a pairing code**, enter those details and confirm trust.
Codes expire after ten minutes and can be used once. Generate a new code later:

```sh
sh ./Install.sh --host-agent --pairing-code --directory ./lobby-goblin-host
```

Rerunning `--start` leaves existing containers unchanged. Edited manifests or
Compose files require manual review. Keep the installation directory private
and outside version control; the default directory is ignored by this checkout.

An existing full host-manager panel can also share its own registered games:
create a code under **Hosts → Allow another panel to manage this host**. This
requires its configured HTTPS origin. Its accounts remain independent.

## Use and disconnect

The server list combines connected hosts. **Create server** includes a host
selector and names the destination before submission. Each host keeps its own
resource budget, ports, registry, snapshot library and game storage. Snapshot
clones stay on their source host; cross-host snapshot transfer is not included.
Unavailable hosts retain their last known cards with an explicit unavailable
state and disabled changes. One unavailable host does not hide other hosts.

Administrators can pair/disconnect, install/update agents and change games.
Viewers can inspect servers but cannot enroll hosts, view setup records or
perform changes. Pairing grants the main panel access to that host's registered
games and host budget, not account management, other paired hosts or arbitrary
Docker operations. The agent's machine endpoint has no browser sign-in.

**Disconnect** requires the host's exact name and revokes the connection when
reachable. Games and storage stay in place. If offline, remove the entry locally
and revoke access on the host once reachable. For an agent-only installation:

```sh
docker compose -f ./lobby-goblin-host/host.compose.json exec fleet-controller node host-agent-control.js panels
docker compose -f ./lobby-goblin-host/host.compose.json exec fleet-controller node host-agent-control.js revoke PANEL_ID
```

## Keep the agent aligned

Hosts show their agent version beside the main panel version. For an older
agent-only host, **Update agent** reviews the exact panel version and requires
administrator confirmation. Version mismatches block game changes until aligned.
Updates use the agent connection; SSH credentials are not required or retained.
They never run unattended. If an agent is newer, update the main panel first;
downgrades are refused. Full remote panels use their own installation update path.

The update pulls the official versioned runtime, verifies its version label and
pins its registry digest/image ID. A detached helper journals and replaces only
the owned host-controller and agent-web containers, checks health and restores
the previous management containers on failure. Game containers, networks,
volumes and worlds are left in place. Agent startup skips automatic game-image
migrations. Existing game controllers/images require their own reviewed upgrade.

If an update is interrupted, **Recover agent update** restores the retained
management containers when the helper is no longer running. Recovery uses the
current owned runtime image already on the host, without a registry download.
Other host changes
remain blocked until recovery. Unexpected container/ownership changes require
manual inspection; retained containers and storage are not forcibly removed.
After an update, do not use the original Compose file to recreate management
containers with its older image. The panel manages subsequent agent updates.

## Network and validation limits

The main panel opens and holds one TLS 1.3 HTTP/2 connection to each paired agent
on its dedicated port. Requests and responses share multiplexed streams; uploads
and downloads retain backpressure and cancellation. Heartbeats detect broken
connections and the panel reconnects automatically with bounded backoff.
Interrupted commands are never replayed: check the job/server outcome before
retrying a change. Agent updates can briefly interrupt management connections;
the saved certificate identity and pairing credentials survive management updates.

Pairing and access remain scoped to this host. Every command checks the paired
credential, including commands on an already open connection after access is
revoked. Disconnecting closes this panel's connection. Preserve the management
volume containing `secrets/agent-identity/`; a changed certificate fails closed
and requires verified re-pairing. This pinned certificate is an application
identity, not a browser certificate; it is deliberately not automatically rotated.

The panel does not need a public callback address. A game host behind NAT needs
appropriate routing/forwarding or a private/VPN route to its agent port.
No outbound relay, automatic VPN, provider provisioning or firewall changes are
included. Game ports need their own rules when games are created. Docker and RCON remain unpublished.

Existing HTTPS hosts and full-panel pairings keep their original transport and
certificate requirements. Existing installation records are not rewritten or
migrated automatically; use a fresh installation directory for the dedicated-port
layout. Updating an older agent preserves its original bindings and transport.

Local regression tests use fake Docker and disposable HTTP/SSH/TLS fixtures. Browser
checks use synthetic setup, pairing, updates and creation. Native SSH bootstrap,
real container replacement, external networking and Windows/macOS agent launchers
still need separate disposable acceptance. See [verification](VERIFICATION.md).
