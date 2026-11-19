import {navigationAllowed} from './shared/access.js';
import {fleetMarkPng, icon} from './icons.js';
import {pagePath, serverPath} from './scope.js';
import {serverState} from './client.js';

// The same shell surrounds fleet and game screens, including standalone installs.
export function mountProductShell({
  area = 'server',
  game = '',
  kind = 'game',
  onboarding = false,
  navigation = [],
  onLogout = () => {},
} = {}) {
  const root = document.createElement('div');
  root.className = 'product-shell';
  root.hidden = true;
  root.innerHTML = `<header class="product-header"><a class="product-brand" aria-label="Lobby Goblin home"><span class="product-mark" aria-hidden="true">LG</span><span>Lobby Goblin</span></a><div class="product-context"><a class="product-back">All servers</a><span class="product-context-label"></span><strong class="product-context-name"></strong></div><span class="product-status" role="status">Checking…</span><div class="product-account"><span class="product-user"></span><button class="product-signout" type="button">Sign out</button></div></header><nav class="product-navigation" aria-label="${area === 'fleet' ? 'Panel' : 'Server'} navigation"></nav><div class="product-operation" role="status" aria-live="polite" hidden><span class="product-spinner" aria-hidden="true"></span><span></span></div><div class="product-feedback" role="status" aria-live="polite" hidden></div><dialog class="product-confirm" aria-labelledby="product-confirm-title"><form method="dialog"><p class="product-eyebrow">SERVER OPERATION</p><h2 id="product-confirm-title"></h2><p class="product-confirm-message"></p><div class="product-confirm-actions"><button value="cancel">Cancel</button><button class="product-confirm-yes" value="confirm">Continue</button></div></form></dialog>`;
  const existingSkip = document.querySelector('.skip-link');
  if (existingSkip) existingSkip.after(root);
  else {
    document.body.prepend(root);
    const main = document.querySelector('main');
    if (main) {
      main.id ||= 'product-content';
      main.tabIndex = -1;
      const skip = document.createElement('a');
      skip.className = 'product-skip';
      skip.href = '#' + main.id;
      skip.textContent = 'Skip to content';
      skip.addEventListener('click', (event) => {
        event.preventDefault();
        main.focus();
      });
      document.body.prepend(skip);
    }
  }
  document.body.dataset.productShell = area;
  const find = (selector) => root.querySelector(selector);
  const recovery = document.createElement('section');
  recovery.className = 'product-recovery';
  recovery.hidden = true;
  recovery.setAttribute('aria-label', 'Operation recovery');
  root.append(recovery);
  let recoverySignature = '';
  const fleet = area === 'fleet',
    nav = find('.product-navigation'),
    account = find('.product-account'),
    username = find('.product-user');
  let closeNavigation = () => {};
  if (fleet) {
    const main = document.querySelector('main'),
      header = find('.product-header'),
      sidebar = document.createElement('div'),
      menu = document.createElement('button'),
      backdrop = document.createElement('div'),
      compact = matchMedia('(max-width: 860px)');
    sidebar.className = 'fleet-sidebar';
    sidebar.id = 'fleet-sidebar';
    menu.type = 'button';
    menu.className = 'fleet-menu-toggle';
    menu.setAttribute('aria-controls', sidebar.id);
    backdrop.className = 'fleet-menu-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    const mark = document.createElement('img'),
      markUrl = URL.createObjectURL(
        new Blob(
          [Uint8Array.from(atob(fleetMarkPng), (char) => char.charCodeAt(0))],
          {type: 'image/png'},
        ),
      );
    mark.className = 'product-mark';
    mark.alt = '';
    mark.addEventListener('load', () => URL.revokeObjectURL(markUrl), {
      once: true,
    });
    mark.src = markUrl;
    find('.product-mark').replaceWith(mark);
    sidebar.append(nav, account);
    header.prepend(menu);
    header.after(backdrop, sidebar);
    const items = () =>
      [...sidebar.querySelectorAll('a, button')].filter(
        (node) => node.getClientRects().length,
      );
    function toggle(open, restoreFocus = false) {
      sidebar.inert = compact.matches && !open;
      main.inert = open;
      backdrop.hidden = !open;
      root.classList.toggle('fleet-menu-open', open);
      menu.setAttribute('aria-expanded', String(open));
      menu.innerHTML = icon(open ? 'x' : 'menu-2') + (open ? 'Close' : 'Menu');
      if (open)
        (nav.querySelector('[aria-current="page"]') || items()[0])?.focus();
      else if (restoreFocus && compact.matches) menu.focus();
    }
    closeNavigation = () => toggle(false);
    toggle(false);
    menu.addEventListener('click', () => {
      const open = menu.getAttribute('aria-expanded') === 'true';
      toggle(!open);
    });
    backdrop.addEventListener('click', () => toggle(false, true));
    compact.addEventListener('change', closeNavigation);
    document.addEventListener('keydown', (event) => {
      if (backdrop.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        toggle(false, true);
      } else if (event.key === 'Tab') {
        const last = items().at(-1);
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          menu.focus();
        } else if (event.shiftKey && document.activeElement === menu && last) {
          event.preventDefault();
          last.focus();
        }
      }
    });
    nav.addEventListener('click', (event) => {
      if (backdrop.hidden || !event.target.closest('a')) return;
      toggle(false, true);
    });
  }
  const scoped = serverPath('/') !== '/';
  find('.product-brand').href =
    area === 'fleet' || scoped ? '/' : pagePath('#overview');
  find('.product-back').href = '/';
  find('.product-back').hidden = !scoped;
  find('.product-context-label').textContent = fleet
    ? 'Fleet'
    : kind === 'game'
      ? game + ' SERVER'
      : kind.toUpperCase();
  if (area !== 'fleet' && kind !== 'game') {
    find('.product-navigation').setAttribute(
      'aria-label',
      'Application navigation',
    );
    find('.product-eyebrow').textContent = 'APPLICATION OPERATION';
  }
  find('.product-context-name').textContent = fleet ? 'Servers' : game;
  find('.product-signout').addEventListener('click', onLogout);
  const groups = new Map();
  const links = navigation.map((item) => {
    const link = document.createElement('a');
    link.href = pagePath('#' + item.id);
    link.textContent = item.label;
    link.dataset.shellPage = item.id;
    if (fleet) {
      const name = item.group || 'Fleet';
      if (!groups.has(name)) {
        const group = document.createElement('div'),
          title = document.createElement('p');
        group.className = 'fleet-navigation-group';
        title.textContent = name;
        group.append(title);
        nav.append(group);
        groups.set(name, group);
      }
      if (item.icon) link.insertAdjacentHTML('afterbegin', icon(item.icon));
      groups.get(name).append(link);
    } else nav.append(link);
    return {item, link};
  });
  let timer,
    confirming = false,
    recoveryAction = null,
    recoveryEpoch = 0,
    principalKey = '';
  return {
    session(user) {
      const key = user
        ? JSON.stringify([user.username, user.role, user.csrf])
        : '';
      if (key !== principalKey) {
        principalKey = key;
        recoveryEpoch++;
        recoverySignature = '';
        if (find('.product-confirm').open) find('.product-confirm').close();
        closeNavigation();
      }
      root.hidden = !user;
      document.body.dataset.productSession = user ? 'signed-in' : 'signed-out';
      const role = user
        ? user.role === 'admin'
          ? 'Administrator'
          : user.role === 'member'
            ? 'Assigned servers'
            : 'Read-only'
        : '';
      if (fleet && user) {
        const avatar = document.createElement('span'),
          identity = document.createElement('strong'),
          permission = document.createElement('small');
        avatar.className = 'fleet-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = Array.from(user.username)[0]?.toUpperCase();
        identity.textContent = user.username;
        permission.textContent = role;
        username.replaceChildren(avatar, identity, permission);
      } else username.textContent = user ? user.username + ' · ' + role : '';
      const guided =
        typeof onboarding === 'function' ? onboarding() : onboarding;
      nav.hidden =
        guided &&
        !!user &&
        user.role === 'admin' &&
        user.onboarding?.completed === false;
      for (const {item, link} of links)
        link.hidden = !navigationAllowed(item, user);
      for (const group of groups.values())
        group.hidden = !group.querySelector('a:not([hidden])');
      if (!user) {
        recovery.hidden = true;
        recoveryAction = null;
        recoverySignature = '';
        clearTimeout(timer);
        find('.product-feedback').hidden = true;
        find('.product-operation').hidden = true;
      }
    },
    active(page) {
      for (const {item, link} of links)
        if (item.id === page) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      if (fleet)
        find('.product-context-name').textContent =
          links.find(({item}) => item.id === page)?.item.label || 'Servers';
    },
    attention(page, message = '') {
      const entry = links.find(({item}) => item.id === page);
      if (!entry) return;
      entry.link.dataset.attention = String(!!message);
      entry.link.title = message;
      entry.link.setAttribute(
        'aria-label',
        message ? entry.item.label + ': ' + message : entry.item.label,
      );
    },
    status(value) {
      const state =
          area === 'fleet' && value
            ? {
                label: value.ready ? 'Connected' : 'Host unavailable',
                state: value.ready ? 'ready' : 'attention',
              }
            : serverState(value),
        badge = find('.product-status');
      badge.textContent = state.label;
      badge.dataset.state = state.state;
      if (value?.name) find('.product-context-name').textContent = value.name;
      this.operation(value?.activeJob);
    },
    operation(job) {
      const node = find('.product-operation');
      node.hidden = !job || !['running', 'queued'].includes(job.state);
      node.lastElementChild.textContent = job?.message || 'Working…';
    },
    recovery(jobs, onAction, {admin = false} = {}) {
      recoveryAction = onAction;
      const pending = (jobs || []).filter((job) => job.recovery?.required);
      const signature = JSON.stringify([pending, admin]);
      if (signature === recoverySignature) return;
      recoverySignature = signature;
      recovery.replaceChildren();
      recovery.hidden = !pending.length;
      if (!pending.length) return;
      const title = document.createElement('h2');
      title.textContent = 'Review interrupted operations';
      recovery.append(title);
      const intro = document.createElement('p');
      intro.textContent =
        'Check what completed before making more changes. These checks do not replay operations.';
      recovery.append(intro);
      for (const job of pending) {
        const row = document.createElement('article'),
          detail = document.createElement('p');
        detail.textContent =
          (job.hostName ? job.hostName + ' · ' : '') +
          job.action.replaceAll('-', ' ') +
          ': ' +
          (job.recovery.message || job.message);
        row.append(detail);
        if (admin) {
          const button = (label, operation) => {
            const node = document.createElement('button');
            node.type = 'button';
            node.textContent = label;
            node.addEventListener('click', async () => {
              const epoch = recoveryEpoch;
              if (
                operation !== 'inspect' &&
                !(await this.confirm(
                  operation === 'retry'
                    ? 'Retry this operation?'
                    : 'Acknowledge this operation?',
                  operation === 'retry'
                    ? 'Retry only the requested start or stop. Check the server and connected players first.'
                    : 'Confirm you reviewed server status, logs and backups. The original outcome will remain recorded.',
                ))
              )
                return;
              if (
                epoch !== recoveryEpoch ||
                signature !== recoverySignature ||
                !recoveryAction
              )
                return;
              node.disabled = true;
              try {
                await recoveryAction(job, operation);
              } catch (error) {
                this.notify(error.message, {error: true});
              } finally {
                node.disabled = false;
              }
            });
            row.append(node);
          };
          if (job.source) {
            for (const action of job.recovery.actions || []) {
              if (action.id === 'open') {
                if (!/^#[a-z][a-z0-9/-]{0,100}$/.test(action.href)) continue;
                const link = document.createElement('a');
                link.className = 'button';
                link.textContent = action.label;
                link.href = pagePath(action.href);
                row.append(link);
              } else if (['inspect', 'acknowledge'].includes(action.id))
                button(action.label, action.id);
            }
          } else {
            button('Check outcome', 'inspect');
            if (job.recovery.checkedAt) {
              button('I’ve reviewed this operation', 'acknowledge');
              if (job.recovery.retryable) button('Retry operation', 'retry');
            }
          }
        }
        recovery.append(row);
      }
    },
    notify(
      message,
      {error = false, timeout = error ? 10000 : 6500, source = ''} = {},
    ) {
      const node = find('.product-feedback');
      if (
        !message &&
        (node.dataset.error !== String(error) || node.dataset.source !== source)
      )
        return;
      clearTimeout(timer);
      node.textContent = message;
      node.hidden = !message;
      node.dataset.error = String(error);
      node.dataset.source = source;
      node.setAttribute('role', error ? 'alert' : 'status');
      if (message && timeout)
        timer = setTimeout(() => {
          node.hidden = true;
        }, timeout);
    },
    async confirm(title, message, label = 'Continue') {
      if (confirming) return false;
      confirming = true;
      const dialog = find('.product-confirm');
      find('#product-confirm-title').textContent = title;
      find('.product-confirm-message').textContent = message;
      find('.product-confirm-yes').textContent = label;
      dialog.returnValue = 'cancel';
      dialog.showModal();
      try {
        return await new Promise((resolve) =>
          dialog.addEventListener(
            'close',
            () => resolve(dialog.returnValue === 'confirm'),
            {once: true},
          ),
        );
      } finally {
        confirming = false;
      }
    },
  };
}
