import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {assert} from '../common.js';
import {
  softwareReceipt,
  softwareSelectionKey,
} from './software-installation.js';
import {
  directory,
  readRecord,
  softwareInventory,
} from '../providers/steamcmd/files.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Read data from a receipt-bound pristine module. This does not load code,
// follow execution-tree overlays, download, activate, or access world storage.
export async function readSoftwareModule({
  software,
  control,
  receipt: value,
  name,
}) {
  const receipt = softwareReceipt(value);
  assert(
    typeof name === 'string' &&
      name.length <= 512 &&
      !name.includes('\\') &&
      name
        .split('/')
        .every(
          (part) =>
            /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part),
        ),
    'Invalid software module path.',
  );
  const {manifest, source} = await retainedInventory({
    software,
    control,
    receipt,
  });
  const entries = manifest.files.filter((file) => file.name === name);
  assert(entries.length <= 1, 'Ambiguous software module.', 409);
  if (!entries.length) return null;
  const expected = entries[0];
  assert(
    Number.isSafeInteger(expected.size) &&
      expected.size >= 512 &&
      expected.size <= 64 * 1024 ** 2 &&
      /^[a-f0-9]{64}$/.test(expected.sha256),
    'Software module exceeds its bounds.',
    409,
  );
  let parent = source;
  await directory(parent);
  for (const part of name.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    await directory(parent);
  }
  const handle = await fs.open(
    path.join(parent, name.split('/').at(-1)),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    assert(
      before.isFile() && before.nlink === 1 && before.size === expected.size,
      'Software module is unsafe or changed.',
      409,
    );
    const bytes = Buffer.alloc(expected.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, null);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const after = await handle.stat(),
      content = bytes.subarray(0, read);
    assert(
      read === expected.size &&
        after.size === before.size &&
        after.nlink === 1 &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs &&
        digest(content) === expected.sha256,
      'Software module differs from its pristine receipt.',
      409,
    );
    return {bytes: content, sha256: expected.sha256, name};
  } finally {
    await handle.close();
  }
}

async function retainedInventory({software, control, receipt: value}) {
  const receipt = softwareReceipt(value);
  const key =
    softwareSelectionKey(receipt.selection) + '-' + receipt.inventory.sha256;
  await directory(path.join(control, 'inventories'));
  const manifest = await readRecord(
    path.join(control, 'inventories', key + '.json'),
    {max: 64 * 1024 ** 2},
  );
  assert(
    manifest?.format === 1 &&
      JSON.stringify(softwareReceipt(manifest.receipt)) ===
        JSON.stringify(receipt) &&
      Array.isArray(manifest.files) &&
      manifest.files.length === receipt.inventory.files &&
      digest(JSON.stringify(manifest.files)) === receipt.inventory.sha256,
    'Software module inventory differs from its receipt.',
    409,
  );
  return {receipt, manifest, source: path.join(software, 'releases', key)};
}

// Recovery must prove the exact retained cache BEFORE starting a preparation
// worker; missing/corrupt historical software must not fall back to a download.
export async function verifyPristineSoftware(options) {
  const {receipt, manifest, source} = await retainedInventory(options);
  const observed = await softwareInventory(source);
  assert(
    JSON.stringify(observed.inventory) === JSON.stringify(receipt.inventory) &&
      JSON.stringify(observed.files) === JSON.stringify(manifest.files),
    'Retained pristine software failed recovery verification. Preserve all copies.',
    409,
  );
  return receipt;
}
