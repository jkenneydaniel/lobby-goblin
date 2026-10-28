// Shared release ordering for discovery and presentation. Installation policy stays server-side.
export function version(value) {
  const match = String(value).match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  const core = match.slice(1, 4).map(Number),
    pre = match[4]?.split('.') || [];
  if (
    core.some((n) => !Number.isSafeInteger(n)) ||
    pre.some(
      (s) =>
        /^\d+$/.test(s) &&
        ((s.length > 1 && s[0] === '0') || !Number.isSafeInteger(Number(s))),
    )
  )
    return null;
  return {core, pre};
}
export function compareVersions(left, right) {
  const a = version(left),
    b = version(right);
  if (!a || !b) throw new Error('Invalid version.');
  for (let i = 0; i < 3; i++)
    if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i]);
  if (!a.pre.length || !b.pre.length)
    return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const x = a.pre[i],
      y = b.pre[i];
    if (x === y) continue;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    return nx && ny
      ? Math.sign(Number(x) - Number(y))
      : nx !== ny
        ? nx
          ? -1
          : 1
        : x < y
          ? -1
          : 1;
  }
  return 0;
}
