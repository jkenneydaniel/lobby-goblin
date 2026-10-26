// Repository organization is independent of the installed/update archive layout.
// Keep historical archive paths so already-installed validators accept releases.
import fs from 'node:fs/promises';
import path from 'node:path';

export const sourceMoves = Object.freeze(
  [
    ['factorio-image/', 'panel/applications/factorio/images/'],
    ['factorio-image/', 'images/factorio/'],
    ['panel/games/rust/image/', 'panel/applications/rust/images/'],
    ['panel/games/rust/image/', 'images/rust/'],
    ...[
      'Setup.sh',
      'Setup.ps1',
      'Setup.command',
      'Start-Server.sh',
      'Start-Server.ps1',
    ].map((name) => [name, 'scripts/standalone/' + name]),
    ...['Fleet.sh', 'Fleet.ps1'].map((name) => [name, 'scripts/fleet/' + name]),
    ...[
      'Configure-Lan.ps1',
      'Configure-Autostart.ps1',
      'Register-LanAnnouncer.ps1',
      'Start-LanAnnouncer.ps1',
    ].map((name) => [name, 'scripts/windows/' + name]),
    ['Install-Docker.sh', 'scripts/install/Install-Docker.sh'],
    ['fleet.compose.yaml', 'deploy/fleet/compose.yaml'],
    ['.env.fleet.example', 'deploy/fleet/.env.example'],
  ].map(Object.freeze),
);

function relocate(name, reverse) {
  for (const move of sourceMoves) {
    const [from, to] = reverse ? [move[1], move[0]] : move;
    if (from.endsWith('/') ? name.startsWith(from) : name === from)
      return to + name.slice(from.length);
  }
  return name;
}
export const repositoryPath = (name) => relocate(name, false);
export const installationPath = (name) => relocate(name, true);

// Source tools and fixtures run from either a checkout or an extracted release.
// Only ENOENT permits fallback; permissions and other errors must stay visible.
export async function sourceFile(root, installedName) {
  const current = path.join(root, repositoryPath(installedName));
  try {
    await fs.lstat(current);
    return current;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const [installed, source] of sourceMoves) {
    if (installed.endsWith('/') && installedName.startsWith(installed)) {
      const candidate = path.join(
        root,
        source + installedName.slice(installed.length),
      );
      try {
        await fs.lstat(candidate);
        return candidate;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return path.join(root, installedName);
}
