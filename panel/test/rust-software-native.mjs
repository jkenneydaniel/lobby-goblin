// Single public fixture mounted in the tested management image. Preparation
// receives no game volume, credential, checkout or daemon socket.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {startDockerBroker} from '/app/core/docker-broker.js';
import {
  brokerClient,
  brokerSocket,
  brokerToken,
} from '/app/core/broker-client.js';
import {resources} from '/app/core/instance.js';
import {SoftwareWorkers} from '/app/core/software-workers.js';
import {demultiplex} from '/app/core/docker.js';
import {createHost} from '/app/core/host.js';
import {selectedApplication} from '/app/applications/index.js';
import {runWorker} from '/app/fleet/worker.js';
import {publishSnapshot, verifySnapshot} from '/app/fleet/snapshots.js';
import {atomicRecord, readRecord} from '/app/providers/steamcmd/files.js';
import {createWebRcon, sanitizeLogs} from '/app/applications/rust/transport.js';
import {verifyArchive} from '/app/applications/rust/archive.js';
import {createRustSoftware} from '/app/applications/rust/software.js';
import {rustSoftwareProtocol} from '/app/applications/rust/software-protocol.js';

assert.equal(process.env.RUST_SOFTWARE_ACCEPTANCE, 'disposable');
assert.equal(process.getuid(), 0);
assert.equal(process.getgid(), 0);
const fleet = process.env.FLEET_ID,
  instance = process.env.FLEET_INSTANCE,
  owned = resources(fleet, instance, 'rust');
const rust = selectedApplication('rust'),
  image = rust.managed.runtime.imagePolicy.defaultImage;
assert.equal(process.env.NATIVE_GAME_IMAGE, image);
const mode = process.argv[2];
function freshItem() {
  return {
    game: 'rust',
    fleet,
    id: instance,
    ...owned,
    image,
    softwareMode: 'managed',
    name: mode === 'clone' ? 'Native Rust clone' : 'Native Rust source',
    gamePort: 28015,
    queryPort: 28017,
    memoryGiB: 10,
    cpu: 2,
    seed: 12345,
    worldSize: 1000,
    maxPlayers: 1,
    autoStart: false,
    rconPassword: process.env.NATIVE_GAME_PASSWORD,
    controllerToken: randomUUID().replaceAll('-', '').repeat(2),
  };
}
if (mode === 'broker') {
  assert.equal(process.env.DOCKER_BROKER_SOCKET, undefined);
  await startDockerBroker({
    env: process.env,
    runtimeImage: process.env.ACCEPTANCE_RUNTIME,
  });
} else if (mode === 'initialize' || mode === 'clone') {
  assert.deepEqual(await fs.readdir('/instance'), []);
  let item = freshItem();
  if (mode === 'clone') {
    const sourceId = process.env.NATIVE_SOURCE_ID;
    assert.notEqual(sourceId, instance);
    const verified = await verifyArchive(
      '/source/backups/archives/native-rust.tar.gz',
    );
    assert.ok(verified.software);
    const snapshot = process.env.NATIVE_SNAPSHOT_ID;
    const published = await publishSnapshot({
      library: '/library',
      backup: '/source/backups/archives/native-rust.tar.gz',
      record: {
        id: snapshot,
        sourceId,
        title: 'Native exact Rust copy',
        game: 'rust',
        image,
        seed: 12345,
        worldSize: 1000,
      },
    });
    const manifest = await verifySnapshot(
      '/library',
      snapshot,
      published.manifestSha256,
    );
    assert.equal(manifest.credentialsIncluded, false);
    assert.ok(!manifest.files.some((file) => file.name.includes('/cfg/')));
    item = {
      ...item,
      ...rust.managed.creationFromSnapshot(
        {game: 'rust', name: 'Native Rust clone'},
        manifest,
      ),
      snapshotId: snapshot,
      snapshotHash: published.manifestSha256,
    };
  }
  await runWorker({...item, action: 'provision'});
  await atomicRecord('/instance/control/native-item.json', item);
  console.log(
    JSON.stringify({initialized: true, clone: mode === 'clone', instance}),
  );
} else {
  assert.equal(process.env.DOCKER_SOCKET, undefined);
  const client = brokerClient({
    socketPath: brokerSocket,
    tokenFile: brokerToken,
  });
  if (mode === 'grant') await client.grant({id: instance, game: 'rust'});
  else {
    assert.equal(mode, 'controller');
    const item = await readRecord('/instance/control/native-item.json', {
      max: 65536,
    });
    assert.equal(item.id, instance);
    assert.equal(item.image, image);
    const clone = process.env.NATIVE_CLONE === 'true';
    const env = {
      ...process.env,
      ...rust.managed.controllerEnvironment(item, {address: '127.0.0.1'}),
      FLEET_RESTART_POLICY: 'no',
    };
    const config = rust.configuration(env);
    await rust.validateInstallation(config);
    const workers = new SoftwareWorkers({
      docker: client.docker,
      env,
      declaration: rust.managed.softwareWorker,
    });
    const preparationActions = [],
      run = workers.run.bind(workers);
    workers.run = async (action, ...args) => {
      preparationActions.push(action);
      return run(action, ...args);
    };
    let active = {id: 'native-initial-start'};
    const ctx = {
      config,
      env,
      docker: client.docker,
      host: createHost({
        docker: client.docker,
        container: owned.container,
        stopTimeout: -1,
      }),
      softwareWorkers: workers,
      every() {},
      runJob() {
        assert.fail('No background management job is needed.');
      },
      stageMessage: async (_job, message, phase) =>
        console.log(JSON.stringify({phase, message})),
      get active() {
        return active;
      },
    };
    let beforeFrameworkCommit = null;
    const rcon = createWebRcon(),
      game = await rust.createController(ctx, {
        rcon,
        readyTimeout: 900000,
        frameworkFault: async (phase) => {
          if (phase === 'before-framework-commit' && beforeFrameworkCommit) {
            const run = beforeFrameworkCommit;
            beforeFrameworkCommit = null;
            await run();
            throw Error('Injected loss after native framework validation');
          }
        },
      });
    // Use the application controller, not a raw game-start shortcut.
    try {
      await game.init();
      assert.equal((await ctx.host.info()).State.Running, false);
      const sentinel = path.join(
        config.data,
        config.identity,
        'native-copied-world.txt',
      );
      if (clone) {
        assert.equal(
          await fs.readFile(sentinel, 'utf8'),
          'new independent CI world only',
        );
        assert.ok(
          (await fs.readdir(path.join(config.data, config.identity))).some(
            (name) => name.endsWith('.sav'),
          ),
        );
      }
      const preparedReceipt = await createRustSoftware(ctx).ensure(active);
      const preparedProtocol = await rustSoftwareProtocol({
        ...ctx.softwareWorkers.paths,
        receipt: preparedReceipt,
      });
      assert.equal((await ctx.host.info()).State.Running, false);
      console.log(
        JSON.stringify({
          event: 'protocol-before-first-boot',
          ...preparedProtocol,
        }),
      );
      await game.actions.start({}, active);
      active = null;
      const status = await game.status();
      assert.equal(status.ready, true);
      assert.equal(status.maxPlayers, 1);
      assert.equal(status.software.managed, true);
      const server = await ctx.host.info(),
        network = Object.values(server.NetworkSettings.Networks)[0].IPAddress;
      const command = (value) =>
        rcon({
          host: network,
          port: 28016,
          password: item.rconPassword,
          command: value,
        });
      let worldTime;
      if (clone) {
        const value = await command('env.time'),
          match = value.match(/env\.time:\s*"?([0-9]+(?:\.[0-9]+)?)/);
        assert.ok(match);
        worldTime = Number(match[1]);
        assert.ok(
          Math.abs(worldTime - 18.25) < 0.75,
          'Copied save must restore its deliberately set world time.',
        );
        assert.deepEqual(preparationActions, ['prepare']);
        assert.equal(
          status.software.version,
          item.softwareReceipt.selection.softwareVersion,
        );
        const logs = await client.docker(
          'GET',
          '/containers/' +
            owned.container +
            '/logs?stdout=true&stderr=true&tail=1000',
          undefined,
          {raw: true},
        );
        assert.match(demultiplex(logs), /Spawning [1-9]\d* entities from save/);
      } else {
        await command('env.time 18.25');
        await command('server.save');
        await fs.writeFile(sentinel, 'new independent CI world only', {
          mode: 0o600,
        });
        assert.deepEqual(preparationActions, ['resolve', 'prepare']);
        active = {id: 'native-software-check', action: 'software-check'};
        await game.beforeJob(active);
        const checked = await game.actions['software-check']({}, active);
        active = null;
        assert.equal(checked.current.softwareVersion, status.software.version);
        assert.equal(checked.target.source.appId, '258550');
        assert.equal(checked.target.source.branch, 'public');
        assert.equal((await ctx.host.info()).State.Running, true);
        if (!checked.updateAvailable)
          await assert.rejects(
            game.actions['software-update']({
              planId: checked.id,
              confirm: true,
            }),
            /already installed/,
          );
        console.log(
          JSON.stringify({
            event: 'native-software-check',
            buildId: checked.target.softwareVersion,
            noDowntime: true,
            sameBuildRefused: !checked.updateAvailable,
          }),
        );
      }
      active = {id: 'native-stop'};
      await game.actions.stop({confirm: true});
      active = null;
      const stopped = await ctx.host.info();
      assert.equal(stopped.State.Running, false);
      assert.equal(stopped.State.ExitCode, 0);
      assert.equal(stopped.State.OOMKilled, false);
      assert.equal(
        await fs.readFile(sentinel, 'utf8'),
        'new independent CI world only',
      );
      let exactBackup = false;
      if (!clone) {
        await fs.mkdir(config.backupDir, {recursive: true});
        await game.writeBackup(
          path.join(config.backupDir, 'native-rust.tar.gz'),
          'native',
        );
        const backup = await verifyArchive(
          path.join(config.backupDir, 'native-rust.tar.gz'),
        );
        assert.equal(
          backup.software.selection.softwareVersion,
          status.software.version,
        );
        exactBackup = true;
      }
      let pairedFrameworks = false;
      if (!clone) {
        async function query(method, pathname, body) {
          const data = Buffer.from(JSON.stringify(body || {})),
            req = Readable.from([data]);
          req.method = method;
          req.headers = {'content-length': String(data.length)};
          let result;
          await game.handle(
            req,
            {
              writeHead: (code) => assert.equal(code, 200),
              end: (text) => {
                result = JSON.parse(text);
              },
            },
            new URL(pathname, 'http://127.0.0.1'),
          );
          return result;
        }
        async function operation(action, params = {}) {
          active = {id: 'native-' + action + '-' + randomUUID(), action};
          console.log(JSON.stringify({operation: action, event: 'started'}));
          try {
            await game.beforeJob(active);
            const result = await game.actions[action](params, active);
            console.log(
              JSON.stringify({operation: action, event: 'completed'}),
            );
            return result;
          } finally {
            active = null;
          }
        }
        const protocol = await readRecord(
          path.join(config.state, 'software/rust/protocol.json'),
        );
        assert.equal(protocol.buildId, status.software.version);
        assert.match(protocol.protocol, /^\d+\.\d+\.\d+$/);
        assert.equal(protocol.protocol, preparedProtocol.protocol);
        const carbon = await query('POST', '/mods-plan', {framework: 'carbon'});
        await operation('install-framework', {
          planId: carbon.id,
          confirm: true,
        });
        assert.equal((await ctx.host.info()).State.Running, false);
        assert.equal(
          (await query('GET', '/framework-change')).phase,
          'prepared',
        );
        await operation('start');
        assert.equal(
          (await query('GET', '/framework-change')).phase,
          'complete',
        );
        await operation('stop', {confirm: true});
        const plugin =
          'using Oxide.Core; namespace Oxide.Plugins { [Info("PairedProbe", "Lobby Goblin", "1.0.0")] public class PairedProbe : RustPlugin { protected override void LoadDefaultConfig() { Config["marker"] = "PAIRED_CONFIG"; SaveConfig(); } [ConsoleCommand("lg.paired")] void Probe(ConsoleSystem.Arg arg) { int value=Interface.Oxide.DataFileSystem.ReadObject<int>("PairedProbe")+1; Interface.Oxide.DataFileSystem.WriteObject("PairedProbe",value); arg.ReplyWith("PAIRED_DATA:"+value); } } }';
        await operation('plugin', {
          operation: 'install',
          name: 'PairedProbe.cs',
          source: plugin,
          confirm: true,
        });
        await operation('start');
        const deadline = Date.now() + 180000;
        let loaded = false;
        do {
          if (String(await command('lg.paired')).includes('PAIRED_DATA:1')) {
            loaded = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } while (Date.now() < deadline);
        assert.equal(
          loaded,
          true,
          'Carbon must compile the actual user plugin and persist its data',
        );
        await command('env.time 9.5');
        await operation('stop', {confirm: true});
        const oxide = await query('POST', '/mods-plan', {framework: 'oxide'});
        assert.ok(oxide.compiler.sha256);
        await operation('install-framework', {planId: oxide.id, confirm: true});
        beforeFrameworkCommit = async () => {
          await command('env.time 7.5');
          await command('server.save');
          await fs.writeFile(
            path.join(config.data, config.identity, 'native-newer-world.txt'),
            'NEWER DATA MUST BE RETAINED',
          );
        };
        await assert.rejects(
          operation('start'),
          /Injected loss after native framework validation/,
        );
        assert.equal((await ctx.host.info()).State.Running, false);
        const recovery = await query('GET', '/framework-change');
        assert.equal(recovery.phase, 'validating');
        await operation('recover-framework', {
          confirm: true,
          review: recovery.review,
        });
        assert.equal(
          (await query('GET', '/framework-change')).phase,
          'recovered',
        );
        const retained = path.join(
          config.state,
          'software/rust/framework-changes/history',
          recovery.observation.record.id,
          'quarantine-world',
          config.identity,
          'native-newer-world.txt',
        );
        assert.equal(
          await fs.readFile(retained, 'utf8'),
          'NEWER DATA MUST BE RETAINED',
        );
        await assert.rejects(
          fs.access(
            path.join(config.data, config.identity, 'native-newer-world.txt'),
          ),
        );
        await operation('start');
        const restoredTime = Number(
          String(await command('env.time')).match(
            /env\.time:\s*"?([0-9]+(?:\.[0-9]+)?)/,
          )[1],
        );
        assert.ok(Math.abs(restoredTime - 9.5) < 0.75);
        const pluginDeadline = Date.now() + 180000;
        loaded = false;
        do {
          if (String(await command('lg.paired')).includes('PAIRED_DATA:2')) {
            loaded = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } while (Date.now() < pluginDeadline);
        assert.equal(
          loaded,
          true,
          'Recovery must restore Carbon and its pre-Oxide plugin data',
        );
        await operation('stop', {confirm: true});
        const vanilla = await query('POST', '/mods-plan', {framework: 'none'});
        await operation('install-framework', {
          planId: vanilla.id,
          confirm: true,
        });
        await operation('start');
        await operation('stop', {confirm: true});
        assert.equal((await query('GET', '/mods')).framework, 'none');
        assert.equal(
          await fs.readFile(sentinel, 'utf8'),
          'new independent CI world only',
        );
        pairedFrameworks = true;
      }
      console.log(
        JSON.stringify({
          passed: true,
          clone,
          buildId: status.software.version,
          exactBackup,
          pairedFrameworks,
          preparationActions,
          worldLoaded: clone,
          worldTime,
          saveAndQuitVerified: true,
          serverNeverAutoStarted: true,
        }),
      );
    } catch (error) {
      const logs = await client
        .docker(
          'GET',
          '/containers/' +
            owned.container +
            '/logs?stdout=true&stderr=true&tail=300',
          undefined,
          {raw: true},
        )
        .catch(() => Buffer.from('No game logs.'));
      console.error(sanitizeLogs(demultiplex(logs), item.rconPassword));
      throw error;
    } finally {
      rcon.close();
    }
  }
}
