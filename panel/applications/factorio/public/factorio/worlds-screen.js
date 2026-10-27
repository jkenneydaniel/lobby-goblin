import {createWorldsViews} from './worlds-views.js';
import {
  bindWorldEditor,
  finishWorldDraft,
  useCopiedSettings,
} from '../world-editor.js';
import {serverPath, pagePath} from '../scope.js';

export function createWorldsScreen({
  getState,
  ui,
  startJob,
  request,
  bindCommon,
  notify,
}) {
  let context = null,
    worldOptions = null,
    worldSearch = '',
    worldFilter = 'all',
    createdWorld = null,
    worlds = [];
  const {worldPage, worldRows} = createWorldsViews(
    () => ({
      ...getState(),
      worldOptions,
      worldSearch,
      worldFilter,
      createdWorld,
      admin: () => getState().can('worlds.manage'),
    }),
    ui,
  );
  function bind(ctx) {
    const search = ctx.root.querySelector('#world-search');
    if (search)
      ctx.on(search, 'input', (event) => {
        worldSearch = event.target.value;
        ctx.root
          .querySelector('#world-results')
          .replaceChildren(worldRows(worlds));
      });
    ctx.on(ctx.root, 'click', async (event) => {
      const button = event.target.closest(
        '[data-world-filter],[data-load-world],[data-preview]',
      );
      if (!button || !ctx.root.contains(button)) return;
      if (button.dataset.worldFilter) {
        worldFilter = button.dataset.worldFilter;
        await load(ctx);
      } else if (button.dataset.loadWorld) {
        if (
          await ctx.confirm(
            'Switch to ' + button.dataset.name + '?',
            'The current world will be saved and backed up. Connected players will be disconnected while the selected world starts.',
          )
        )
          await startJob('switch', {
            id: button.dataset.loadWorld,
            confirm: true,
          });
      } else {
        const image = document.querySelector('#preview-image'),
          dialog = document.querySelector('#preview-dialog');
        image.src =
          serverPath('/api/preview?id=') +
          encodeURIComponent(button.dataset.preview);
        image.onerror = () => {
          dialog.close();
          if (ctx.isCurrent())
            notify('This world has no generated preview.', true);
        };
        dialog.showModal();
      }
    });
    const upload = ctx.root.querySelector('#upload-form');
    if (upload)
      ctx.on(upload, 'submit', async (event) => {
        event.preventDefault();
        const file = new FormData(event.target).get('world');
        if (!file?.size) return;
        if (file.size > 128 * 1024 * 1024)
          return notify('World uploads are limited to 128 MB.', true);
        const button = event.target.querySelector('button');
        button.disabled = true;
        try {
          const result = await ctx.request(
            '/upload?name=' + encodeURIComponent(file.name),
            {method: 'POST', body: file, raw: true},
          );
          notify(result.message);
          await load(ctx);
        } finally {
          button.disabled = false;
        }
      });
    if (getState().can('worlds.manage'))
      bindWorldEditor(worldOptions, {
        startJob,
        confirmAction: ctx.confirm,
        toast: notify,
        api: request,
        template: ui.template,
        isCurrent: ctx.isCurrent,
        canCancel: () => !getState().busyJob,
        onCancel: () => {
          if (ctx.isCurrent()) location.hash = '#worlds';
        },
      });
    bindCommon(ctx);
  }
  async function load(ctx) {
    const [data, options] = await Promise.all([
      ctx.request('/worlds'),
      getState().can('worlds.manage') ? ctx.request('/world-options') : null,
    ]);
    if (options) options.setups = await ctx.request('/world-setups');
    worldOptions = options;
    worlds = data.worlds;
    ctx.render(worldPage(worlds));
    ctx.root.className =
      location.hash === '#worlds/create' ? 'creation-page' : '';
    bind(ctx);
  }
  return {
    async mount(ctx) {
      context = ctx;
      await load(ctx);
    },
    async refresh(ctx, options) {
      const cancel = ctx.root.querySelector('#cancel-world-draft');
      if (cancel) cancel.disabled = !!getState().busyJob;
      if (options.reason !== 'status') await load(ctx);
    },
    async completed(action, params, job) {
      if (action === 'create') {
        const signedUser = getState().user;
        await finishWorldDraft(request);
        if (getState().user !== signedUser) return;
        createdWorld = {name: params.name, message: job.message};
        if (context?.isCurrent())
          history.replaceState(null, '', pagePath('#worlds/created'));
      }
      if (action === 'world-options') useCopiedSettings();
    },
    dispose() {
      context = null;
      const image = document.querySelector('#preview-image');
      if (image) image.onerror = null;
      document.querySelector('#preview-dialog')?.close();
    },
    reset() {
      worldOptions = null;
      worldSearch = '';
      worldFilter = 'all';
      createdWorld = null;
      worlds = [];
    },
  };
}
