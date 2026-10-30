// Shared export/delivery contract. Lua collection is checked against these
// values by the capacity regression test; stored map format remains version 1.
export const mapObjectLimit = 160000;
export const mapChunkLimit = 4096;
export const mapExportByteLimit = 48 * 1024 * 1024;
