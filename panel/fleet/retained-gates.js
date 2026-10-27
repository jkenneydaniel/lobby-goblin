import {assert} from '../common.js';
export async function retainedGates(
  read,
  names,
  phases = ['complete', 'recovered'],
) {
  for (const name of names) {
    const value = await read(name);
    assert(
      !value || phases.includes(value.phase),
      'An interrupted application change needs manual recovery review before copying.',
      409,
    );
  }
}
