import test from 'node:test';
import assert from 'node:assert/strict';
import {packagedCarbonHooks} from '../applications/rust/mod-components.js';
import {
  carbonHookPaths,
  carbonHooksReceipt,
} from '../applications/rust/mod-layout.js';
const binding = {
  buildId: '26139947',
  protocol: '2635.289.1',
  packageSha256: 'a'.repeat(64),
};
const files = () =>
  carbonHookPaths.map((name) => ({
    name,
    data: Buffer.from('synthetic assembly ' + name),
  }));
test('packaged Carbon hook identities bind both verified components to one exact game build and archive', () => {
  const source = files(),
    receipt = packagedCarbonHooks(binding, source);
  assert.deepEqual(carbonHooksReceipt(receipt), receipt);
  assert.equal(receipt.buildId, binding.buildId);
  assert.equal(receipt.packageSha256, binding.packageSha256);
  const changed = files();
  changed[0].data = Buffer.from('changed component');
  assert.notEqual(
    packagedCarbonHooks(binding, changed).files[0].sha256,
    receipt.files[0].sha256,
  );
  assert.throws(
    () => packagedCarbonHooks(binding, source.slice(1)),
    /both hook components/,
  );
  assert.throws(
    () => packagedCarbonHooks(binding, [...source, source[0]]),
    /both hook components/,
  );
});
test('hook identities reject injected paths, extra components, unbounded bytes and ambiguous metadata', () => {
  const receipt = packagedCarbonHooks(binding, files());
  for (const change of [
    {protocol: '../other'},
    {protocol: '99999.1.1'},
    {buildId: 'public'},
    {packageSha256: 'bad'},
    {url: 'https://other.test'},
    {files: receipt.files.toReversed()},
    {files: [...receipt.files, receipt.files[0]]},
    {
      files: [
        {...receipt.files[0], size: 16 * 1024 ** 2 + 1},
        receipt.files[1],
      ],
    },
    {files: [{...receipt.files[0], name: '../outside'}, receipt.files[1]]},
  ])
    assert.throws(() => carbonHooksReceipt({...receipt, ...change}));
});
