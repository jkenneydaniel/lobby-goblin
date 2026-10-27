import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {cliConstants} from '../applications/rust/cli-constants.js';
import {rustSoftwareProtocol} from '../applications/rust/software-protocol.js';
import {readSoftwareModule} from '../core/software-module.js';
import {softwareSelectionKey} from '../core/software-installation.js';
import {protocolModule} from './fixtures/cli-metadata/protocol.mjs';
import {fixture} from './rust-software-fixture.mjs';

const moduleName = 'RustDedicated_Data/Managed/Rust.Global.dll';
test('CLI metadata reads unsigned Rust protocol fields and a published independent signed .NET assembly without executing code', async () => {
  assert.deepEqual(
    [...cliConstants(protocolModule(), 'Rust', 'Protocol')],
    [
      ['network', 2635],
      ['save', 289],
      ['report', 1],
    ],
  );
  const bytes = await fs.readFile(
    new URL(
      'fixtures/cli-metadata/System.Reflection.Metadata.dll',
      import.meta.url,
    ),
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '24c8d1f3d93803a7db24ed9c9725fec5613990321f7080a96f8d4a5dfe832be4',
  );
  assert.deepEqual(
    [...cliConstants(bytes, 'System.Reflection.Metadata', 'MetadataKind')],
    [
      ['Ecma335', 0],
      ['WindowsMetadata', 1],
      ['ManagedWindowsMetadata', 2],
    ],
  );
  assert.equal(cliConstants(bytes, 'Rust', 'Protocol'), null);
});

test('CLI metadata rejects truncation, malformed heap/table bounds, invalid identities and hostile offsets', () => {
  const bytes = protocolModule();
  for (const length of [0, 511, 512, 768, 800, 1000])
    assert.throws(() =>
      cliConstants(bytes.subarray(0, length), 'Rust', 'Protocol'),
    );
  for (const [offset, value] of [
    [0x3c, 0xffffffff],
    [520, 0xffffffff],
    [524, 0xffffffff],
    [780, 0xffffffff],
    [792, 0xffffffff],
    [796, 0xffffffff],
    [880, 0xffffffff],
  ]) {
    const changed = Buffer.from(bytes);
    changed.writeUInt32LE(value, offset);
    assert.throws(
      () => cliConstants(changed, 'Rust', 'Protocol'),
      'offset ' + offset,
    );
  }
  assert.throws(() => cliConstants(bytes, 'Rust\0escape', 'Protocol'));
  assert.throws(() => cliConstants(bytes, 'Rust', '../Protocol'));
});

async function prepared(t, module = protocolModule()) {
  const f = await fixture(t, {module});
  const receipt = await f.software.ensure();
  const source = path.join(
    f.paths.software,
    'releases',
    softwareSelectionKey(receipt.selection) + '-' + receipt.inventory.sha256,
  );
  return {...f, source, options: {...f.paths, receipt}, receipt};
}

test('protocol comes from the exact pristine receipt before first boot and ignores patched execution files', async (t) => {
  const f = await prepared(t);
  assert.equal(f.runtime.running, false);
  await fs.writeFile(
    path.join(f.ctx.config.installRoot, moduleName),
    protocolModule({values: [999, 888, 777]}),
  );
  const result = await rustSoftwareProtocol(f.options);
  assert.equal(result.protocol, '2635.289.1');
  assert.equal(result.buildId, '123');
  assert.equal(result.inventorySha256, f.receipt.inventory.sha256);
  assert.equal(result.module, moduleName);
  assert.equal(f.runtime.running, false);
});

test('protocol rejects an unrelated application, unknown layout and unsupported literal values', async (t) => {
  const f = await prepared(t, protocolModule({namespace: 'Unrelated'}));
  await assert.rejects(rustSoftwareProtocol(f.options), /no unambiguous/);
  await assert.rejects(
    rustSoftwareProtocol({
      ...f.options,
      receipt: {
        ...f.receipt,
        selection: {...f.receipt.selection, application: 'other'},
      },
    }),
    /another application/,
  );
  const bad = await prepared(t, protocolModule({values: [2635, 65536, 1]}));
  await assert.rejects(rustSoftwareProtocol(bad.options), /unsupported/);
});

test('pristine module reads reject tampering, changed manifests, linked files and linked parents', async (t) => {
  const f = await prepared(t),
    file = path.join(f.source, moduleName),
    original = await fs.readFile(file);
  const changed = Buffer.from(original);
  changed[1000] ^= 1;
  await fs.writeFile(file, changed);
  await assert.rejects(
    rustSoftwareProtocol(f.options),
    /differs from its pristine/,
  );
  await fs.writeFile(file, original);
  const link = path.join(f.root, 'linked-module');
  await fs.rename(file, link);
  await fs.symlink(link, file);
  await assert.rejects(readSoftwareModule({...f.options, name: moduleName}));
  await fs.unlink(file);
  await fs.link(link, file);
  await assert.rejects(
    readSoftwareModule({...f.options, name: moduleName}),
    /unsafe/,
  );
  await fs.unlink(file);
  await fs.rename(link, file);
  const parent = path.dirname(file),
    retained = parent + '-retained';
  await fs.rename(parent, retained);
  await fs.symlink(retained, parent, 'dir');
  await assert.rejects(
    readSoftwareModule({...f.options, name: moduleName}),
    /linked directories/,
  );
  await fs.unlink(parent);
  await fs.rename(retained, parent);
  const key =
    softwareSelectionKey(f.receipt.selection) +
    '-' +
    f.receipt.inventory.sha256;
  const manifestFile = path.join(f.paths.control, 'inventories', key + '.json'),
    manifest = JSON.parse(await fs.readFile(manifestFile));
  manifest.files.find((file) => file.name === moduleName).sha256 = 'a'.repeat(
    64,
  );
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(rustSoftwareProtocol(f.options), /inventory differs/);
});
