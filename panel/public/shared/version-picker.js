let nextId = 0;
export function versionLabel(choice, installed) {
  const labels = new Set(
    choice.channels?.length ? choice.channels : [choice.channel || 'archived'],
  );
  if (choice.version === installed) labels.add('installed');
  return choice.version + ' · ' + [...labels].join(' · ');
}

// Keep the native, named control as the submission source. Search text only
// filters verified choices; editing it invalidates the submitted selection.
export function mountVersionPicker(select, {choices, signal}) {
  const lifetime = new AbortController();
  const id = 'version-picker-' + ++nextId;
  const originalLabel = select.labels?.[0];
  const name =
    select.getAttribute('aria-label') ||
    [...(originalLabel?.childNodes || [])]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join('')
      .trim() ||
    'Version';
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = element('div', 'version-picker');
  const label = element('label', '', name);
  label.htmlFor = id;
  const control = element('div', 'version-picker-control');
  const input = element('input');
  input.id = id;
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 80;
  input.placeholder = 'Search a version or channel';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', name);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id + '-options');
  const toggle = element('button', '', '▾');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Show versions');
  const list = element('div', 'version-picker-options');
  list.id = id + '-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', name + ' choices');
  const count = element('p', 'version-picker-count');
  count.setAttribute('role', 'status');
  control.append(input, toggle);
  root.append(label, control, list, count);
  const wrapped = originalLabel?.contains(select);
  if (wrapped) originalLabel.after(root);
  else select.before(root);
  const previous = {
    hidden: select.hidden,
    required: select.required,
    labelHidden: originalLabel?.hidden,
  };
  select.hidden = true;
  select.required = false;
  if (originalLabel) originalLabel.hidden = true;
  input.disabled = toggle.disabled = select.disabled || !choices.length;
  let open = false,
    query = '',
    active = -1,
    matches = choices;
  const selected = () =>
    choices.find((choice) => choice.value === select.value);
  const display = () => {
    input.value = selected()?.display || '';
  };
  function render() {
    matches = choices.filter((choice) =>
      (choice.searchText || choice.label)
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
    );
    if (active >= matches.length) active = matches.length - 1;
    list.replaceChildren(
      ...matches.map((choice, index) => {
        const option = element('div', 'version-picker-option', choice.label);
        option.id = id + '-option-' + index;
        option.dataset.index = String(index);
        option.setAttribute('role', 'option');
        option.setAttribute(
          'aria-selected',
          String(choice.value === select.value),
        );
        if (index === active) option.dataset.active = 'true';
        return option;
      }),
    );
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-expanded', String(open));
    if (open && active >= 0)
      input.setAttribute('aria-activedescendant', id + '-option-' + active);
    else input.removeAttribute('aria-activedescendant');
    count.textContent = !choices.length
      ? 'No verified releases available.'
      : matches.length
        ? matches.length +
          (matches.length === 1 ? ' version' : ' versions') +
          (query ? ' found' : ' available')
        : 'No versions match. Try an exact version such as 2.0.77.';
  }
  function choose(index) {
    const choice = matches[index];
    if (!choice) return;
    select.value = choice.value;
    query = '';
    open = false;
    active = -1;
    display();
    render();
    select.dispatchEvent(new Event('change', {bubbles: true}));
  }
  const on = (node, type, listener) =>
    node.addEventListener(type, listener, {signal: lifetime.signal});
  on(input, 'focus', () => {
    query = '';
    open = true;
    active = -1;
    input.select();
    render();
  });
  on(input, 'input', () => {
    query = input.value;
    open = true;
    active = 0;
    select.value = '';
    select.dispatchEvent(new Event('change', {bubbles: true}));
    render();
  });
  on(input, 'keydown', (event) => {
    if (
      ['ArrowDown', 'ArrowUp'].includes(event.key) ||
      (open && ['Home', 'End'].includes(event.key))
    ) {
      event.preventDefault();
      open = true;
      active =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? matches.length - 1
            : Math.max(
                0,
                Math.min(
                  matches.length - 1,
                  active + (event.key === 'ArrowDown' ? 1 : -1),
                ),
              );
      render();
      list.children[active]?.scrollIntoView({block: 'nearest'});
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      open = false;
      query = '';
      display();
      render();
    } else if (event.key === 'Tab') {
      open = false;
      render();
    }
  });
  on(toggle, 'click', () => {
    const show = !open;
    input.focus();
    open = show;
    query = '';
    render();
  });
  on(list, 'pointerdown', (event) => event.preventDefault());
  on(list, 'click', (event) => {
    const option = event.target.closest('[data-index]');
    if (option && list.contains(option)) choose(Number(option.dataset.index));
  });
  on(document, 'pointerdown', (event) => {
    if (open && !root.contains(event.target)) {
      open = false;
      render();
    }
  });
  display();
  render();
  function dispose() {
    lifetime.abort();
    signal?.removeEventListener('abort', dispose);
    root.remove();
    select.hidden = previous.hidden;
    select.required = previous.required;
    if (originalLabel) originalLabel.hidden = previous.labelHidden;
  }
  signal?.addEventListener('abort', dispose, {once: true});
  if (signal?.aborted) dispose();
  return {root, input, dispose};
}
