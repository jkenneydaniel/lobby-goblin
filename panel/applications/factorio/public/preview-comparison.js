import {createEventScope} from './shared/events.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const settingsKey = (value) => JSON.stringify(canonical(value));
const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10];

export function mountPreviewComparison(form, {api, onUse = async () => false}) {
  const aside = form.querySelector('.world-draft-preview'),
    button = form.querySelector('#keep-draft-preview'),
    remove = form.querySelector('#remove-kept-preview'),
    use = form.querySelector('#use-kept-preview'),
    panel = form.querySelector('#kept-preview'),
    image = form.querySelector('#kept-preview-image'),
    caption = form.querySelector('#kept-preview-caption'),
    details = form.querySelector('#kept-preview-settings'),
    status = form.querySelector('#preview-comparison-state');
  let ready = null,
    reference = null,
    capturing = false,
    choosing = false,
    controller = null,
    epoch = 0,
    disposed = false,
    message = '';
  const events = createEventScope((problem) => {
    message = problem.message;
    render();
  });
  function render() {
    if (disposed) return;
    aside.classList.toggle('has-kept-preview', !!reference);
    panel.hidden = !reference;
    remove.hidden = !reference;
    use.hidden = !reference;
    use.disabled = choosing;
    button.disabled = !ready || capturing || choosing;
    button.textContent = capturing
      ? 'Keeping preview…'
      : reference
        ? 'Replace kept preview'
        : 'Keep for comparison';
    status.textContent =
      message ||
      'Keep one preview while trying another seed. It clears when you leave this editor.';
    if (reference) {
      caption.textContent = 'Kept preview · Seed ' + reference.seed;
      details.textContent = !ready
        ? 'The current preview is not up to date. Your kept preview is unchanged.'
        : ready.seed === reference.seed && ready.settings === reference.settings
          ? 'The current preview uses the same seed and settings.'
          : 'The current preview uses a different seed or settings. Gameplay rules may not change the picture.';
    }
  }
  function releaseReference() {
    if (!reference) return;
    const target = document.querySelector('#preview-image'),
      dialog = document.querySelector('#preview-dialog');
    if (target?.getAttribute('src') === reference.url) {
      if (dialog?.open) dialog.close();
      target.removeAttribute('src');
    }
    image.removeAttribute('src');
    URL.revokeObjectURL(reference.url);
    reference = null;
  }
  function invalidate() {
    epoch++;
    controller?.abort();
    controller = null;
    capturing = false;
  }
  events.set(button, 'click', async () => {
    if (!ready || capturing || disposed) return;
    const snapshot = ready,
      version = epoch;
    capturing = true;
    message = '';
    controller = new AbortController();
    render();
    try {
      const bytes = await api(
        '/world-preview-image?id=' + encodeURIComponent(snapshot.id),
        {
          binary: true,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      if (disposed || version !== epoch || ready !== snapshot) return;
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length > 8 * 1024 * 1024 ||
        bytes.length < 24 ||
        !pngHeader.every((v, i) => bytes[i] === v)
      )
        throw Error(
          'This preview could not be kept. Refresh the current preview and try again.',
        );
      const blob = new Blob([bytes], {type: 'image/png'}),
        decoded = await createImageBitmap(blob);
      decoded.close();
      if (disposed || version !== epoch || ready !== snapshot) return;
      const url = URL.createObjectURL(blob);
      releaseReference();
      reference = {...snapshot, url};
      image.alt = 'Kept map preview for seed ' + snapshot.seed;
      image.src = url;
      message = 'Preview kept for comparison. No world was created or changed.';
    } catch (problem) {
      if (!disposed && version === epoch && problem.name !== 'AbortError')
        message = 'Could not keep this preview. ' + problem.message;
    } finally {
      if (!disposed && version === epoch) {
        capturing = false;
        controller = null;
        render();
      }
    }
  });
  events.set(remove, 'click', () => {
    invalidate();
    releaseReference();
    message = 'Kept preview removed. Your current draft is unchanged.';
    render();
  });
  events.set(use, 'click', async () => {
    if (!reference || choosing || disposed) return;
    const selected = reference,
      isCurrent = () => !disposed && reference === selected;
    choosing = true;
    render();
    try {
      const applied = await onUse(
        {seed: selected.seed, configuration: clone(selected.configuration)},
        isCurrent,
      );
      if (applied && isCurrent())
        message =
          'Kept seed and settings applied. Review your draft before creating a world.';
    } finally {
      choosing = false;
      render();
    }
  });
  function expand() {
    if (!reference || disposed) return;
    const dialog = document.querySelector('#preview-dialog'),
      target = document.querySelector('#preview-image');
    target.src = reference.url;
    dialog.showModal();
  }
  events.set(image, 'click', expand);
  events.set(image, 'keydown', (event) => {
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      expand();
    }
  });
  render();
  return {
    ready(value) {
      if (disposed) return;
      if (
        typeof value.id !== 'string' ||
        !Number.isInteger(value.seed) ||
        value.seed < 1 ||
        value.seed > 4294967295
      )
        return;
      const configuration = clone(value.configuration);
      ready = {
        id: value.id,
        seed: value.seed,
        configuration,
        settings: settingsKey(configuration),
      };
      message = '';
      render();
    },
    stale() {
      if (disposed) return;
      invalidate();
      ready = null;
      message = '';
      render();
    },
    dispose() {
      if (disposed) return;
      invalidate();
      releaseReference();
      disposed = true;
      events.clear();
    },
  };
}
