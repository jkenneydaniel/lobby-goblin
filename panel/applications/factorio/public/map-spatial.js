// Immutable snapshot index. Preserve export order so overlapping objects and
// equally close selections keep the same behavior as the original renderer.
export function spatialIndex(items, cellSize = 128, position = (item) => item) {
  const cells = new Map(),
    points = items.map(position);
  for (let i = 0; i < items.length; i++) {
    const {x, y} = points[i],
      key = Math.floor(x / cellSize) + ',' + Math.floor(y / cellSize);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  }
  return {
    query(left, top, right, bottom) {
      const x0 = Math.floor(left / cellSize),
        y0 = Math.floor(top / cellSize),
        x1 = Math.floor(right / cellSize),
        y1 = Math.floor(bottom / cellSize);
      // An overview or widely separated chunks must not walk a huge empty grid.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) >= cells.size)
        return items.filter((_, i) => {
          const p = points[i];
          return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
        });
      const ids = [];
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          for (const i of cells.get(x + ',' + y) || []) {
            const p = points[i];
            if (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom)
              ids.push(i);
          }
      ids.sort((a, b) => a - b);
      return ids.map((i) => items[i]);
    },
  };
}
