import {retained} from './retained.js';
import {imageMatch} from '../../core/image-policy.js';
import {runtimeSoftware,runtimeImagePolicy,runtimeReceipt} from './runtime.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {writeJSON} from '../../common.js';
import {snapshotImageCompatible} from '../../core/game-images.js';
import {compileManagedDefinition} from '../../core/managed-definition.js';
import {definition} from './definition.js';
import {collectSnapshot, restoreSnapshot} from './snapshots.js';

export const managed = compileManagedDefinition(definition,{
  retained,
  runtime:{imagePolicy:runtimeImagePolicy,software:runtimeSoftware},
  legacyMigration: {
    file: (config, env) =>
      path.join(env.UPDATE_STATE_DIR || '/updates', 'image-migration.json'),
    names: (config, env) => ({
      game: config.container,
      controller: env.CONTROLLER_CONTAINER || 'factorio-panel-controller',
      panel: env.PANEL_CONTAINER || 'factorio-panel',
    }),
  },
  creationFromSnapshot: (input,manifest) => {if(manifest.software){runtimeReceipt(manifest.software);return {...input,softwareMode:'runtime',softwareReceipt:manifest.software};}return input;},
  async prepareStorage({instance: _instance, data, config: _config}) {
    for (const directory of ['saves', 'config', 'mods'])
      await fs.mkdir(path.join(data, directory), {recursive: true});
    // Snapshot content is restored before new credentials and configuration.
  },
  async configureStorage({data, config}) {
    await writeJSON(path.join(data, 'config/server-settings.json'), {
      name: config.name,
      description: 'Managed by Lobby Goblin',
      visibility: {public: false, lan: true},
      require_user_verification: false,
      max_players: config.maxPlayers,
      autosave_interval: 5,
      autosave_slots: 3,
      auto_pause: true,
    });
    if(config.softwareReceipt){await fs.mkdir(path.join(data,'runtime'),{recursive:true});await writeJSON(path.join(data,'runtime/bootstrap.json'),runtimeReceipt(config.softwareReceipt));}
    // A fresh boot must not look like an existing identity with a missing world.
    if (config.snapshotId)
      await fs.writeFile(
        path.join(data, 'config/rconpw'),
        config.rconPassword,
        {mode: 0o600, flag: 'wx'},
      );
    else
      await writeJSON(path.join(data, 'config/map-gen-settings.json'), {
        seed: config.seed,
      });
  },
  snapshots: {
    compatible: (from, to) => !!imageMatch(runtimeImagePolicy,from)&&!!imageMatch(runtimeImagePolicy,to)||snapshotImageCompatible('factorio', from, to),
    collect: collectSnapshot,
    restore: restoreSnapshot,
  },
});
