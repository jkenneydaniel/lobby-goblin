import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRustSoftware} from '../applications/rust/software.js';
import {createSteamProvider} from '../providers/steamcmd/provider.js';
import {softwareWorkerPaths} from '../core/software-worker-policy.js';
import {atomicRecord, softwareInventory} from '../providers/steamcmd/files.js';

export async function fixture(t, {module} = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-rust-software-')),
  );
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const instance = 'a'.repeat(32),
    image = 'reviewed-managed-image';
  for (const name of [
    'data',
    'data/engine',
    'data/server',
    'data/server/lobby-goblin-rust',
    'data/server/lobby-goblin-rust/cfg',
    'state',
    'control',
    'state/software-workers',
  ])
    await fs.mkdir(path.join(root, name), {recursive: true, mode: 0o755});
  await atomicRecord(path.join(root, 'data/server/.lobby-goblin-rust.json'), {
    game: 'rust',
    instance,
  });
  await fs.writeFile(
    path.join(root, 'data/server/lobby-goblin-rust/cfg/server.cfg'),
    'server.hostname "Synthetic"\n',
    {mode: 0o600},
  );
  await atomicRecord(path.join(root, 'control/managed-rust-bootstrap.json'), {
    format: 1,
    instance,
    game: 'rust',
    inventory: (await softwareInventory(path.join(root, 'data/server')))
      .inventory,
  });
  const source = {
      application: 'rust',
      appId: '258550',
      platform: 'linux/amd64',
      branches: ['public'],
    },
    requiredFiles = [{path: 'RustDedicated', executable: true}];
  const runtime = {
    build: '123',
    running: false,
    foreign: false,
    workers: [],
    calls: [],
    fault: null,
  };
  const paths = Object.fromEntries(
    Object.entries(softwareWorkerPaths).map(([key, value]) => [
      key,
      path.join(root, value),
    ]),
  );
  const command = async (args) => {
    runtime.calls.push(args);
    if (args.includes('+app_info_print'))
      return (
        '"258550" {"depots" {"258552" {"config" {"oslist" "linux"} "manifests" {"public" {"gid" "' +
        runtime.build +
        '" "size" "500"}}} "branches" {"public" {"buildid" "' +
        runtime.build +
        '"}}}}'
      );
    const target = args[args.indexOf('+force_install_dir') + 1];
    await fs.mkdir(path.join(target, 'steamapps'), {recursive: true});
    if (module) {
      await fs.mkdir(path.join(target, 'RustDedicated_Data/Managed'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(target, 'RustDedicated_Data/Managed/Rust.Global.dll'),
        module,
      );
    }
    await fs.writeFile(
      path.join(target, 'RustDedicated'),
      'synthetic Rust executable',
      {mode: 0o755},
    );
    await fs.writeFile(
      path.join(target, 'steamapps/appmanifest_258550.acf'),
      '"AppState" {"appid" "258550" "buildid" "' +
        runtime.build +
        '" "StateFlags" "4" "UserConfig" {"BetaKey" "public"} "InstalledDepots" {"258552" {"manifest" "' +
        runtime.build +
        '"}}}',
    );
    return 'Success';
  };
  const privateProvider = createSteamProvider({
    source,
    requiredFiles,
    software: paths.software,
    control: paths.control,
    command,
  });
  const retained = new Map();
  const workers = {
    root,
    paths,
    scope: {
      instance,
      volume: 'fixture-volume',
      declaration: {source, requiredFiles},
    },
    workers: async () => runtime.workers,
    async run(action, input, options) {
      const result =
        action === 'resolve'
          ? await privateProvider.resolve(input)
          : await privateProvider.prepare(input, {
              operationId: options.id,
              confirm: true,
            });
      retained.set(options.id, {
        record: {id: options.id, action, phase: 'complete'},
        response: {ok: true, action, result},
        worker: null,
        lease: null,
      });
      return result;
    },
    acknowledge: async (id) => retained.delete(id),
    history: async () => [...retained.values()].map((value) => value.record),
    inspect: async (id) => retained.get(id),
    close: async () =>
      assert.fail('Known completed synthetic requests do not need closure'),
  };
  const ctx = {
    config: {
      softwareManaged: true,
      restartPolicy: 'no',
      identity: 'lobby-goblin-rust',
      managedVolume: 'fixture-volume',
      instance,
      image,
      data: path.join(root, 'data/server'),
      installRoot: path.join(root, 'data/engine'),
      state: path.join(root, 'state'),
    },
    env: {},
    softwareWorkers: workers,
    host: {
      info: async () => ({
        Mounts: [
          {
            Type: 'volume',
            Name: 'fixture-volume',
            Destination: '/steamcmd/rust',
            RW: true,
          },
        ],
        HostConfig: {
          RestartPolicy: {Name: 'no'},
          Mounts: [
            {
              Source: 'fixture-volume',
              Target: '/steamcmd/rust',
              VolumeOptions: {Subpath: 'data', NoCopy: true},
            },
          ],
        },
        Config: {
          Image: image,
          Labels: {
            'io.lobby-goblin.instance': runtime.foreign
              ? 'b'.repeat(32)
              : instance,
            'io.lobby-goblin.game': 'rust',
          },
        },
        State: {Running: runtime.running, Restarting: false},
      }),
    },
    stageMessage: async () => {},
  };
  const create = () =>
    createRustSoftware(ctx, {
      fault: (phase) => {
        if (runtime.fault === phase) {
          runtime.fault = null;
          throw Error('Injected ' + phase);
        }
      },
    });
  return {
    root,
    ctx,
    create,
    runtime,
    software: create(),
    paths,
    privateProvider,
  };
}
