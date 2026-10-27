import {
  fields,
  sections,
  getSetting,
  toDisplay,
  sliderPosition,
} from '../world-fields.js';
import {iconNode, part, text} from '../shared/templates.js';

export function displayValue(field, value) {
  return field.off && value === 0
    ? 'Off'
    : String(value) +
        (field.logarithmic || field.label.includes('(%)') ? '%' : '');
}
function fieldView(field, configuration, template) {
  const value = getSetting(configuration, field.path) ?? field.fallback;
  if (field.boolean) {
    const view = template('world-boolean-field'),
      input = part(view, 'input');
    input.dataset.worldSetting = field.path;
    input.checked = !!value;
    text(view, 'span', field.label);
    return view;
  }
  let numeric = toDisplay(field, value);
  if (!Number.isFinite(numeric)) {
    const view = template('world-custom-field');
    text(
      view,
      'p',
      field.label +
        ' uses a custom expression. Edit it under Advanced settings.',
    );
    return view;
  }
  numeric = field.logarithmic
    ? Math.round(numeric)
    : Number(numeric.toPrecision(12));
  const view = template(
      field.slider ? 'world-slider-field' : 'world-setting-field',
    ),
    id = 'world-field-' + fields.indexOf(field),
    input = part(view, 'input[type=number]'),
    label = part(view, field.slider ? 'label' : '[data-part=label]');
  label.textContent =
    field.label + (field.slider && field.logarithmic ? ' (%)' : '');
  (field.slider ? label : part(view, 'label')).htmlFor = id;
  Object.assign(input, {
    id,
    value: String(numeric),
    min: String(field.min),
    max: String(field.max),
    step: String(field.step),
  });
  input.dataset.worldSetting = field.path;
  input.setAttribute(
    'aria-label',
    field.label + (field.logarithmic ? ' (%)' : ''),
  );
  input.setAttribute('aria-describedby', id + '-hint');
  part(view, '.hint').id = id + '-hint';
  const bounds = field.logarithmic
    ? field.off
      ? 'Off or 17–600%'
      : '17–600%'
    : field.min + '–' + field.max;
  text(
    view,
    '.hint',
    field.hint ||
      (field.slider
        ? bounds
        : bounds + (field.step === 1 ? ' · whole numbers' : '')),
  );
  if (field.slider) {
    const display = displayValue(field, numeric),
      output = part(view, 'output'),
      range = part(view, 'input[type=range]');
    output.htmlFor.value = id;
    output.dataset.worldOutput = field.path;
    output.textContent = display;
    range.dataset.worldRange = field.path;
    range.setAttribute('aria-label', field.label + ' slider');
    range.setAttribute('aria-valuetext', display);
    Object.assign(range, {
      min: String(field.logarithmic ? 0 : field.min),
      max: String(field.logarithmic ? (field.off ? 101 : 100) : field.max),
      step: String(field.logarithmic ? 1 : field.step),
    });
    range.value = String(
      Math.max(
        Number(range.min),
        Math.min(Number(range.max), sliderPosition(field, value)),
      ),
    );
  }
  return view;
}
export function settingsView(configuration, template) {
  const view = template('world-settings');
  const group = (section) => {
    if (section.name !== 'Resources') {
      const result = template('world-settings-group');
      for (const field of section.fields)
        part(result, '.world-settings-grid').append(
          fieldView(field, configuration, template),
        );
      return result;
    }
    const result = template('resource-grid');
    for (const name of ['Iron', 'Copper', 'Stone', 'Coal', 'Uranium', 'Oil']) {
      const row = template('resource-row');
      text(row, '.resource-name', name);
      for (const field of section.fields.filter((field) =>
        field.label.startsWith(name + ' '),
      ))
        part(row, '.resource-row').append(
          fieldView(field, configuration, template),
        );
      part(
        result,
        ['Uranium', 'Oil'].includes(name)
          ? '[data-part=more]'
          : '[data-part=resources]',
      ).append(row);
    }
    return result;
  };
  for (const [index, section] of sections.slice(0, 3).entries()) {
    const tab = template('world-tab'),
      button = part(tab, 'button'),
      panel = template('world-settings-panel'),
      active = index === 0;
    button.id = 'tab-' + section.name;
    button.dataset.worldTab = section.name;
    button.setAttribute('aria-controls', 'section-' + section.name);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    button.classList.toggle('active', active);
    part(tab, '[data-part=icon]').append(
      iconNode(['database', 'mountain', 'bug'][index]),
    );
    text(tab, '[data-part=name]', section.name);
    const element = part(panel, 'section');
    element.id = 'section-' + section.name;
    element.setAttribute('aria-labelledby', 'tab-' + section.name);
    element.hidden = !active;
    text(
      panel,
      'h3',
      section.name === 'Resources' ? 'Resource generation' : section.name,
    );
    if (section.hint) text(panel, 'p', section.hint);
    else part(panel, 'p').remove();
    part(panel, '[data-part=fields]').append(group(section));
    part(view, '[role=tablist]').append(tab);
    part(view, '[data-part=panels]').append(panel);
  }
  part(view, '[data-part=gameplay] [data-part=fields]').append(
    group(sections[3]),
  );
  part(view, '#world-settings-json').value = JSON.stringify(
    configuration,
    null,
    2,
  );
  return view;
}
export function worldEditorView(
  {options, draft, busy, unsaved, canCopy, baseline},
  template,
) {
  const view = template('world-editor');
  for (const button of view.querySelectorAll('[data-world-step]'))
    if (Number(button.dataset.worldStep) === draft.step)
      button.setAttribute('aria-current', 'step');
  text(
    view,
    '#draft-save-state',
    unsaved
      ? 'Unsaved draft in this tab · save or download a copy'
      : options.setups?.draft
        ? 'Draft resumed · saved to your account'
        : 'Your draft saves to your account as you edit',
  );
  const presets = options.setups?.presets || [],
    select = part(view, '#saved-world-preset');
  select.append(
    new Option('Choose a preset (' + presets.length + '/20)', ''),
    ...presets.map((preset) => new Option(preset.name, preset.id)),
  );
  if (!draft.image || draft.image === options.image)
    part(view, '[data-part=image-changed]').remove();
  part(view, '[name=name]').value = draft.name;
  for (const [value, name, detail] of [
    [
      'defaults',
      'Balanced',
      'The standard Factorio experience. Room to build and explore.',
    ],
    [
      'peaceful',
      'A quieter start',
      'Standard terrain. Enemies attack only when provoked.',
    ],
    [
      'copied',
      'Like your current world',
      canCopy
        ? 'Use the settings already copied from your active world.'
        : 'Load the current world’s settings below first.',
    ],
  ]) {
    const style = template('playstyle'),
      input = part(style, 'input');
    input.value = value;
    input.checked = draft.base === value;
    input.disabled = value === 'copied' && !canCopy;
    text(style, '[data-part=name]', name);
    text(style, 'small', detail);
    part(view, '[data-part=styles]').append(style);
  }
  part(view, '#copy-world-settings').disabled = !!busy;
  text(
    view,
    '[data-part=copy-label]',
    (canCopy ? 'Refresh' : 'Load') + ' current settings',
  );
  text(view, '#world-base-note', baseline);
  for (const stage of view.querySelectorAll('[data-stage]'))
    stage.hidden = Number(stage.dataset.stage) !== draft.step;
  part(view, '#world-editor-settings').append(
    settingsView(draft.configuration, template),
  );
  part(view, '[name=preview]').checked = !!draft.preview;
  part(view, '[name=activate]').checked = !!draft.activate;
  part(view, '#creation-impact').append(template('world-impact-library'));
  part(view, '#world-back').hidden = draft.step === 1;
  part(view, '#world-next').hidden = draft.step === 3;
  text(
    view,
    '[data-part=next-label]',
    draft.step === 1 ? 'Customize world' : 'Review world',
  );
  part(view, '#world-create').hidden = draft.step !== 3;
  part(view, '#world-create').disabled = !!busy;
  part(view, '#cancel-world-draft').disabled = !!busy;
  return view;
}
export function worldReviewView({name, seed, baseline, changes}, template) {
  const view = template('world-review-content');
  text(view, '[data-part=name]', name || 'Give your world a name');
  text(view, '[data-part=seed]', seed || 'Chosen when preview generates');
  text(view, '[data-part=baseline]', baseline);
  text(
    view,
    'h3',
    changes.length ? 'Changes from defaults' : 'Visible settings use defaults',
  );
  if (changes.length) {
    part(view, '[data-part=defaults]').remove();
    for (const change of changes) {
      const row = template('world-review-change');
      text(row, 'li', change.label + ': ' + change.value);
      part(view, 'ul').append(row);
    }
  } else part(view, 'ul').remove();
  return view;
}
