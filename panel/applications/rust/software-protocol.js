import {assert} from '../../common.js';
import {softwareReceipt} from '../../core/software-installation.js';
import {readSoftwareModule} from '../../core/software-module.js';
import {cliConstants} from './cli-constants.js';

// Inspect only reviewed fixed module names in the private pristine install.
// Rust's execution tree can contain framework-patched assemblies and is never
// an authority for the protocol of a different candidate Steam build.
export async function rustSoftwareProtocol({
  software,
  control,
  receipt: value,
}) {
  const receipt = softwareReceipt(value);
  assert(
    receipt.selection.application === 'rust' &&
      receipt.selection.provider === 'steamcmd' &&
      receipt.selection.source.appId === '258550',
    'Protocol metadata belongs to another application.',
    409,
  );
  const matches = [];
  for (const file of [
    'Rust.Global.dll',
    'Rust.Data.dll',
    'Assembly-CSharp.dll',
  ]) {
    const module = await readSoftwareModule({
      software,
      control,
      receipt,
      name: 'RustDedicated_Data/Managed/' + file,
    });
    if (!module) continue;
    const values = cliConstants(module.bytes, 'Rust', 'Protocol');
    if (!values) continue;
    const fields = ['network', 'save', 'report'].map((name) =>
      values.get(name),
    );
    assert(
      fields.every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 65535,
      ),
      'Rust protocol constants are missing or unsupported.',
      409,
    );
    matches.push({
      format: 1,
      buildId: receipt.selection.softwareVersion,
      inventorySha256: receipt.inventory.sha256,
      protocol: fields.join('.'),
      module: module.name,
      sha256: module.sha256,
    });
  }
  assert(
    matches.length === 1,
    'This Rust build has no unambiguous supported protocol metadata. Preserve its prepared files for inspection.',
    409,
  );
  return matches[0];
}
