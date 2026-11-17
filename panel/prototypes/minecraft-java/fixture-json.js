// Call only after native JSON syntax validation. Inspect the original text
// because JSON.parse has already collapsed duplicate decoded names.
export function fixtureJsonProblem(text, maxDepth) {
  const frames = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{' || char === '[') {
      frames.push(char === '{' ? {keys: new Set(), key: true} : null);
      if (frames.length > maxDepth) return 'nesting';
    } else if (char === '}' || char === ']') {
      frames.pop();
    } else if (char === ',') {
      if (frames.at(-1)) frames.at(-1).key = true;
    } else if (char === '"') {
      const start = i;
      while (++i < text.length) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const frame = frames.at(-1);
      if (frame?.key) {
        const key = JSON.parse(text.slice(start, i + 1));
        if (frame.keys.has(key)) return 'duplicate';
        frame.keys.add(key);
        frame.key = false;
      }
    }
  }
  return null;
}
