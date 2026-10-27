// A minimal PE/CLI data fixture with literal fields. No method bodies or code.
export function protocolModule({
  namespace = 'Rust',
  type = 'Protocol',
  values = [2635, 289, 1],
} = {}) {
  const strings = Buffer.from(
    '\0' + type + '\0' + namespace + '\0network\0save\0report\0',
  );
  const namespaceAt = type.length + 2,
    networkAt = namespaceAt + namespace.length + 1;
  const names = [networkAt, networkAt + 8, networkAt + 13];
  const blobs = Buffer.alloc(16);
  values.forEach((value, i) => {
    blobs[1 + i * 5] = 4;
    blobs.writeUInt32LE(value, 2 + i * 5);
  });
  const tables = Buffer.alloc(24 + 12 + 14 + 18 + 18);
  tables[4] = 2;
  tables.writeBigUInt64LE((1n << 2n) | (1n << 4n) | (1n << 11n), 8);
  [1, 3, 3].forEach((n, i) => tables.writeUInt32LE(n, 24 + i * 4));
  tables.writeUInt16LE(1, 40);
  tables.writeUInt16LE(namespaceAt, 42);
  tables.writeUInt16LE(1, 46);
  tables.writeUInt16LE(1, 48);
  for (let i = 0; i < 3; i++) {
    tables.writeUInt16LE(0x8056, 50 + i * 6);
    tables.writeUInt16LE(names[i], 52 + i * 6);
    tables[68 + i * 6] = 9;
    tables.writeUInt16LE((i + 1) << 2, 70 + i * 6);
    tables.writeUInt16LE(1 + i * 5, 72 + i * 6);
  }
  const streams = [
    ['#~', tables],
    ['#Strings', strings],
    ['#Blob', blobs],
  ];
  const metadata = Buffer.alloc(512);
  metadata.writeUInt32LE(0x424a5342, 0);
  metadata.writeUInt32LE(4, 12);
  metadata.writeUInt16LE(3, 22);
  let header = 24,
    data = 80;
  for (const [name, bytes] of streams) {
    metadata.writeUInt32LE(data, header);
    metadata.writeUInt32LE(bytes.length, header + 4);
    metadata.write(name, header + 8, 'ascii');
    bytes.copy(metadata, data);
    header += 8 + ((name.length + 4) & ~3);
    data += bytes.length;
  }
  const pe = Buffer.alloc(2048);
  pe.writeUInt16LE(0x5a4d, 0);
  pe.writeUInt32LE(128, 0x3c);
  pe.writeUInt32LE(0x4550, 128);
  pe.writeUInt16LE(1, 134);
  pe.writeUInt16LE(224, 148);
  pe.writeUInt16LE(0x10b, 152);
  pe.writeUInt32LE(16, 244);
  pe.writeUInt32LE(0x2000, 360);
  pe.writeUInt32LE(72, 364);
  pe.writeUInt32LE(0x2000, 388);
  pe.writeUInt32LE(1536, 392);
  pe.writeUInt32LE(512, 396);
  pe.writeUInt32LE(72, 512);
  pe.writeUInt32LE(0x2100, 520);
  pe.writeUInt32LE(metadata.length, 524);
  metadata.copy(pe, 768);
  return pe;
}
