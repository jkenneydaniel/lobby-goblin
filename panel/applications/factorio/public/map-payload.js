// Wire format only. Stored maps and the renderer continue to use map version 1.
export const mapPayloadFormat = 'goblin-map/1';
export const mapPayloadLimit = 32 * 1024 * 1024;
const own = (object, key) => Object.hasOwn(object, key);
const check = (condition) => {
  if (!condition) throw new Error('Invalid compact map payload.');
};
const record = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const common = ['name', 'type', 'w', 'h', 'category', 'power', 'color'];

export function encodeMapPayload(snapshot) {
  const {entities, ...metadata} = snapshot;
  check(Array.isArray(entities) && entities.length <= 80000);
  const prototypes = [],
    recipes = [],
    types = new Map(),
    names = new Map();
  const rows = entities.map((entity) => {
    const {x, y, amount, recipe, ...prototype} = entity;
    check(Number.isFinite(x) && Number.isFinite(y));
    // Sorting makes equivalent dictionaries independent of JSON property order.
    const key = JSON.stringify(
      Object.keys(prototype)
        .sort()
        .map((key) => [key, prototype[key]]),
    );
    let id = types.get(key);
    if (id === undefined) {
      id = prototypes.length;
      types.set(key, id);
      prototypes.push(prototype);
    }
    const row = [id, x, y],
      flags = (own(entity, 'amount') ? 1 : 0) | (own(entity, 'recipe') ? 2 : 0);
    if (flags) row.push(flags);
    if (flags & 1) row.push(amount);
    if (flags & 2) {
      const key = JSON.stringify(recipe);
      let index = names.get(key);
      if (index === undefined) {
        index = recipes.length;
        names.set(key, index);
        recipes.push(recipe);
      }
      row.push(index);
    }
    return row;
  });
  return {format: mapPayloadFormat, metadata, prototypes, recipes, rows};
}

export function decodeMapPayload(value) {
  check(
    value?.format === mapPayloadFormat &&
      record(value.metadata) &&
      value.metadata.version === 1,
  );
  check(
    Array.isArray(value.rows) &&
      value.rows.length <= 80000 &&
      Array.isArray(value.prototypes) &&
      value.prototypes.length <= 80000 &&
      Array.isArray(value.recipes) &&
      value.recipes.length <= 80000,
  );
  check(
    Array.isArray(value.metadata.chunks) &&
      value.metadata.chunks.length <= 2048 &&
      Array.isArray(value.metadata.palette) &&
      value.metadata.palette.length < 1000,
  );
  const fast = value.prototypes.map((prototype) => {
    check(
      record(prototype) &&
        !['x', 'y', 'amount', 'recipe'].some((key) => own(prototype, key)),
    );
    return (
      Object.keys(prototype).length === common.length &&
      common.every((key) => own(prototype, key))
    );
  });
  const entities = value.rows.map((row) => {
    check(
      Array.isArray(row) &&
        row.length >= 3 &&
        Number.isInteger(row[0]) &&
        row[0] >= 0 &&
        row[0] < value.prototypes.length &&
        Number.isFinite(row[1]) &&
        Number.isFinite(row[2]),
    );
    const flags = row.length === 3 ? 0 : row[3];
    check(
      Number.isInteger(flags) &&
        flags >= 0 &&
        flags <= 3 &&
        row.length ===
          (flags ? 4 : 3) + (flags & 1 ? 1 : 0) + (flags & 2 ? 1 : 0),
    );
    const p = value.prototypes[row[0]],
      x = row[1],
      y = row[2];
    const entity = fast[row[0]]
      ? {
          name: p.name,
          type: p.type,
          x,
          y,
          w: p.w,
          h: p.h,
          category: p.category,
          power: p.power,
          color: p.color,
        }
      : {...p, x, y};
    let cursor = 4;
    if (flags & 1) entity.amount = row[cursor++];
    if (flags & 2) {
      const id = row[cursor];
      check(Number.isInteger(id) && id >= 0 && id < value.recipes.length);
      entity.recipe = value.recipes[id];
    }
    return entity;
  });
  return {...value.metadata, entities};
}

export async function readMapPayload(bytes) {
  check(bytes.byteLength <= mapPayloadLimit);
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let size = 0,
    text = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      check(size <= mapPayloadLimit);
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    return decodeMapPayload(JSON.parse(text));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
