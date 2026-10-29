import {spatialIndex} from './map-spatial.js';
import {overviewIndex} from './map-lod.js';
const colors = {
  resources: '#77b7c7',
  railways: '#dad3b8',
  enemies: '#e75e51',
  buildings: '#e5c985',
  power: '#77c9ea',
};
// Accept the first export format as well as current byte-valued map colors.
const rgb = (color) =>
  'rgb(' +
  color
    .map((value) =>
      Math.max(
        0,
        Math.min(
          255,
          Math.round(value / (color.some((n) => n > 255) ? 255 : 1)),
        ),
      ),
    )
    .join(',') +
  ')';
export function mountMap(payload, view = null) {
  const map = payload.snapshot,
    canvas = document.querySelector('#world-map');
  if (!canvas || !map) return () => {};
  const base = document.createElement('canvas'),
    context = base.getContext('2d'),
    overlay = canvas.getContext('2d'),
    resourceColors = new Map(),
    layers = new Set(
      view?.layers || [
        'resources',
        'railways',
        'enemies',
        'buildings',
        'players',
        'pins',
      ],
    );
  let width = 1,
    height = 1,
    scale = view?.scale || 1,
    cx = view?.cx || 0,
    cy = view?.cy || 0,
    frame = null,
    dragged = false,
    dirty = true,
    disposed = false,
    pixelRatio = Math.min(2, devicePixelRatio || 1);
  const pointers = new Map();
  let gesture = null;
  let livePositions = null;
  const currentPlayers = () =>
    livePositions?.enabled
      ? livePositions.state === 'live' &&
        livePositions.world === map.world &&
        livePositions.seed === map.seed
        ? livePositions.players.filter(
            (player) => player.surface === map.surface,
          )
        : []
      : map.players;
  const chunks = map.chunks,
    terrainIndex = spatialIndex(chunks, 32, (chunk) => ({
      x: chunk.x * 32,
      y: chunk.y * 32,
    })),
    entities = map.entities,
    extent = entities.reduce(
      (largest, item) =>
        Math.max(
          largest,
          Number.isFinite(item.w) ? item.w : 0,
          Number.isFinite(item.h) ? item.h : 0,
        ),
      0,
    ),
    objectIndex = spatialIndex(entities),
    overview = overviewIndex(entities, objectIndex),
    palette = map.palette?.map((tile) => rgb(tile.color)),
    atlas = chunks.length ? document.createElement('canvas') : null,
    columns = Math.ceil(Math.sqrt(chunks.length)),
    tiles = new Map(chunks.map((chunk, i) => [chunk, i]));
  // One small atlas replaces thousands of canvas objects. Decode terrain only
  // when first visible, using row spans rather than one draw call per tile.
  if (atlas) {
    atlas.width = columns * 16;
    atlas.height = Math.ceil(chunks.length / columns) * 16;
  }
  const painted = new Set();
  function terrain(chunk) {
    const index = tiles.get(chunk),
      x = (index % columns) * 16,
      y = Math.floor(index / columns) * 16;
    if (painted.has(index)) return [x, y];
    const ctx = atlas.getContext('2d');
    let cell = 0;
    for (let i = 0; i < chunk.tiles.length; i += 2) {
      ctx.fillStyle = palette[chunk.tiles[i] - 1];
      let remaining = chunk.tiles[i + 1];
      while (remaining > 0) {
        const span = Math.min(remaining, 16 - (cell % 16));
        ctx.fillRect(x + (cell % 16), y + Math.floor(cell / 16), span, 1);
        cell += span;
        remaining -= span;
      }
    }
    painted.add(index);
    return [x, y];
  }
  const pos = (x, y) => [
    (x - cx) * scale + width / 2,
    (y - cy) * scale + height / 2,
  ];
  const world = (x, y) => [
    (x - width / 2) / scale + cx,
    (y - height / 2) / scale + cy,
  ];
  const visible = (entity) =>
    layers.has(entity.category) || (entity.power && layers.has('power'));
  const enemyRadius = (entity) =>
    Math.max(
      entity.type === 'unit' ? 1.5 : entity.type === 'unit-spawner' ? 4 : 3,
      (Math.max(entity.w, entity.h) * scale) / 2,
    );
  function drawBase() {
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = '#151f20';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = false;
    const [left, top] = world(0, 0),
      [right, bottom] = world(width, height),
      margin = extent + 8 / scale,
      objects = overview.query(
        left - margin,
        top - margin,
        right + margin,
        bottom + margin,
        scale,
      );
    for (const chunk of terrainIndex.query(
      left - 32,
      top - 32,
      right,
      bottom,
    )) {
      const [x, y] = pos(chunk.x * 32, chunk.y * 32),
        size = 32 * scale;
      if (x + size < 0 || y + size < 0 || x > width || y > height) continue;
      const [sx, sy] = terrain(chunk);
      context.drawImage(atlas, sx, sy, 16, 16, x, y, size + 0.5, size + 0.5);
      if (layers.has('pollution') && chunk.pollution > 0) {
        context.fillStyle = `rgba(224,64,42,${Math.min(0.65, Math.log1p(chunk.pollution) / 12)})`;
        context.fillRect(x, y, size, size);
      }
    }
    for (const entity of objects) {
      if (entity.category === 'enemies' || !visible(entity)) continue;
      const [x, y] = pos(entity.x, entity.y),
        w = Math.max(entity.w * scale, entity.category === 'resources' ? 1 : 2),
        h = Math.max(entity.h * scale, 2);
      if (x + w < 0 || y + h < 0 || x - w > width || y - h > height) continue;
      context.fillStyle =
        entity.power && layers.has('power')
          ? colors.power
          : entity.category === 'resources'
            ? resourceColor(entity.color)
            : colors[entity.category];
      context.fillRect(x - w / 2, y - h / 2, w, h);
    }
    // Keep threats legible above resources/buildings, including at overview zoom.
    if (layers.has('enemies'))
      for (const entity of objects) {
        if (entity.category !== 'enemies') continue;
        const [x, y] = pos(entity.x, entity.y),
          unit = entity.type === 'unit',
          base = entity.type === 'unit-spawner',
          radius = enemyRadius(entity);
        if (
          x + radius < 0 ||
          y + radius < 0 ||
          x - radius > width ||
          y - radius > height
        )
          continue;
        context.fillStyle = colors.enemies;
        context.strokeStyle = '#291d1b';
        context.lineWidth = 1.5;
        context.beginPath();
        if (base) {
          context.moveTo(x, y - radius);
          context.lineTo(x + radius, y);
          context.lineTo(x, y + radius);
          context.lineTo(x - radius, y);
          context.closePath();
        } else context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
        if (!unit) context.stroke();
      }
  }
  function resourceColor(color) {
    const key = color.join(',');
    if (!resourceColors.has(key)) resourceColors.set(key, rgb(color));
    return resourceColors.get(key);
  }
  function draw() {
    frame = null;
    if (disposed || !base.width || !base.height) return;
    if (dirty) {
      drawBase();
      dirty = false;
    }
    overlay.setTransform(1, 0, 0, 1, 0, 0);
    overlay.drawImage(base, 0, 0);
    overlay.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    function marker(item, color, label) {
      const [x, y] = pos(item.x, item.y);
      if (x < 0 || y < 0 || x > width || y > height) return;
      overlay.fillStyle = color;
      overlay.beginPath();
      overlay.arc(x, y, 4, 0, Math.PI * 2);
      overlay.fill();
      overlay.font = '11px Segoe UI, sans-serif';
      overlay.lineWidth = 3;
      overlay.strokeStyle = '#17211e';
      overlay.strokeText(label, x + 8, y - 7);
      overlay.fillText(label, x + 8, y - 7);
    }
    if (layers.has('players'))
      for (const player of currentPlayers())
        marker(
          player,
          livePositions?.enabled ? rgb(player.color) : '#d4c994',
          player.name + (livePositions?.enabled ? '' : ' (saved)'),
        );
    if (layers.has('pins')) {
      for (const pin of map.tags) marker(pin, '#98ded4', pin.label);
      for (const pin of payload.pins) marker(pin, '#f4bc62', pin.label);
    }
    const length =
      [10, 50, 100, 500, 1000, 5000].find((value) => value * scale >= 65) ||
      10000;
    overlay.strokeStyle = '#dce5d6';
    overlay.lineWidth = 2;
    overlay.beginPath();
    overlay.moveTo(20, height - 29);
    overlay.lineTo(20 + length * scale, height - 29);
    overlay.stroke();
    overlay.fillStyle = '#dce5d6';
    overlay.font = '10px Segoe UI, sans-serif';
    overlay.fillText(length + ' tiles', 20, height - 13);
  }
  function schedule(rebuild = true) {
    if (disposed) return;
    if (rebuild) dirty = true;
    if (frame === null) frame = requestAnimationFrame(draw);
  }
  function fit() {
    if (!chunks.length) return;
    const xs = chunks.map((chunk) => chunk.x * 32),
      ys = chunks.map((chunk) => chunk.y * 32),
      left = Math.min(...xs),
      top = Math.min(...ys),
      right = Math.max(...xs) + 32,
      bottom = Math.max(...ys) + 32;
    cx = (left + right) / 2;
    cy = (top + bottom) / 2;
    scale = Math.max(
      0.02,
      Math.min(width / (right - left + 64), height / (bottom - top + 64)),
    );
    schedule();
  }
  function zoom(factor, x = width / 2, y = height / 2) {
    const before = world(x, y);
    scale = Math.min(24, Math.max(0.02, scale * factor));
    const after = world(x, y);
    cx += before[0] - after[0];
    cy += before[1] - after[1];
    schedule();
  }
  function select(x, y) {
    const [wx, wy] = world(x, y);
    const margin = extent + 8 / scale,
      nearby = objectIndex.query(
        wx - margin,
        wy - margin,
        wx + margin,
        wy + margin,
      );
    document.querySelector('#map-coordinates').textContent =
      `X ${Math.round(wx)} · Y ${Math.round(wy)}`;
    const pinForm = document.querySelector('#pin-form');
    if (pinForm) {
      pinForm.elements.x.value = Math.round(wx);
      pinForm.elements.y.value = Math.round(wy);
    }
    if (layers.has('players')) {
      const player = currentPlayers().find(
        (item) => Math.hypot(item.x - wx, item.y - wy) < 10 / scale,
      );
      if (player) {
        document.querySelector('#map-selection-title').textContent =
          player.name;
        document.querySelector('#map-selection-detail').textContent =
          `${livePositions?.enabled ? 'Live player' : 'Saved player position'} · X ${player.x.toFixed(1)} · Y ${player.y.toFixed(1)} · ${player.surface || map.surface}`;
        return;
      }
    }
    let nearest = null,
      distance = Infinity;
    if (layers.has('enemies'))
      for (const item of nearby) {
        if (item.category !== 'enemies') continue;
        const d = Math.hypot(item.x - wx, item.y - wy);
        if (d * scale <= enemyRadius(item) + 2 && d < distance) {
          nearest = item;
          distance = d;
        }
      }
    if (!nearest)
      for (const item of nearby) {
        if (!visible(item)) continue;
        const d = Math.hypot(item.x - wx, item.y - wy);
        if (d < Math.max(item.w, item.h, 8 / scale) && d < distance) {
          nearest = item;
          distance = d;
        }
      }
    const title = document.querySelector('#map-selection-title'),
      detail = document.querySelector('#map-selection-detail');
    title.textContent = nearest
      ? nearest.name.replaceAll('-', ' ')
      : 'Selected location';
    detail.textContent = nearest
      ? [
          `X ${nearest.x.toFixed(1)} · Y ${nearest.y.toFixed(1)}`,
          nearest.category === 'enemies'
            ? 'Enemy ' +
              (nearest.type === 'unit-spawner'
                ? 'base'
                : nearest.type === 'unit'
                  ? 'unit'
                  : 'worm') +
              ' · Saved position'
            : '',
          nearest.recipe
            ? 'Recipe: ' + nearest.recipe.replaceAll('-', ' ')
            : '',
          nearest.amount != null
            ? 'Remaining resource: ' + nearest.amount.toLocaleString()
            : '',
          nearest.power ? 'Power equipment' : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : `X ${Math.round(wx)} · Y ${Math.round(wy)}. Select an object for details.`;
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom(Math.exp(-event.deltaY * 0.0015), ...point(event));
    },
    {passive: false},
  );
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point(event));
    dragged = false;
    gesture =
      pointers.size === 2
        ? {
            distance: Math.hypot(
              ...pointers
                .values()
                .next()
                .value.map((v, i) => v - [...pointers.values()][1][i]),
            ),
          }
        : null;
  });
  canvas.addEventListener('pointermove', (event) => {
    const p = point(event),
      previous = pointers.get(event.pointerId);
    document.querySelector('#map-coordinates').textContent = world(...p)
      .map((n, i) => (i ? 'Y ' : 'X ') + Math.round(n))
      .join(' · ');
    if (!previous) return;
    pointers.set(event.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()],
        distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (gesture?.distance > 0)
        zoom(distance / gesture.distance, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      gesture = {distance};
      dragged = true;
    } else {
      const dx = p[0] - previous[0],
        dy = p[1] - previous[1];
      cx -= dx / scale;
      cy -= dy / scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
      schedule();
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!dragged && pointers.size === 1) select(...point(event));
    pointers.delete(event.pointerId);
    gesture = null;
  });
  canvas.addEventListener('pointercancel', (event) => {
    pointers.delete(event.pointerId);
    gesture = null;
  });
  canvas.addEventListener('keydown', (event) => {
    if (
      [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        '+',
        '=',
        '-',
        '0',
      ].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === '0') fit();
      else if (['+', '=', '-'].includes(event.key))
        zoom(event.key === '-' ? 0.8 : 1.25);
      else {
        cx +=
          (event.key === 'ArrowRight'
            ? 80
            : event.key === 'ArrowLeft'
              ? -80
              : 0) / scale;
        cy +=
          (event.key === 'ArrowDown' ? 80 : event.key === 'ArrowUp' ? -80 : 0) /
          scale;
        schedule();
      }
    }
  });
  document.querySelectorAll('[data-map-layer]').forEach((input) => {
    input.checked = layers.has(input.dataset.mapLayer);
    input.addEventListener('change', () => {
      if (input.checked) layers.add(input.dataset.mapLayer);
      else layers.delete(input.dataset.mapLayer);
      schedule(!['players', 'pins'].includes(input.dataset.mapLayer));
    });
  });
  document.querySelector('#map-fit').addEventListener('click', fit);
  document.querySelector('#map-base').addEventListener('click', () => {
    cx = 0;
    cy = 0;
    scale = 1.5;
    schedule();
  });
  document
    .querySelector('#map-plus')
    .addEventListener('click', () => zoom(1.5));
  document
    .querySelector('#map-minus')
    .addEventListener('click', () => zoom(1 / 1.5));
  const resize = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    if (disposed || rect.width <= 0 || rect.height <= 0) return;
    width = rect.width;
    height = rect.height;
    pixelRatio = Math.min(2, devicePixelRatio || 1);
    canvas.width = base.width = Math.round(width * pixelRatio);
    canvas.height = base.height = Math.round(height * pixelRatio);
    schedule();
  });
  resize.observe(canvas);
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  if (view) schedule();
  else fit();
  const cleanup = () => {
    disposed = true;
    resize.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
  };
  cleanup.getView = () => ({cx, cy, scale, layers: [...layers]});
  cleanup.isInteracting = () => pointers.size > 0;
  const playerKey = () =>
    JSON.stringify([!!livePositions?.enabled, currentPlayers()]);
  let playersDrawn = playerKey();
  cleanup.updatePlayers = (value) => {
    livePositions = value;
    const next = playerKey();
    if (next !== playersDrawn) {
      playersDrawn = next;
      schedule(false);
    }
  };
  cleanup.updatePins = (pins) => {
    payload.pins = pins;
    schedule(false);
  };
  cleanup.centerPin = (id) => {
    const pin = payload.pins.find((item) => item.id === id);
    if (pin) {
      cx = pin.x;
      cy = pin.y;
      scale = 2;
      schedule();
    }
  };
  cleanup.centerPlayer = (name) => {
    const player = currentPlayers().find((item) => item.name === name);
    if (player) {
      cx = player.x;
      cy = player.y;
      scale = Math.max(scale, 1.5);
      schedule();
    }
  };
  return cleanup;
}
