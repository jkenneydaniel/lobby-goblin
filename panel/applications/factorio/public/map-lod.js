import {spatialIndex} from './map-spatial.js';

// Exact objects remain the authority for inspection. At overview scale, many
// subpixel resource/building marks become one occupied cell per visual layer.
// Keep rails, enemies and oversized objects exact; retain only two LOD levels.
export function overviewIndex(items, exact = spatialIndex(items)) {
  const levels = new Map();
  return {
    query(left, top, right, bottom, scale) {
      if (scale >= 0.5) return exact.query(left, top, right, bottom);
      const size = Math.min(
        256,
        Math.max(8, 2 ** Math.ceil(Math.log2(4 / scale))),
      );
      let index = levels.get(size);
      if (!index) {
        const cells = new Map(),
          precise = [];
        for (const item of items) {
          if (
            !['resources', 'buildings'].includes(item.category) ||
            Math.max(item.w, item.h) > size
          ) {
            precise.push(item);
            continue;
          }
          const x = Math.floor(item.x / size),
            y = Math.floor(item.y / size),
            key = [
              x,
              y,
              item.category,
              !!item.power,
              item.category === 'resources' ? item.color.join(',') : '',
            ].join(':');
          if (!cells.has(key))
            cells.set(key, {
              ...item,
              x: (x + 0.5) * size,
              y: (y + 0.5) * size,
              w: size,
              h: size,
              aggregate: true,
              count: 0,
            });
          cells.get(key).count++;
        }
        index = spatialIndex([...cells.values(), ...precise]);
        levels.set(size, index);
        if (levels.size > 2) levels.delete(levels.keys().next().value);
      } else {
        levels.delete(size);
        levels.set(size, index);
      }
      return index.query(left, top, right, bottom);
    },
  };
}
