import {createApi, pollEvery, serverState} from '../client.js';
import {serverPath, pagePath} from '../scope.js';
import {createSessionController} from '../shared/session.js';
import {createOperationController} from '../shared/operations.js';
import {createScreenRouter} from '../shared/screens.js';
import {
  can as permission,
  canAction as actionAllowed,
  navigationAllowed,
} from '../shared/access.js';
import {mountProductShell} from '../shell.js';
import {loadApplicationTemplates} from './templates.js';
import {createApplicationComponents} from './components.js';
import {applicationRoutes, resolveApplicationRoute} from './definition.js';

// The normal entrypoint has no application code. A reviewed extension package
// may pass a fixed registry here; definitions cannot name executable imports.
export async function mountApplication({extensions = {}} = {}) {
  const $ = (selector) => document.querySelector(selector);
  const events = new AbortController();
  let user = null,
    status = null,
    shell = null,
    router = null,
    operations = null,
    refreshing = false,
    epoch = 0,
    currentRoute = null,
    navigationAttempt = 0;
  const callbacks = new Map(),
    providers = [...new Set(Object.values(extensions))];
  for (const provider of providers)
    for (const name of ['beforeSignOut', 'onSessionEnd'])
      if (provider[name] !== undefined && typeof provider[name] !== 'function')
        throw Error('Invalid application extension lifecycle hook.');
  const can = (name) => permission(user, name),
    canAction = (name) => actionAllowed(user, name);
  function notify(message, error = false) {
    shell?.notify(message, {error});
    if (!user) $('#auth-error').textContent = message;
  }
  function signedOut() {
    epoch++;
    navigationAttempt++;
    router?.reset();
    operations?.reset();
    callbacks.clear();
    for (const provider of providers) provider.onSessionEnd?.();
    status = null;
    for (const root of document.querySelectorAll('[data-view]'))
      root.replaceChildren();
    shell?.session(null);
    $('#shell').hidden = true;
    $('#auth').hidden = false;
    $('#session-loading').hidden = true;
  }
  const request = createApi({
    base: serverPath('/api'),
    getSession: () => user,
    onUnauthorized: () => {
      if (user) {
        session.set(null);
        signedOut();
      }
    },
  });
  const accountRequest = createApi();
  const session = createSessionController({
    async request(route, options) {
      if (route !== '/login' || !serverPath('')) return request(route, options);
      // Fleet credentials use the central login and its shared attempt limit.
      // Only the scoped session can supply this application's permissions.
      await accountRequest(route, options);
      try {
        return await request('/session');
      } catch (error) {
        // The account may no longer have this server, or its host may be down.
        // Authentication succeeded, so continue at the accessible server list.
        location.assign('/');
        throw error;
      }
    },
    onChange: (value) => {
      user = value;
      shell?.session(value);
    },
  });
  async function assetContract() {
    const response = await fetch(serverPath('/application-definition.json'));
    if (!response.ok)
      throw Error(
        'This application does not provide a shared panel definition.',
      );
    return response.json();
  }
  const [contract, clone] = await Promise.all([
    assetContract(),
    loadApplicationTemplates(),
  ]);
  const presentation = contract.presentation;
  if (presentation?.version !== 1)
    throw Error('Unsupported application presentation.');
  const routes = applicationRoutes(presentation);
  document.title = 'Lobby Goblin · ' + contract.name;
  shell = mountProductShell({
    game: contract.name,
    kind: presentation.kind,
    navigation: contract.screens,
    onboarding: () =>
      !!presentation.onboarding &&
      currentRoute?.parent.id === presentation.onboarding.screen,
    onLogout: async () => {
      try {
        for (const provider of providers) await provider.beforeSignOut?.();
        await session.signOut();
        signedOut();
        location.reload();
      } catch (error) {
        notify(error.message, true);
      }
    },
  });
  const content = $('#application-content');
  for (const route of routes) {
    const root = document.createElement('section');
    root.dataset.view = route.id;
    root.hidden = true;
    content.append(root);
  }
  operations = createOperationController({
    request,
    shell,
    isAdmin: () => user?.role === 'admin',
    includeWorkflows: true,
    notify,
    onChange: (controller) => {
      shell.attention(
        'operations',
        controller.workflowUnavailable ? 'Workflow progress unavailable' : '',
      );
      if (status) void router?.refresh({reason: 'status'});
    },
    onRecovery: () => router.refresh({reason: 'recovery'}),
    onSettled: async (job) => {
      const callback = callbacks.get(job.id);
      callbacks.delete(job.id);
      if (callback) await callback(job);
      if (currentRoute && location.hash.slice(1) !== currentRoute.path)
        await navigate();
      else
        await router.refresh({
          reason: 'operation',
          action: job.action,
          state: job.state,
          preserveSchedule: true,
        });
    },
  });
  async function refresh() {
    if (!user || (user.role === 'member' && !can('server.view')) || refreshing)
      return;
    const principal = user,
      attempt = epoch;
    refreshing = true;
    try {
      const [value, jobs] = await Promise.all([
        request('/status'),
        request(user.role === 'admin' ? '/jobs?workflows=1' : '/jobs'),
      ]);
      if (user !== principal || epoch !== attempt) return;
      status = value;
      shell.status(value);
      await operations.update(jobs);
      if (user !== principal || epoch !== attempt) return;
      $('#connection-state').textContent = serverState(value).label;
      $('#connection-warning').textContent =
        value.imageMigration?.message || value.error || '';
      $('#connection-warning').hidden = !value.imageMigration && !value.error;
      await router.refresh({reason: 'status'});
    } catch (error) {
      if (user !== principal || epoch !== attempt) return;
      status = null;
      shell.status(null);
      $('#connection-state').textContent = 'Controller unavailable';
      $('#connection-warning').textContent = error.message;
      $('#connection-warning').hidden = false;
      await router.refresh({reason: 'status'});
    } finally {
      refreshing = false;
    }
  }
  async function startJob(action, params = {}, options = {}) {
    const principal = user,
      version = epoch;
    if (operations.busy || !canAction(action)) return;
    if (contract.actions[action]?.confirmation && !params.confirm) {
      const confirmation = presentation.confirmations?.[action] || {
        title: contract.actions[action].label + '?',
        message:
          'This operation can interrupt the application. Continue only when you are ready.',
      };
      if (!(await shell.confirm(confirmation.title, confirmation.message)))
        return;
      params = {...params, confirm: true};
    }
    if (user !== principal || epoch !== version || !canAction(action)) return;
    const job = await operations.start(action, params, {
      wait: options.wait === true,
      onAccepted: async (job) => {
        if (options.onSettled) callbacks.set(job.id, options.onSettled);
        await options.onAccepted?.(job);
      },
    });
    await refresh();
    return job;
  }
  router = createScreenRouter({
    factories: createApplicationComponents({
      presentation: {
        ...presentation,
        screens: routes.map((route) => ({...route.screen, id: route.id})),
      },
      contract,
      clone,
      getStatus: () => status,
      getSession: () => user,
      sessionController: session,
      operations,
      can,
      canAction,
      startJob,
      notify,
      extensions,
      extensionContext: {
        request,
        session,
        canAction,
        reload: (options) => router.refresh({reason: 'reload', ...options}),
        refresh,
        attention: (...args) => shell.attention(...args),
        getOperation: () => operations.active,
        recoveryRequired: () => operations.recoveryRequired,
        getRoute: () => currentRoute?.path,
      },
      onSignedOut: () => {
        signedOut();
        location.reload();
      },
    }),
    root: (id) =>
      [...content.children].find((root) => root.dataset.view === id),
    request,
    async prepare(ctx) {
      const route = routes.find((route) => route.id === ctx.root.dataset.view);
      if (route.screen.options?.requiresStatus && !status) {
        status = await ctx.request('/status');
        shell.status(status);
      }
    },
    confirm: (...args) => shell.confirm(...args),
    onError: (error, phase) => {
      notify(error.message, true);
      if (phase !== 'load' || !user || !currentRoute) return;
      const root = [...content.children].find(
          (root) => root.dataset.view === currentRoute.id,
        ),
        fragment = clone('load-error');
      fragment.querySelector('[data-error]').textContent = error.message;
      fragment
        .querySelector('button')
        .addEventListener('click', () => router.refresh({reason: 'reload'}), {
          once: true,
        });
      root.replaceChildren(fragment);
    },
    onChange: (id) => {
      for (const root of content.children) {
        root.hidden = root.dataset.view !== id;
        if (root.hidden) root.replaceChildren();
      }
      shell.active(currentRoute.parent.id);
      shell.session(user);
      $('#page-title').textContent = currentRoute.screen.label;
      const sections = $('#application-sections');
      sections.replaceChildren();
      const parent = currentRoute.parent;
      if (parent.routes?.length) {
        const group = routes.filter(
          (route) =>
            route.parent === parent && routeAllowed(route.screen, true),
        );
        for (const route of group) {
          const link = document.createElement('a');
          link.href = '#' + route.id;
          link.textContent = route.screen.label;
          if (route.id === id) link.setAttribute('aria-current', 'page');
          sections.append(link);
        }
      }
      sections.hidden = !sections.children.length;
      sections.setAttribute('aria-label', parent.label + ' sections');
    },
  });
  function routeAllowed(screen, content = false) {
    return (
      navigationAllowed(screen, user) &&
      (!content ||
        !screen.contentPermission ||
        user?.role !== 'member' ||
        can(screen.contentPermission))
    );
  }
  async function navigate() {
    if (!user) return;
    const version = ++navigationAttempt,
      previous = currentRoute,
      target = resolveApplicationRoute(
        presentation,
        location.hash,
        routeAllowed,
      );
    if (!target) return;
    currentRoute = target;
    if (location.hash.slice(1) !== target.path)
      history.replaceState(null, '', pagePath('#' + target.path));
    const opened = await router.open(target.id, {
      route: target.path,
      reason: 'reload',
    });
    if (version !== navigationAttempt) return;
    if (!opened) {
      currentRoute = previous;
      if (previous)
        history.replaceState(null, '', pagePath('#' + previous.path));
    }
  }
  addEventListener(
    'hashchange',
    () => {
      void navigate().catch((error) => notify(error.message, true));
    },
    {signal: events.signal},
  );
  async function signedIn(value) {
    session.set(value);
    epoch++;
    router.reset();
    operations.reset();
    status = null;
    if (
      !location.hash &&
      value.role === 'admin' &&
      value.onboarding?.completed === false &&
      presentation.onboarding
    )
      history.replaceState(
        null,
        '',
        pagePath('#' + presentation.onboarding.screen),
      );
    $('#auth').hidden = true;
    $('#shell').hidden = false;
    $('#session-loading').hidden = true;
    shell.session(user);
    await navigate();
    await refresh();
  }
  const registration = new URLSearchParams(location.hash.slice(1)).get(
    'register',
  );
  if (registration) {
    history.replaceState(null, '', location.pathname);
    $('#auth-title').textContent = 'Create your account';
    $('#auth-help').textContent =
      'Choose a username and a password of at least 12 characters.';
    $('#login button').textContent = 'Create account';
    $('#login [name=password]').minLength = 12;
    $('#login [name=password]').autocomplete = 'new-password';
    $('#registration-confirmation').hidden = false;
    $('#login [name=confirmation]').disabled = false;
    $('#login [name=confirmation]').required = true;
  }
  $('#login').addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();
      const form = event.currentTarget,
        button = form.querySelector('button');
      button.disabled = true;
      $('#auth-error').textContent = '';
      try {
        const data = Object.fromEntries(new FormData(form));
        if (registration && data.password !== data.confirmation)
          throw Error('The passwords do not match. Please enter them again.');
        delete data.confirmation;
        const value = registration
          ? await session.register({...data, token: registration})
          : await session.signIn(data);
        form.reset();
        await signedIn(value);
      } catch (error) {
        $('#auth-error').textContent = error.message;
      } finally {
        button.disabled = false;
      }
    },
    {signal: events.signal},
  );
  if (registration) signedOut();
  else {
    const initial = await session.bootstrap();
    if (initial) await signedIn(initial);
    else signedOut();
  }
  const timer = pollEvery(refresh, 5000);
  return {
    dispose() {
      clearInterval(timer);
      events.abort();
      signedOut();
    },
  };
}
