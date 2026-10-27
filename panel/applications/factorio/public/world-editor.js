import {mountWorldPreview, cleanWorldPreview} from './world-preview.js';
import {iconNode} from './shared/templates.js';
import {
  displayValue,
  settingsView,
  worldEditorView,
  worldReviewView,
} from './factorio/world-editor-views.js';
import {downloadJSON} from './diagnostics.js';
import {
  fields,
  getSetting,
  toDisplay,
  fromDisplay,
  fieldError,
  pairError,
  sliderPosition,
  sliderDisplay,
} from './world-fields.js';
const clone = (value) => JSON.parse(JSON.stringify(value));
const get = getSetting;
function put(object, path, value) {
  const parts = path.split('.'),
    last = parts.pop();
  for (const part of parts) object = object[part] ??= {};
  object[last] = value;
}
let draft = null,
  stopSaving = () => Promise.resolve(),
  saveWithoutLeaving = () => Promise.resolve(),
  savedOptions = null,
  submittedDraft = null,
  draftUnsaved = false,
  draftPending = 0,
  draftConflict = false,
  editorEpoch = 0;
if (typeof addEventListener === 'function')
  addEventListener('beforeunload', (event) => {
    if (draftUnsaved || draftPending) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
export const flushWorldDraft = () => stopSaving();
export const saveWorldDraft = () => saveWithoutLeaving();
export const hasUnsavedDraft = () => draftUnsaved || draftPending > 0;
export async function finishWorldDraft(api) {
  await flushWorldDraft();
  if (
    savedOptions?.setups?.draft &&
    savedOptions.setups.draft.id === submittedDraft
  ) {
    const current = savedOptions.setups;
    try {
      savedOptions.setups = await api('/world-setups', {
        method: 'POST',
        body: {
          operation: 'discard',
          revision: current.revision,
          draftId: current.draft.id,
        },
      });
    } catch {
      /* A newer draft is never discarded. */
    }
  }
  if (!draftUnsaved) clearWorldDraft();
}
export function clearWorldDraft() {
  editorEpoch++;
  stopSaving(false);
  stopSaving = () => Promise.resolve();
  saveWithoutLeaving = () => Promise.resolve();
  draft = null;
  savedOptions = null;
  submittedDraft = null;
  draftUnsaved = false;
  draftConflict = false;
}
export function useCopiedSettings() {
  if (draft) {
    draft.base = 'copied';
    draft.configuration = null;
    draft.inputs = {};
    draft.advancedDirty = false;
  }
}
const canCopy = (options) =>
  options?.copied?.sourceWorld === options?.currentWorld &&
  options?.copied?.image === options?.image;
function baseline(options, base) {
  const value = clone(
    base === 'copied' && canCopy(options)
      ? options.copied.configuration
      : options.defaults,
  );
  if (base === 'peaceful') value.map_gen_settings.peaceful_mode = true;
  return value;
}
function baselineNote(options) {
  if (draft.base === 'preset') return 'Your saved play style.';
  return draft.base === 'copied' && canCopy(options)
    ? 'Copied from ' + options.copied.sourceWorld + '.'
    : draft.base === 'peaceful'
      ? 'Default terrain with peaceful mode enabled. Enemies attack when provoked.'
      : 'Starting from Factorio defaults.';
}
export function worldForm(options, busy = false, template) {
  savedOptions = options;
  if (!draft && options.setups?.draft) {
    const saved = options.setups.draft;
    draft = {
      ...saved,
      configuration: JSON.parse(saved.configuration),
      activate: false,
    };
  }
  if (!draft)
    draft = {
      base: 'defaults',
      name: '',
      seed: '',
      preview: true,
      activate: false,
      configuration: null,
      step: 1,
    };
  if (!draft.configuration) draft.configuration = baseline(options, draft.base);
  draft.activate = false;
  return worldEditorView(
    {
      options,
      draft,
      busy,
      unsaved: draftUnsaved,
      canCopy: canCopy(options),
      baseline: baselineNote(options),
    },
    template,
  );
}

export function bindWorldEditor(
  options,
  {
    startJob,
    confirmAction,
    toast,
    api,
    template,
    onCancel = () => {},
    isCurrent = () => true,
    canCancel = () => true,
  },
) {
  const form = document.querySelector('#create-form');
  if (!form) return;
  const epoch = ++editorEpoch;
  let advancedDirty = false,
    previewChanged = () => {},
    scheduleSave = () => {};
  function selectTab(name) {
    form.querySelectorAll('[data-world-tab]').forEach((button) => {
      const active = button.dataset.worldTab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    form.querySelectorAll('.settings-panel').forEach((panel) => {
      panel.hidden = panel.id !== 'section-' + name;
    });
  }
  function review() {
    const changed = fields.filter(
      (field) =>
        JSON.stringify(get(draft.configuration, field.path)) !==
        JSON.stringify(get(options.defaults, field.path)),
    );
    const summary = (field) => {
      const value = get(draft.configuration, field.path);
      if (value === undefined) return 'Game default';
      if (field.boolean) return value ? 'On' : 'Off';
      const number = toDisplay(field, value);
      return Number.isFinite(number)
        ? displayValue(field, Number(number.toPrecision(5)))
        : String(value);
    };
    form.querySelector('#world-review').replaceChildren(
      worldReviewView(
        {
          name: draft.name,
          seed: draft.seed,
          baseline: baselineNote(options),
          changes: changed.map((field) => ({
            label: field.label,
            value: summary(field),
          })),
        },
        template,
      ),
    );
  }
  function stage(step) {
    basics();
    if (step === 3 && !validate()) return;
    draft.step = step;
    scheduleSave();
    form.querySelectorAll('[data-stage]').forEach((el) => {
      el.hidden = el.dataset.stage !== String(step);
    });
    form.querySelectorAll('[data-world-step]').forEach((button) => {
      if (Number(button.dataset.worldStep) === step)
        button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    form.querySelector('#world-back').hidden = step === 1;
    form.querySelector('#world-next').hidden = step === 3;
    form
      .querySelector('#world-next')
      .replaceChildren(
        (step === 1 ? 'Customize world' : 'Review world') + ' ',
        iconNode('arrow-right'),
      );
    form.querySelector('#world-create').hidden = step !== 3;
    if (step === 3) review();
    form
      .querySelector('[data-stage="' + step + '"] h2')
      .setAttribute('tabindex', '-1');
    form
      .querySelector('[data-stage="' + step + '"] h2')
      .focus({preventScroll: true});
  }
  function validate() {
    const name = form.elements.name;
    name.value = name.value.trim().replace(/\.zip$/i, '');
    draft.name = name.value;
    name.setCustomValidity(
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(name.value) ||
        name.value.includes('..')
        ? 'Use 1–80 letters, numbers, spaces, dots, underscores or dashes, starting with a letter or number. Avoid consecutive dots.'
        : '',
    );
    if (advancedDirty) {
      stage(2);
      form.querySelector('#world-form-error').textContent =
        'Apply your advanced settings before reviewing the world.';
      return false;
    }
    const invalid = Array.from(
      form.querySelectorAll('input,textarea,select'),
    ).find((input) => !input.validity.valid);
    if (invalid) {
      draft.step = 2;
      form.querySelectorAll('[data-stage]').forEach((el) => {
        el.hidden = el.dataset.stage !== '2';
      });
      form.querySelectorAll('[data-world-step]').forEach((b) => {
        if (b.dataset.worldStep === '2') b.setAttribute('aria-current', 'step');
        else b.removeAttribute('aria-current');
      });
      form.querySelector('#world-back').hidden = false;
      form.querySelector('#world-next').hidden = false;
      form.querySelector('#world-create').hidden = true;
      form
        .querySelector('#world-next')
        .replaceChildren('Review world ', iconNode('arrow-right'));
      const panel = invalid.closest('.settings-panel');
      if (panel) selectTab(panel.id.slice(8));
      for (
        let details = invalid.closest('details');
        details;
        details = details.parentElement.closest('details')
      )
        details.open = true;
      invalid.focus();
      invalid.reportValidity();
      return false;
    }
    return true;
  }
  form
    .querySelectorAll('[data-world-step]')
    .forEach((button) =>
      button.addEventListener('click', () =>
        stage(Number(button.dataset.worldStep)),
      ),
    );
  form
    .querySelector('#world-back')
    .addEventListener('click', () => stage(draft.step - 1));
  form
    .querySelector('#world-next')
    .addEventListener('click', () => stage(draft.step + 1));
  function basics() {
    const data = new FormData(form);
    for (const k of ['name', 'seed']) draft[k] = data.get(k);
    for (const k of ['preview', 'activate']) draft[k] = data.has(k);
  }
  function bindFields() {
    advancedDirty = false;
    form.querySelectorAll('[data-world-tab]').forEach((button) => {
      button.addEventListener('click', () =>
        selectTab(button.dataset.worldTab),
      );
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
          return;
        event.preventDefault();
        const tabs = Array.from(form.querySelectorAll('[data-world-tab]')),
          index = tabs.indexOf(button),
          next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) %
                  tabs.length;
        selectTab(tabs[next].dataset.worldTab);
        tabs[next].focus();
      });
    });
    const inputs = Array.from(form.querySelectorAll('[data-world-setting]'));
    function validateInputs() {
      const candidate = clone(draft.configuration);
      let message = '';
      for (const input of inputs) {
        const field = fields.find((f) => f.path === input.dataset.worldSetting);
        input.setCustomValidity('');
        const value = field.boolean
            ? input.checked
            : input.value === ''
              ? NaN
              : fromDisplay(field, input.value),
          error = fieldError(field, value);
        if (error) {
          input.setCustomValidity(error);
          message ||= error;
        } else put(candidate, field.path, value);
      }
      const pair = pairError(candidate);
      if (pair) {
        const suffix = pair.includes('cooldown')
            ? 'max_expansion_cooldown'
            : 'settler_group_max_size',
          input = inputs.find((i) => i.dataset.worldSetting.endsWith(suffix));
        input?.setCustomValidity(pair);
        message ||= pair;
      }
      form.querySelector('#world-form-error').textContent = message;
      return message;
    }
    function applyInput(input, field) {
      const value = field.boolean
          ? input.checked
          : input.value === ''
            ? NaN
            : fromDisplay(field, input.value),
        error = fieldError(field, value);
      if (!error) {
        put(
          draft.configuration,
          field.path,
          field.path.includes('property_expression_names.')
            ? String(value)
            : value,
        );
        const range = form.querySelector(`[data-world-range="${field.path}"]`);
        if (range) {
          range.value = sliderPosition(field, value);
          const text = displayValue(field, Number(input.value));
          range.setAttribute('aria-valuetext', text);
          form.querySelector(
            `[data-world-output="${field.path}"]`,
          ).textContent = text;
        }
        if (!advancedDirty)
          form.querySelector('#world-settings-json').value = JSON.stringify(
            draft.configuration,
            null,
            2,
          );
      }
      validateInputs();
    }
    for (const input of inputs) {
      const field = fields.find((f) => f.path === input.dataset.worldSetting);
      input.addEventListener('input', () => applyInput(input, field));
      const range = form.querySelector(`[data-world-range="${field.path}"]`);
      range?.addEventListener('input', () => {
        input.value = sliderDisplay(field, range.value);
        applyInput(input, field);
      });
    }
    validateInputs();
    form.querySelector('#world-settings-json').addEventListener('input', () => {
      advancedDirty = true;
    });
    form.querySelector('#apply-world-json').addEventListener('click', () => {
      try {
        const value = JSON.parse(
          form.querySelector('#world-settings-json').value,
        );
        if (
          !value ||
          typeof value !== 'object' ||
          !value.map_gen_settings ||
          !value.map_settings ||
          Object.keys(value).some(
            (k) => !['map_gen_settings', 'map_settings'].includes(k),
          )
        )
          throw new Error('Include map_gen_settings and map_settings objects.');
        if (JSON.stringify(value).length > 131072)
          throw new Error('Settings are too large.');
        for (const field of fields) {
          const setting = get(value, field.path);
          if (setting !== undefined) {
            const error = fieldError(field, setting);
            if (error) throw new Error(error);
          }
        }
        const pair = pairError(value);
        if (pair) throw new Error(pair);
        draft.configuration = value;
        form
          .querySelector('#world-editor-settings')
          .replaceChildren(settingsView(value, template));
        bindFields();
        form.querySelector('#world-settings-json').closest('details').open =
          true;
        form.querySelector('#world-json-result').textContent =
          'Advanced settings applied. The controls above now match.';
        previewChanged();
        scheduleSave();
      } catch (error) {
        form.querySelector('#world-json-result').textContent =
          'Could not apply settings: ' + error.message;
      }
    });
  }
  bindFields();
  if (draft.inputs)
    for (const [key, value] of Object.entries(draft.inputs)) {
      const input = form.querySelector(`[data-world-setting="${key}"]`);
      if (input) {
        if (input.type === 'checkbox') input.checked = value;
        else input.value = value;
        input.dispatchEvent(new Event('input'));
      }
    }
  if (draft.advancedDirty) {
    advancedDirty = true;
    form.querySelector('#world-settings-json').value = draft.advanced;
    form.querySelector('#world-settings-json').closest('details').open = true;
  }
  form.addEventListener(
    'invalid',
    (event) => {
      for (
        let details = event.target.closest('details');
        details;
        details = details.parentElement.closest('details')
      )
        details.open = true;
    },
    true,
  );
  form.elements.name.addEventListener('input', () =>
    form.elements.name.setCustomValidity(''),
  );
  form.addEventListener('input', basics);
  form.addEventListener('change', basics);
  form.querySelectorAll('[name=base]').forEach((input) =>
    input.addEventListener('change', () => {
      if (!input.checked) return;
      draft.base = input.value;
      draft.configuration = baseline(options, draft.base);
      form.querySelector('#world-base-note').textContent =
        baselineNote(options);
      form
        .querySelector('#world-editor-settings')
        .replaceChildren(settingsView(draft.configuration, template));
      bindFields();
      previewChanged();
      scheduleSave();
    }),
  );
  form
    .querySelector('#copy-world-settings')
    .addEventListener('click', async () => {
      basics();
      if (
        await confirmAction(
          'Load current world settings?',
          'This refreshes your starting settings from an isolated saved copy. Terrain and gameplay edits in this form will be replaced. Your world name and seed will be kept.',
        )
      )
        startJob('world-options');
    });
  previewChanged = mountWorldPreview(form, {
    api,
    getDraft: () => draft,
    isValid: () => !advancedDirty,
    onSeed: () => scheduleSave(),
  });
  const showImpact = () => {
    form
      .querySelector('#creation-impact')
      .replaceChildren(
        template(
          draft.activate ? 'world-impact-switch' : 'world-impact-library',
        ),
      );
  };
  form.querySelector('[name=activate]').addEventListener('change', showImpact);
  showImpact();
  if (draft.step === 3) review();
  const capture = () => {
    basics();
    return {
      name: draft.name,
      seed: draft.seed,
      image: options.image,
      base: draft.base,
      step: draft.step,
      configuration: JSON.stringify(draft.configuration),
      advanced: form.querySelector('#world-settings-json').value,
      advancedDirty,
      preview: draft.preview,
      inputs: Object.fromEntries(
        Array.from(form.querySelectorAll('[data-world-setting]'))
          .filter((i) => !i.validity.valid)
          .map((i) => [
            i.dataset.worldSetting,
            i.type === 'checkbox' ? i.checked : i.value,
          ]),
      ),
    };
  };
  let timer = null,
    dirty = draftUnsaved,
    queue = Promise.resolve(),
    stopped = false,
    conflict = draftConflict;
  const label = form.querySelector('#draft-save-state');
  const write = (body) => {
    draftPending++;
    const next = queue
      .then(async () => {
        options.setups = await api('/world-setups', {
          method: 'POST',
          body: {...body, revision: options.setups.revision},
        });
        return options.setups;
      })
      .finally(() => {
        draftPending = Math.max(0, draftPending - 1);
      });
    queue = next.catch(() => {});
    return next;
  };
  async function save() {
    clearTimeout(timer);
    if (!dirty || conflict) return;
    const value = capture();
    Object.assign(draft, {
      advanced: value.advanced,
      advancedDirty: value.advancedDirty,
      inputs: value.inputs,
      image: value.image,
    });
    dirty = false;
    label.textContent = 'Saving draft…';
    try {
      const result = await write({operation: 'draft', draft: value});
      if (epoch !== editorEpoch) return;
      draft.id = result.draft.id;
      if (!dirty) {
        draftUnsaved = false;
        label.textContent = 'Draft saved to your account';
      }
    } catch (error) {
      if (epoch !== editorEpoch) return;
      dirty = true;
      draftUnsaved = true;
      conflict = draftConflict = error.message.includes('another tab');
      label.textContent =
        error.message + ' Download a draft copy to keep your edits.';
    }
  }
  scheduleSave = () => {
    if (stopped) return;
    dirty = true;
    draftUnsaved = true;
    label.textContent = 'Unsaved changes…';
    clearTimeout(timer);
    timer = setTimeout(save, 600);
  };
  form.addEventListener('input', (event) => {
    if (
      event.target.id !== 'world-preset-name' &&
      event.target.id !== 'saved-world-preset'
    )
      scheduleSave();
  });
  form.addEventListener('change', (event) => {
    if (event.target.id !== 'saved-world-preset') scheduleSave();
  });
  const hide = () => {
    if (document.hidden) void save();
  };
  document.addEventListener('visibilitychange', hide);
  saveWithoutLeaving = async () => {
    await save();
    await queue;
  };
  stopSaving = (flush = true) => {
    clearTimeout(timer);
    const pending = flush ? save() : Promise.resolve();
    stopped = true;
    document.removeEventListener('visibilitychange', hide);
    stopSaving = () => queue;
    return pending.then(() => queue);
  };
  form.querySelector('#save-draft-now').addEventListener('click', () => {
    dirty = true;
    void save();
  });
  form
    .querySelector('#export-world-draft')
    .addEventListener('click', () =>
      downloadJSON(capture(), 'lobby-goblin-world-draft.json'),
    );
  const result = form.querySelector('#preset-result'),
    select = form.querySelector('#saved-world-preset');
  async function presetAction(body) {
    await save();
    await queue;
    if (conflict)
      throw new Error(
        'Reload to load the latest saved setups. Download a draft copy first to keep your edits.',
      );
    // Autosaves replace the draft ID. Resolve a destructive target only after
    // this tab's writes settle; the server still checks the exact revision/ID.
    return write(typeof body === 'function' ? body() : body);
  }
  form
    .querySelector('#cancel-world-draft')
    .addEventListener('click', async () => {
      if (!canCancel()) return;
      if (
        !(await confirmAction(
          'Cancel this world draft?',
          'This discards your account’s saved draft and returns to the world library. Saved worlds and presets are kept. A terrain preview already requested may finish in the background. This does not cancel a submitted Create world operation.',
          'Cancel draft',
        )) ||
        !isCurrent() ||
        !canCancel()
      )
        return;
      form.inert = true;
      try {
        await presetAction(() => ({
          operation: 'discard',
          draftId: options.setups.draft?.id,
        }));
        if (!isCurrent() || epoch !== editorEpoch) return;
        await stopSaving(false);
        cleanWorldPreview();
        clearWorldDraft();
        onCancel();
        toast('World draft cancelled.');
      } catch (error) {
        if (!isCurrent() || epoch !== editorEpoch) return;
        form.querySelector('#world-form-error').textContent = error.message;
        form.inert = false;
      }
    });
  function presets() {
    select.replaceChildren(
      new Option(
        'Choose a preset (' + options.setups.presets.length + '/20)',
        '',
      ),
      ...options.setups.presets.map(
        (preset) => new Option(preset.name, preset.id),
      ),
    );
  }
  form
    .querySelector('#world-preset-name')
    .addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        form.querySelector('#save-world-preset').click();
      }
    });
  form
    .querySelector('#save-world-preset')
    .addEventListener('click', async () => {
      if (advancedDirty || form.querySelector('[data-world-setting]:invalid')) {
        result.textContent =
          'Apply advanced edits and fix highlighted settings before saving a preset.';
        return;
      }
      try {
        await presetAction({
          operation: 'save-preset',
          name: form.querySelector('#world-preset-name').value,
          configuration: clone(draft.configuration),
          image: options.image,
        });
        presets();
        result.textContent =
          'Preset saved. Your world name and seed are not included.';
      } catch (error) {
        result.textContent = error.message;
      }
    });
  form
    .querySelector('#load-world-preset')
    .addEventListener('click', async () => {
      const preset = options.setups.presets.find((p) => p.id === select.value);
      if (!preset) {
        result.textContent = 'Choose a saved preset first.';
        return;
      }
      if (
        !(await confirmAction(
          'Use ' + preset.name + '?',
          'This replaces terrain and gameplay edits. Your name and seed are kept. Switching to the new world stays unchecked.' +
            (preset.image !== options.image
              ? ' This preset was saved with a different game image. Review compatibility before creating.'
              : ''),
        ))
      )
        return;
      draft.configuration = clone(preset.configuration);
      draft.base = 'preset';
      draft.activate = false;
      draft.inputs = null;
      draft.advancedDirty = false;
      form.elements.activate.checked = false;
      form.querySelectorAll('[name=base]').forEach((i) => (i.checked = false));
      form
        .querySelector('#world-editor-settings')
        .replaceChildren(settingsView(draft.configuration, template));
      form.querySelector('#world-base-note').textContent =
        'Saved preset: ' + preset.name;
      bindFields();
      previewChanged();
      showImpact();
      stage(2);
      result.textContent =
        'Preset loaded. Review the settings before creating.';
      scheduleSave();
    });
  form
    .querySelector('#delete-world-preset')
    .addEventListener('click', async () => {
      const preset = options.setups.presets.find((p) => p.id === select.value);
      if (!preset) {
        result.textContent = 'Choose a saved preset first.';
        return;
      }
      if (
        !(await confirmAction(
          'Remove ' + preset.name + '?',
          'Your current draft will be kept.',
        ))
      )
        return;
      try {
        await presetAction({operation: 'delete-preset', id: preset.id});
        presets();
        result.textContent = 'Preset removed.';
      } catch (error) {
        result.textContent = error.message;
      }
    });
  form
    .querySelector('#discard-world-draft')
    .addEventListener('click', async () => {
      if (
        !(await confirmAction(
          'Start a fresh draft?',
          'This removes the saved draft for your account. Saved presets are kept.',
        ))
      )
        return;
      form.inert = true;
      try {
        await presetAction(() => ({
          operation: 'discard',
          draftId: options.setups.draft?.id,
        }));
        await stopSaving(false);
        draft = null;
        draftUnsaved = false;
        form.replaceWith(worldForm(options, false, template));
        bindWorldEditor(options, {
          startJob,
          confirmAction,
          toast,
          api,
          template,
          onCancel,
          isCurrent,
          canCancel,
        });
      } catch (error) {
        result.textContent = error.message;
        form.inert = false;
      }
    });
  if (!options.setups?.draft || draftUnsaved) scheduleSave();
  form.querySelector('#roll-world-seed').addEventListener('click', () => {
    form.elements.seed.value = '';
    draft.seed = '';
    previewChanged();
    scheduleSave();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    basics();
    if (advancedDirty) {
      form.querySelector('#world-form-error').textContent =
        'Apply your advanced settings before creating the world.';
      return;
    }
    if (!validate()) return;
    if (draft.step !== 3) {
      stage(3);
      return;
    }
    if (
      draft.activate &&
      !(await confirmAction(
        'Create and load a new world?',
        'The current world will be saved and backed up before switching. Players will be disconnected when the new world is ready.',
      ))
    )
      return;
    form.querySelector('#world-form-error').textContent = '';
    await save();
    await queue;
    submittedDraft = options.setups.draft?.id;
    await startJob('create', {
      name: draft.name,
      seed: draft.seed,
      preview: draft.preview,
      activate: draft.activate,
      confirm: draft.activate,
      configuration: clone(draft.configuration),
    });
  });
}
