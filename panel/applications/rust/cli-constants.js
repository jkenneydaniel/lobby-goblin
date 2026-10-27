// ECMA-335 II.22/II.24: inspect literal integer metadata without loading or
// executing managed code. Only optimized tables and bounded heaps are accepted.
// https://www.ecma-international.org/wp-content/uploads/ECMA-335_6th_edition_june_2012.pdf
import assert from 'node:assert/strict';

export function cliConstants(bytes, namespace, typeName) {
  assert.ok(
    typeof namespace === 'string' &&
      namespace.length <= 256 &&
      !namespace.includes('\0') &&
      typeof typeName === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(typeName),
  );
  assert.ok(
    Buffer.isBuffer(bytes) &&
      bytes.length >= 512 &&
      bytes.length <= 64 * 1024 ** 2,
  );
  function range(at, size, end = bytes.length) {
    assert.ok(
      Number.isSafeInteger(at) &&
        Number.isSafeInteger(size) &&
        at >= 0 &&
        size >= 0 &&
        at + size <= end &&
        end <= bytes.length,
      'Invalid CLI metadata bounds',
    );
    return at;
  }
  const u16 = (at) => bytes.readUInt16LE(range(at, 2));
  const u32 = (at) => bytes.readUInt32LE(range(at, 4));
  assert.equal(u16(0), 0x5a4d);
  const pe = u32(0x3c);
  assert.equal(u32(pe), 0x4550);
  const sections = u16(pe + 6),
    optional = pe + 24,
    optionalBytes = u16(pe + 20),
    magic = u16(optional);
  assert.ok(sections > 0 && sections <= 96 && [0x10b, 0x20b].includes(magic));
  range(optional, optionalBytes);
  const directories = optional + (magic === 0x10b ? 96 : 112);
  assert.ok(
    optionalBytes >= directories - optional + 15 * 8 &&
      u32(directories - 4) >= 15,
  );
  const sectionTable = optional + optionalBytes;
  range(sectionTable, sections * 40);
  function rva(value, size) {
    const matches = [];
    for (let i = 0; i < sections; i++) {
      const header = sectionTable + i * 40,
        start = u32(header + 12),
        length = u32(header + 16);
      if (value >= start && value + size <= start + length)
        matches.push(u32(header + 20) + value - start);
    }
    assert.equal(matches.length, 1, 'Ambiguous CLI section');
    return range(matches[0], size);
  }
  assert.ok(u32(directories + 14 * 8 + 4) >= 72, 'Missing CLI header');
  const cli = rva(u32(directories + 14 * 8), 72);
  assert.ok(u32(cli) >= 72);
  const metadataSize = u32(cli + 12),
    metadata = rva(u32(cli + 8), metadataSize),
    metadataEnd = metadata + metadataSize;
  assert.equal(u32(metadata), 0x424a5342);
  const versionSize = u32(metadata + 12);
  assert.ok(versionSize > 0 && versionSize <= 256);
  let cursor = metadata + ((16 + versionSize + 3) & ~3);
  range(cursor, 4, metadataEnd);
  const streamCount = u16(cursor + 2),
    streams = new Map();
  assert.ok(streamCount > 0 && streamCount <= 64);
  cursor += 4;
  for (let i = 0; i < streamCount; i++) {
    range(cursor, 9, metadataEnd);
    const start = metadata + u32(cursor),
      size = u32(cursor + 4),
      nameAt = cursor + 8;
    const part = bytes.subarray(nameAt, Math.min(nameAt + 32, metadataEnd)),
      position = part.indexOf(0),
      zero = position < 0 ? -1 : nameAt + position;
    assert.ok(zero >= nameAt && zero - nameAt < 32 && zero < metadataEnd);
    const name = bytes.toString('ascii', nameAt, zero);
    assert.ok(!streams.has(name));
    range(start, size, metadataEnd);
    streams.set(name, {start, size, end: start + size});
    cursor = nameAt + ((zero - nameAt + 1 + 3) & ~3);
  }
  let previousEnd = cursor;
  for (const stream of [...streams.values()].sort(
    (a, b) => a.start - b.start,
  )) {
    assert.ok(stream.start >= previousEnd, 'Overlapping CLI metadata streams');
    previousEnd = stream.end;
  }
  for (const required of ['#~', '#Strings', '#Blob'])
    assert.ok(streams.has(required), 'Missing optimized CLI metadata');
  const tables = streams.get('#~'),
    strings = streams.get('#Strings'),
    blobs = streams.get('#Blob');
  range(tables.start, 24, tables.end);
  assert.ok(
    bytes[tables.start + 4] === 2 &&
      bytes[tables.start + 5] === 0 &&
      !(bytes[tables.start + 6] & ~7),
    'Unsupported CLI metadata version',
  );
  const heap = bytes[tables.start + 6],
    valid = bytes.readBigUInt64LE(tables.start + 8),
    rows = Array(64).fill(0);
  cursor = tables.start + 24;
  let totalRows = 0;
  for (let i = 0; i < 64; i++)
    if (valid & (1n << BigInt(i))) {
      range(cursor, 4, tables.end);
      rows[i] = u32(cursor);
      cursor += 4;
      totalRows += rows[i];
      assert.ok(totalRows <= 2000000 && rows[i] <= 1000000);
    }
  assert.ok(
    rows[2] <= 100000 && rows[3] === 0 && rows[5] === 0 && rows[7] === 0,
    'Unsupported CLI pointer tables',
  );
  const s = heap & 1 ? 4 : 2,
    g = heap & 2 ? 4 : 2,
    b = heap & 4 ? 4 : 2;
  const index = (table) => (rows[table] < 65536 ? 2 : 4);
  const coded = (bits, candidates) =>
    Math.max(...candidates.map((t) => rows[t])) < 2 ** (16 - bits) ? 2 : 4;
  const typeRef = coded(2, [2, 1, 27]);
  const sizes = [
    2 + s + 3 * g,
    coded(2, [0, 26, 35, 1]) + 2 * s,
    4 + 2 * s + typeRef + index(4) + index(6),
    index(4),
    2 + s + b,
    index(6),
    8 + s + b + index(8),
    index(8),
    4 + s,
    index(2) + typeRef,
    coded(3, [2, 1, 26, 6, 27]) + s + b,
    2 + coded(2, [4, 8, 23]) + b,
  ];
  const offsets = [];
  for (let i = 0; i <= 11; i++) {
    offsets[i] = cursor;
    range(cursor, rows[i] * sizes[i], tables.end);
    cursor += rows[i] * sizes[i];
  }
  const readIndex = (at, width) => (width === 2 ? u16(at) : u32(at));
  function text(value) {
    assert.ok(value >= 0 && value < strings.size);
    const start = strings.start + value,
      part = bytes.subarray(start, Math.min(strings.end, start + 1025)),
      position = part.indexOf(0),
      zero = position < 0 ? -1 : start + position;
    assert.ok(zero >= start && zero < strings.end && zero - start <= 1024);
    return bytes.toString('utf8', start, zero);
  }
  function blob(value) {
    let at = blobs.start + value;
    range(at, 1, blobs.end);
    const first = bytes[at++];
    let size;
    if (!(first & 0x80)) size = first;
    else if ((first & 0xc0) === 0x80) {
      range(at, 1, blobs.end);
      size = ((first & 0x3f) << 8) | bytes[at++];
    } else {
      assert.equal(first & 0xe0, 0xc0);
      range(at, 3, blobs.end);
      size =
        (first & 0x1f) * 2 ** 24 +
        bytes[at++] * 65536 +
        bytes[at++] * 256 +
        bytes[at++];
    }
    range(at, size, blobs.end);
    return bytes.subarray(at, at + size);
  }
  const matches = [];
  const fieldListAt = (row) =>
    offsets[2] + (row - 1) * sizes[2] + 4 + 2 * s + typeRef;
  for (let row = 1; row <= rows[2]; row++) {
    const at = offsets[2] + (row - 1) * sizes[2];
    if (
      text(readIndex(at + 4, s)) === typeName &&
      text(readIndex(at + 4 + s, s)) === namespace
    )
      matches.push(row);
  }
  assert.ok(matches.length <= 1, 'Ambiguous CLI type');
  if (!matches.length) return null;
  const type = matches[0],
    first = readIndex(fieldListAt(type), index(4)),
    end =
      type === rows[2]
        ? rows[4] + 1
        : readIndex(fieldListAt(type + 1), index(4));
  assert.ok(
    first >= 1 && end >= first && end <= rows[4] + 1 && end - first <= 10000,
  );
  const fields = new Map();
  for (let row = first; row < end; row++) {
    const at = offsets[4] + (row - 1) * sizes[4],
      flags = u16(at);
    if ((flags & 0x50) === 0x50) fields.set(row, text(readIndex(at + 2, s)));
  }
  const constants = new Map(),
    parentWidth = coded(2, [4, 8, 23]);
  for (let row = 0; row < rows[11]; row++) {
    const at = offsets[11] + row * sizes[11],
      kind = bytes[at],
      parent = readIndex(at + 2, parentWidth);
    if ((parent & 3) !== 0 || !fields.has(parent >>> 2)) continue;
    if (![0x08, 0x09].includes(kind)) continue;
    const name = fields.get(parent >>> 2),
      value = blob(readIndex(at + 2 + parentWidth, b));
    assert.equal(value.length, 4);
    assert.ok(!constants.has(name));
    constants.set(
      name,
      kind === 0x08 ? value.readInt32LE(0) : value.readUInt32LE(0),
    );
  }
  return constants;
}
