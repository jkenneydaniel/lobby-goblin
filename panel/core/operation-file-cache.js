import fs from 'node:fs/promises';

// Native workers publish records by rename, including across processes. Reuse
// unchanged observations and drop entries for paths absent from the next scan.
export function operationFileCache() {
  let previous = new Map();
  return async (scan) => {
    const next = new Map();
    const records = await scan(async (file, read) => {
      const stat = await fs.lstat(file, {bigint: true}).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return null;
      const key = [
        stat.dev,
        stat.ino,
        stat.size,
        stat.ctimeNs,
        stat.mtimeNs,
      ].join(':');
      const cached = previous.get(file);
      const entry =
        cached?.key === key ? cached : {key, value: await read(file)};
      next.set(file, entry);
      return entry.value;
    });
    previous = next;
    return records;
  };
}
