import {serverPath} from '../scope.js';

export const rustSoftware = {
  version: 1,
  create({getStatus, getOperation, recoveryRequired, canAction, job}) {
    let value = null,
      inspection = null,
      working = false,
      root,
      context;
    const hostBusy = () =>
      !!getOperation() ||
      !!getStatus()?.activeJob ||
      !!getStatus()?.managementBusy ||
      !!getStatus()?.imageMigration;
    const $ = (key) => root.querySelector('[data-' + key + ']');
    const modded = () => value?.framework && value.framework !== 'none';
    const action = (kind) => 'software-' + kind + (modded() ? '-modded' : '');
    const recoveryKind = () =>
      value?.change?.pending ? value.change.kind : 'initial';
    const recoverAction = () =>
      recoveryKind() === 'framework'
        ? 'recover-framework'
        : recoveryKind() === 'initial'
          ? 'software-recover'
          : action('recover');
    const pending = () =>
      !!(value?.installation?.recoveryRequired || value?.change?.pending);
    const metadataOnly = () =>
      recoveryKind() === 'software' &&
      value.change.metadataOnlyRecovery === true;
    const allowed = (name) =>
      !working && !hostBusy() && !recoveryRequired() && canAction(name);
    function controls() {
      if (!root || !value) return;
      if (getStatus()?.activeJob?.message)
        $('progress').textContent = getStatus().activeJob.message;
      const running = !!getStatus()?.running,
        managed = value.managed;
      const prepared =
        value.change?.pending &&
        value.change.kind === 'framework' &&
        value.change.phase === 'prepared';
      $('refresh').disabled = working;
      $('operations').hidden = !recoveryRequired();
      $('start').hidden = $('stop').hidden = $('check').hidden = !managed;
      $('start').textContent = prepared
        ? 'Start and validate prepared framework'
        : value.installation?.version
          ? 'Start Rust'
          : 'Prepare and start Rust';
      $('start').disabled =
        !allowed('start') || running || (pending() && !prepared);
      $('stop').disabled = !allowed('stop') || !running;
      $('check').disabled =
        !managed ||
        !allowed(action('check')) ||
        !value.installation?.version ||
        (pending() && !metadataOnly());
      const expires = Date.parse(value.updates?.expires),
        expired = !Number.isFinite(expires) || Date.now() >= expires;
      $('apply').disabled =
        !allowed(action('update')) ||
        !value.updates?.updateAvailable ||
        expired;
      $('expiry').textContent = value.updates?.expires
        ? expired
          ? 'This review expired. Check Steam updates again before applying.'
          : 'Review expires ' + new Date(expires).toLocaleString() + '.'
        : '';
      $('inspect').disabled =
        working || hostBusy() || !canAction(recoverAction());
      $('cancel').hidden = recoveryKind() === 'framework';
      $('cancel').disabled = !allowed('software-cancel') || !inspection;
      $('recover').disabled =
        !allowed(recoverAction()) ||
        !inspection?.review ||
        (running && !metadataOnly());
    }
    function paint() {
      $('source').textContent = value.source || value.message;
      $('version').textContent = value.managed
        ? value.installation.version || 'Not installed yet'
        : 'Existing installation method';
      $('framework').textContent = !value.managed
        ? 'See Mods'
        : {none: 'Vanilla', carbon: 'Carbon', oxide: 'Oxide / uMod'}[
            value.framework
          ] ||
          value.framework ||
          'Vanilla';
      $('setup-note').hidden = !value.managed;
      $('progress').textContent =
        value.activeJob?.message ||
        (pending()
          ? 'Retained phase: ' +
            (value.change?.pending
              ? value.change.phase
              : value.installation.phase
            ).replaceAll('-', ' ')
          : getStatus()?.running
            ? 'Rust is running.'
            : 'Rust is stopped.');
      $('progress').setAttribute('aria-busy', String(!!value.activeJob));
      $('update').hidden =
        !value.updates?.available ||
        (!value.updates.pending && value.updates.phase !== 'reviewed');
      $('update-note').textContent = value.updates?.updateAvailable
        ? 'A different exact build is available for review.'
        : value.updates?.phase === 'reviewed'
          ? 'The checked build is already installed.'
          : 'Last retained update: ' + (value.updates?.phase || 'none');
      const update = value.updates;
      $('build-selection').textContent = update?.target
        ? 'Build ' +
          update.current.softwareVersion +
          ' → ' +
          update.target.softwareVersion +
          ' · ' +
          update.target.platform +
          ' · ' +
          update.target.channel
        : '';
      $('framework-selection').textContent = update?.framework
        ? 'Framework: ' +
          update.framework +
          (update.frameworkVersion ? ' · ' + update.frameworkVersion : '')
        : '';
      $('selection').textContent = update?.available
        ? JSON.stringify(
            {
              current: update.current,
              target: update.target,
              framework: update.framework,
              frameworkVersion: update.frameworkVersion,
              frameworkSha256: update.frameworkSha256,
              compilerSha256: update.compilerSha256,
            },
            null,
            2,
          )
        : '';
      $('recovery').hidden = !value.managed || !pending();
      $('recovery-note').textContent =
        recoveryKind() === 'initial'
          ? 'Initial software preparation was interrupted. Inspect it before retrying.'
          : metadataOnly()
            ? 'A retained update check can be closed without stopping Rust. You can also check again for a fresh review.'
            : recoveryKind() === 'framework' &&
                value.change.phase === 'prepared'
              ? 'A framework is prepared. Start to validate it, or recover the previous software and world.'
              : 'A paired change needs recovery to its previous software and matching world.';
      controls();
    }
    async function load(ctx) {
      const next = await ctx.request('/software-setup');
      if (!ctx.isCurrent()) return;
      if (
        JSON.stringify([value?.change, value?.installation]) !==
        JSON.stringify([next.change, next.installation])
      ) {
        inspection = null;
        $('inspection').textContent = '';
      }
      value = next;
      paint();
    }
    async function perform(work) {
      if (working || hostBusy()) return;
      const activation = context;
      working = true;
      controls();
      $('error').hidden = true;
      try {
        await work();
      } catch (error) {
        if (activation.isCurrent()) inspection = null;
        if (activation.isCurrent()) {
          $('error').textContent = error.message;
          $('error').hidden = false;
        }
      } finally {
        if (context === activation) working = false;
        if (activation.isCurrent()) controls();
      }
    }
    async function run(name, params = {}) {
      inspection = null;
      if (!context.isCurrent() || !canAction(name)) return;
      const activation = context;
      await job(name, params, {wait: true});
      if (activation.isCurrent()) await load(activation);
    }
    return {
      async mount(ctx) {
        context = ctx;
        value = null;
        inspection = null;
        working = false;
        const response = await fetch(serverPath('/rust/software.html'), {
          signal: ctx.signal,
        });
        if (!response.ok) throw Error('Software tools could not be loaded.');
        const template = await response.text();
        if (!ctx.isCurrent()) return;
        ctx.render(template);
        root = ctx.root;
        ctx.on($('refresh'), 'click', () => perform(() => load(ctx)));
        ctx.on($('start'), 'click', () => perform(() => run('start')));
        ctx.on($('stop'), 'click', () =>
          perform(async () => {
            if (
              await ctx.confirm(
                'Save and stop Rust?',
                'Connected players will be disconnected. Rust saves before stopping.',
                'Save and stop',
              )
            )
              await run('stop', {confirm: true});
          }),
        );
        ctx.on($('check'), 'click', () => perform(() => run(action('check'))));
        ctx.on($('apply'), 'click', () =>
          perform(async () => {
            const reviewed = value.updates;
            if (
              !reviewed?.updateAvailable ||
              Date.now() >= Date.parse(reviewed.expires)
            )
              return;
            if (
              await ctx.confirm(
                'Apply reviewed Steam update?',
                'Install build ' +
                  reviewed.target.softwareVersion +
                  '? Rust will save and stop. Recovery restores the earlier world and software together; newer data is retained privately.',
                'Apply update',
              )
            )
              await run(action('update'), {planId: reviewed.id, confirm: true});
          }),
        );
        ctx.on($('inspect'), 'click', () =>
          perform(async () => {
            const kind = recoveryKind(),
              route =
                kind === 'software'
                  ? '/software-change'
                  : kind === 'framework'
                    ? '/framework-change'
                    : '/software';
            const observed = await ctx.request(route);
            if (!ctx.isCurrent()) return;
            inspection = observed;
            $('inspection').textContent = observed.review
              ? 'Inspected phase: ' +
                (observed.phase || value.installation.phase) +
                '. Recover only if these consequences are acceptable. Any changed observation requires another inspection.'
              : 'No recoverable installation was found.';
          }),
        );
        ctx.on($('cancel'), 'click', () =>
          perform(async () => {
            if (
              await ctx.confirm(
                'Stop retained preparation?',
                'Cancel only the retained private preparation. Inspect again afterwards before recovering.',
                'Stop preparation',
              )
            )
              await run('software-cancel', {confirm: true});
          }),
        );
        ctx.on($('recover'), 'click', () =>
          perform(async () => {
            const reviewed = inspection;
            if (!reviewed?.review) return;
            if (
              await ctx.confirm(
                'Recover inspected state?',
                metadataOnly()
                  ? 'Close the inspected update check. The running server and world are not changed.'
                  : 'Restore the inspected previous software and matching earlier world when retained. Newer data stays private. Initial setup recovery resumes preparation; it does not start Rust.',
                'Recover state',
              )
            )
              await run(recoverAction(), {
                review: reviewed.review,
                confirm: true,
              });
          }),
        );
        const timer = setInterval(() => {
          if (ctx.isCurrent()) controls();
        }, 1000);
        ctx.onDispose(() => clearInterval(timer));
        await load(ctx);
      },
      async refresh(ctx, options) {
        if (options.reason === 'status') controls();
        else if (!working) await load(ctx);
      },
      dispose() {
        inspection = null;
        root = null;
      },
    };
  },
};
