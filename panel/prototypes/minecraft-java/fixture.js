// Explicit synthetic fixture API only. Not registered or imported by a host,
// broker, application controller, image recipe or HTTP route.
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assert} from '../../common.js';
import {definitionData, freezeDefinition} from '../../core/definition-data.js';
import {
  validateEnvironmentBindings,
  renderEnvironment,
} from '../../core/environment-bindings.js';
import {
  directory,
  readRecord,
  atomicRecord,
} from '../../providers/steamcmd/files.js';
import {syncDirectory} from '../../core/storage/files.js';
import {
  javaFixtureRelease,
  fixtureReceipt,
  fixtureScope,
  exactRecord,
  verifyFixtureBytes,
  validateFixtureWorkerRequest,
} from './provider.js';

export function fixtureManagementBinding(value) {
  exactRecord(value, ['minecraftManagement']);
  assert(
    typeof value.minecraftManagement === 'string' &&
      /^[A-Za-z0-9]{40}$/.test(value.minecraftManagement),
    'Invalid private Minecraft fixture credential.',
  );
  const bindings = {
    MINECRAFT_MANAGEMENT_SECRET: [{secret: 'minecraftManagement'}],
  };
  validateEnvironmentBindings(bindings, {secrets: ['minecraftManagement']});
  return Object.freeze(renderEnvironment(bindings, {}, value));
}

export async function createJavaFixture({
  root,
  scope,
  release,
  credentials,
  exchange,
  fault = async () => {},
}) {
  scope = fixtureScope(scope);
  release = javaFixtureRelease(release);
  const environment = fixtureManagementBinding(credentials);
  assert(
    typeof exchange === 'function' && typeof fault === 'function',
    'A synthetic fixture transport is required.',
  );
  root = await directory(root);
  const privateDirectory = async () => {
    await directory(root);
    const stat = await fs.lstat(root);
    assert(
      stat.uid === process.getuid() && !(stat.mode & 0o077),
      'Fixture storage must be private and owned.',
      409,
    );
  };
  await privateDirectory();
  assert(
    (await fs.readdir(root)).every((name) =>
      ['fixture.json', 'server.jar', '.fixture.lock'].includes(name),
    ),
    'Fixture storage contains unrelated data.',
    409,
  );
  const journal = path.join(root, 'fixture.json'),
    jar = path.join(root, 'server.jar');
  const initial = () => ({
    format: 1,
    scope,
    release,
    request: null,
    preparation: 'absent',
    control: 'idle',
    receipt: null,
  });
  async function read() {
    await privateDirectory();
    const record = await readRecord(journal, {optional: true, max: 16384});
    if (!record) {
      assert(
        !(await fs.readdir(root)).includes('server.jar'),
        'Unrecorded fixture data needs inspection.',
        409,
      );
      return initial();
    }
    const metadata = await fs.lstat(journal);
    assert(
      metadata.uid === process.getuid() && (metadata.mode & 0o777) === 0o600,
      'Fixture records must remain private and owned.',
      409,
    );
    exactRecord(record, [
      'format',
      'scope',
      'release',
      'request',
      'preparation',
      'control',
      'receipt',
    ]);
    assert(
      record.format === 1 &&
        isDeepStrictEqual(record.scope, scope) &&
        isDeepStrictEqual(record.release, release) &&
        typeof record.request === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.request) &&
        ['preparing', 'complete'].includes(record.preparation) &&
        ['idle', 'saving', 'stopping', 'complete', 'unknown'].includes(
          record.control,
        ) &&
        (record.preparation === 'complete'
          ? isDeepStrictEqual(record.receipt, fixtureReceipt(release))
          : record.receipt === null),
      'Fixture record differs from its private binding.',
      409,
    );
    return record;
  }
  async function locked(run) {
    await privateDirectory();
    const lock = path.join(root, '.fixture.lock');
    const handle = await fs.open(lock, 'wx', 0o600);
    const owned = await handle.stat();
    try {
      return await run();
    } finally {
      await handle.close();
      const current = await fs.lstat(lock);
      assert(
        current.ino === owned.ino &&
          current.dev === owned.dev &&
          current.nlink === 1,
        'Fixture lock changed; preserve it for inspection.',
        409,
      );
      await fs.unlink(lock);
    }
  }
  async function verifyJar() {
    await privateDirectory();
    const handle = await fs.open(
      jar,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      assert(
        before.isFile() &&
          before.nlink === 1 &&
          before.uid === process.getuid() &&
          (before.mode & 0o777) === 0o400 &&
          before.size === release.bytes,
        'Fixture artifact is not a private read-only file.',
        409,
      );
      const hash = crypto.createHash('sha256'),
        buffer = Buffer.alloc(Math.min(65536, release.bytes + 1));
      let total = 0;
      for (;;) {
        const {bytesRead} = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, release.bytes - total + 1),
          null,
        );
        if (!bytesRead) break;
        total += bytesRead;
        assert(total <= release.bytes, 'Fixture artifact grew.', 409);
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      assert(
        total === release.bytes &&
          hash.digest('hex') === release.sha256 &&
          after.nlink === 1 &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs,
        'Fixture artifact changed.',
        409,
      );
    } finally {
      await handle.close();
    }
  }
  async function inspect() {
    const record = await read();
    if (record.preparation === 'complete') await verifyJar();
    return freezeDefinition({
      ...record,
      mode: 'synthetic-only',
      edition: 'java',
      preparation:
        record.preparation === 'preparing' ? 'unknown' : record.preparation,
      control: ['saving', 'stopping'].includes(record.control)
        ? 'unknown'
        : record.control,
    });
  }
  async function call(method) {
    // The injected function is a trusted fake transport, not an MSMP adapter.
    // There are no sockets, downloads, subprocesses or arbitrary RPC methods.
    let raw;
    try {
      raw = await exchange({method, scope, environment});
    } catch {
      throw Error('Synthetic Minecraft transport failed.');
    }
    assert(
      typeof raw === 'string' && Buffer.byteLength(raw) <= 16384,
      'Invalid synthetic Minecraft response.',
    );
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      throw Error('Invalid synthetic Minecraft response.');
    }
    if (method === 'status') {
      exactRecord(result, [
        'format',
        'edition',
        'gameVersion',
        'running',
        'ready',
      ]);
      assert(
        result.format === 1 &&
          result.edition === 'java' &&
          result.gameVersion === release.gameVersion &&
          typeof result.running === 'boolean' &&
          typeof result.ready === 'boolean' &&
          (!result.ready || result.running),
        'Synthetic Minecraft readiness is inconsistent.',
      );
    } else {
      exactRecord(result, ['format', 'ok']);
      assert(
        result.format === 1 && result.ok === true,
        'Synthetic Minecraft operation was not confirmed.',
      );
    }
    return freezeDefinition(result);
  }
  return Object.freeze({
    inspect,
    async prepare(request, bytes) {
      definitionData(request);
      const intent = freezeDefinition(request);
      validateFixtureWorkerRequest(intent, scope, intent?.request, release);
      verifyFixtureBytes(bytes, release);
      // Caller-owned objects and buffers must not change across the lock/read
      // awaits after validation. Keep a bounded private copy for this attempt.
      const artifact = Buffer.from(bytes);
      const receipt = verifyFixtureBytes(artifact, release);
      return locked(async () => {
        const record = await read();
        assert(
          record.preparation === 'absent',
          'Inspect the prior fixture preparation before any new attempt.',
          409,
        );
        const preparing = {
          ...record,
          request: intent.request,
          preparation: 'preparing',
        };
        await atomicRecord(journal, preparing);
        const handle = await fs.open(jar, 'wx', 0o600);
        try {
          await handle.writeFile(artifact);
          await handle.chmod(0o400);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(root);
        await fault('artifact-written');
        await verifyJar();
        await atomicRecord(journal, {
          ...preparing,
          preparation: 'complete',
          receipt,
        });
        return inspect();
      });
    },
    async observe() {
      const current = await inspect();
      assert(
        current.preparation === 'complete',
        'Prepare the synthetic artifact first.',
        409,
      );
      return call('status');
    },
    async saveAndStop(value) {
      exactRecord(value, ['confirm']);
      assert(
        value.confirm === true,
        'Explicit fixture confirmation is required.',
        403,
      );
      return locked(async () => {
        const current = await inspect();
        assert(
          current.preparation === 'complete' && current.control === 'idle',
          'Inspect the prior fixture control outcome; do not replay it.',
          409,
        );
        const status = await call('status');
        assert(
          status.running && status.ready,
          'The synthetic world is not ready to save.',
          409,
        );
        const record = await read();
        await atomicRecord(journal, {...record, control: 'saving'});
        try {
          await call('save');
          await atomicRecord(journal, {...record, control: 'stopping'});
          await call('stop');
          const stopped = await call('status');
          assert(
            !stopped.running && !stopped.ready,
            'Synthetic shutdown is unconfirmed.',
            409,
          );
          await atomicRecord(journal, {...record, control: 'complete'});
          return inspect();
        } catch {
          await atomicRecord(journal, {...record, control: 'unknown'});
          throw Error('Fixture control outcome requires inspection.');
        }
      });
    },
  });
}
