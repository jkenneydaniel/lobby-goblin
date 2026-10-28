import fs from 'node:fs/promises';
import {ManagementFailure} from './management-errors.js';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert, equalSecret, json, requestJSON} from '../common.js';
import {regularFile, parseStorageJSON, syncDirectory} from './storage/files.js';

const identifier = (value) =>
  typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
async function saveActivation(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close();
    await fs.rm(temporary, {force: true});
  }
}

// An operator sets a new ID on replacement management services. Their ordinary
// writers and background work stay held until local authenticated activation.
// The durable receipt lets an already-activated service restart normally.
export async function managementMaintenance(
  root,
  env,
  {save = saveActivation, readOnly = false} = {},
) {
  const id = env.PANEL_MAINTENANCE_ID;
  assert(
    id === undefined || identifier(id),
    'Invalid management maintenance identity.',
  );
  let held = !!id,
    busy = false,
    prepared = false;
  const file = path.join(root, 'management-activation.json');
  async function readReceipt() {
    const bytes = await regularFile(file, {optional: true, max: 2048});
    if (bytes) {
      const receipt = parseStorageJSON(bytes);
      assert(
        receipt?.version === 1 &&
          identifier(receipt.id) &&
          receipt.activated === true &&
          typeof receipt.at === 'string' &&
          Number.isFinite(Date.parse(receipt.at)) &&
          Object.keys(receipt).every((key) =>
            ['version', 'id', 'activated', 'at'].includes(key),
          ),
        'Unknown management activation receipt. Preserve it for review.',
        503,
      );
      return receipt;
    }
    return null;
  }
  if (id) {
    assert(
      (await fs.realpath(root)) === root,
      'Management maintenance needs canonical private storage.',
    );
    if ((await readReceipt())?.id === id) held = false;
  }
  const refresh = async () => {
    if (readOnly && held && (await readReceipt())?.id === id) held = false;
  };
  const status = () => ({
    version: 1,
    supported: true,
    id: id || null,
    held,
    busy,
  });
  async function activate(body, prepare) {
    assert(
      id &&
        body?.id === id &&
        body.confirm === true &&
        Object.keys(body).every((key) => ['id', 'confirm'].includes(key)),
      'Confirm the exact management maintenance identity.',
    );
    assert(!busy, 'Management activation is already in progress.', 409);
    if (!held) return status();
    assert(
      !readOnly,
      'A local operator must publish the activation receipt through writable management storage.',
      409,
    );
    busy = true;
    try {
      if (!prepared) {
        await prepare();
        prepared = true;
      }
      await save(file, {
        version: 1,
        id,
        activated: true,
        at: new Date().toISOString(),
      });
      held = false;
      return status();
    } finally {
      busy = false;
    }
  }
  return {
    get held() {
      return held;
    },
    get preparing() {
      return busy && !prepared;
    },
    status,
    activate,
    refresh,
    async handle(req, res, url, {token, prepare = async () => {}, inspect}) {
      await refresh();
      if (
        !['/management/status', '/management/activate'].includes(url.pathname)
      )
        return false;
      assert(
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
          req.socket?.remoteAddress,
        ),
        'Management maintenance is available only to a local operator.',
        403,
      );
      assert(
        equalSecret(req.headers.authorization, 'Bearer ' + token),
        'Unauthorized.',
        401,
      );
      if (url.pathname === '/management/status') {
        assert(req.method === 'GET', 'Not found.', 404);
        json(res, 200, {
          ...status(),
          ...(inspect ? {workflow: await inspect()} : {}),
        });
      } else {
        assert(req.method === 'POST', 'Not found.', 404);
        json(res, 200, await activate(await requestJSON(req), prepare));
      }
      return true;
    },
    assertAvailable() {
      assert(
        !held,
        'Management maintenance is in progress. Wait for the operator to finish.',
        503,
      );
    },
  };
}

export async function writeManagementActivation(root, id) {
  assert(
    identifier(id) && (await fs.realpath(root)) === root,
    'Choose canonical management storage and its reviewed maintenance identity.',
  );
  await saveActivation(path.join(root, 'management-activation.json'), {
    version: 1,
    id,
    activated: true,
    at: new Date().toISOString(),
  });
}

export function assertManagementIdle(snapshot) {
  if (snapshot?.sources?.some(source => source.available === false))
    throw new ManagementFailure(snapshot.sources.some(source => source.reason === 'duplicate-operation-identity') ? 'duplicate-operation-identity' : 'workflow-history-unavailable');
  assert(
    snapshot?.version === 1 &&
      Array.isArray(snapshot.sources) &&
      snapshot.sources.length <= 32 &&
      snapshot.sources.every((source) => source.available === true) &&
      Array.isArray(snapshot.operations) &&
      snapshot.operations.length <= 2000,
    'Every workflow history must be available before management activation.',
    409,
  );
  const idle = snapshot.operations.every(
      (operation) =>
        ['succeeded', 'failed', 'interrupted'].includes(operation.state) &&
        !operation.recovery?.required &&
        (operation.state !== 'interrupted' ||
          operation.recovery?.required === false),
    );
  if (!idle) throw new ManagementFailure('workflow-not-idle');
}
