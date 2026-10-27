import {assert} from '../../common.js';
// Rust's procedural-map seed is signed 32-bit. Older panel registrations used
// uint32 random seeds; Rust clamps those oversized values to this maximum.
export const rustSeedMaximum = 0x7fffffff;
export function rustSnapshotSeed(registered) {
  assert(Number.isInteger(registered) && registered >= 1 && registered <= 0xffffffff,
    'Rust snapshot has an invalid registered seed.', 409);
  return Math.min(registered, rustSeedMaximum);
}
