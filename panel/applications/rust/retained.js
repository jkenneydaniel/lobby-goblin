import {rustExecutionLinks} from './framework-changes.js';
import {
  executionBinary,
  executionProjection,
  readExecutionReceipt,
} from '../../core/software-execution.js';
import {rustSoftwareReceipt} from './archive.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assert, writeJSON} from '../../common.js';
import {retainedGates} from '../../fleet/retained-gates.js';
import {rustSnapshotSeed} from './seed.js';
import {regularFile} from '../../core/storage/files.js';

const instanceRecords = [
  'state/software/rust/installation.json',
  'state/software/rust/framework-changes/current.json',
];
export const retained = {
  version: 1,
  state: [
    'state/software/steamcmd',
    'state/software/rust/installation.json',
    'state/software/rust/current.json',
    'state/software/rust/protocol.json',
    'state/mods',
    'state/mod-library',
  ],
  async inspect({source, config, read}) {
    await retainedGates(read, [
      'state/mods/transaction.json',
      'state/mods/mod-library/transaction.json',
      'state/mod-library/transaction.json',
      'state/software/rust/installation.json',
      'state/image-migration.json',
    ]);
    await retainedGates(
      read,
      ['state/software/rust/framework-changes/current.json'],
      ['complete', 'recovered', 'reviewed'],
    );
    const seed = rustSnapshotSeed(config.seed),
      root = path.join(source, 'data/server/lobby-goblin-rust');
    const saves = (await fs.readdir(root)).filter((n) => n.endsWith('.sav'));
    assert(
      saves.length > 0 &&
        saves.every((n) => {
          const match = n.match(/^proceduralmap\.(\d+)\.(\d+)\..*\.sav$/);
          return (
            match &&
            Number(match[1]) === config.worldSize &&
            Number(match[2]) === seed
          );
        }),
      'Rust save does not match the retained server seed and size.',
      409,
    );
    if (config.softwareMode === 'managed') {
      const installed = await read(instanceRecords[0]),
        current = await read('state/software/rust/current.json');
      assert(
        installed?.instance === config.sourceId &&
          installed.phase === 'complete' &&
          (!current || current.initialId === installed.id),
        'Managed Rust needs a completed installation and its exact software record.',
        409,
      );
      const receipt = rustSoftwareReceipt(
          current?.receipt || installed.prepared?.receipt,
        ),
        binary = current?.binary || installed.binary;
      assert(
        JSON.stringify(
          await readExecutionReceipt(path.join(source, 'data')),
        ) === JSON.stringify(executionProjection(receipt, binary, 'rust')),
        'Rust execution receipt needs manual recovery review.',
        409,
      );
      await executionBinary(
        path.join(source, 'data/engine'),
        'RustDedicated',
        binary.sha256,
      );
    }
    for (const name of instanceRecords) {
      const value = await read(name);
      assert(
        !value || value.instance === config.sourceId,
        'Rust software state belongs to another instance.',
        409,
      );
    }
    const framework =
      (await read('state/mods/installed.json'))?.framework || 'none';
    assert(
      ['none', 'oxide', 'carbon'].includes(framework),
      'Rust framework identity requires manual review.',
      409,
    );
    const links =
      config.softwareMode === 'managed'
        ? Object.fromEntries(
            Object.entries(
              rustExecutionLinks(
                {
                  installRoot: path.join(source, 'data/engine'),
                  data: path.join(source, 'data/server'),
                  identity: 'lobby-goblin-rust',
                },
                framework,
              ),
            ).map(([name, target]) => ['data/engine/' + name, target]),
          )
        : {};
    return {seed, links};
  },
  async rebind({instance, config, read}) {
    for (const name of instanceRecords.slice(0, 1)) {
      const value = await read(name);
      if (value)
        await writeJSON(path.join(instance, name), {
          ...value,
          instance: config.id,
        });
    }
    for (const name of ['data/server', 'state', 'backups'])
      await writeJSON(path.join(instance, name, '.lobby-goblin-rust.json'), {
        game: 'rust',
        instance: config.id,
      });
    const file = path.join(
        instance,
        'data/server/lobby-goblin-rust/cfg/server.cfg',
      ),
      bytes = await regularFile(file, {optional: true, max: 1024 ** 2});
    const preserved = (bytes?.toString('utf8') || '')
      .split(/\r?\n/)
      .filter(
        (line) =>
          !/^\s*(?:rcon\.|server\.(?:hostname|maxplayers|identity|seed|worldsize|ip|port|queryport)\b)/i.test(
            line,
          ),
      );
    await fs.writeFile(
      file,
      preserved.join('\n') +
        `\nserver.hostname "${config.name}"\nserver.maxplayers ${config.maxPlayers}\n`,
      {mode: 0o600},
    );
    await fs.chmod(file, 0o600);
    // Complete copied software state authorizes the existing installation;
    // this fresh-instance bootstrap must never authorize a replacement download.
    await fs.rm(path.join(instance, 'control/managed-rust-bootstrap.json'), {
      force: true,
    });
  },
};
