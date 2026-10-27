// Derive exact component identities from an already checksum-verified package.
// No game-start download, protocol fallback or independently mutable CDN bytes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {carbonHookPaths, carbonHooksReceipt} from './mod-layout.js';
export function packagedCarbonHooks({buildId, protocol, packageSha256}, files) {
  return carbonHooksReceipt({
    format: 1,
    buildId,
    protocol,
    packageSha256,
    files: carbonHookPaths.map((name) => {
      const matches = files.filter((file) => file.name === name);
      assert.equal(
        matches.length,
        1,
        'The verified Carbon package needs both hook components.',
      );
      const file = matches[0];
      assert.ok(
        Buffer.isBuffer(file.data),
        'Carbon hook component has no verified bytes.',
      );
      return {
        name,
        size: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
      };
    }),
  });
}
