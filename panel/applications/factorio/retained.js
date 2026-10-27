import fs from 'node:fs/promises';
import path from 'node:path';
import {writeJSON} from '../../common.js';
import {retainedGates} from '../../fleet/retained-gates.js';

export const retained = {
  version: 1,
  state: [
    'state/mod-library',
    'state/world-options.json',
    'state/map-pins.json',
  ],
  async inspect({read}) {
    await retainedGates(read, [
      'state/factorio-runtime-update.json',
      'state/mod-library/transaction.json',
      'state/image-migration.json',
      'updates/image-migration.json',
    ]);
    return {};
  },
  async rebind({instance, config, read}) {
    const file = path.join(instance, 'data/config/server-settings.json');
    await writeJSON(file, {
      ...(await read('data/config/server-settings.json')),
      name: config.name,
      max_players: config.maxPlayers,
    });
    await fs.writeFile(
      path.join(instance, 'data/config/rconpw'),
      config.rconPassword,
      {mode: 0o600},
    );
    await fs.chmod(path.join(instance, 'data/config/rconpw'), 0o600);
    await writeJSON(path.join(instance, 'state/map-refresh.json'), {
      enabled: false,
    });
    await writeJSON(path.join(instance, 'state/live-players.json'), {
      enabled: false,
    });
  },
};
