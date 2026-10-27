import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedApplication} from '../applications/index.js';
import {validateApplicationModule} from '../core/application-module.js';
import {
  permissionCatalogFor,
  normalizeGrants,
  publicAccess,
  requireServerPermission,
} from '../core/permissions.js';

const scope = '/servers/' + 'a'.repeat(32);
const member = (permissions) => ({
  role: 'member',
  grants: {[scope]: ['server.view', ...permissions]},
});
const permits = (module, permissions, method, route, action) =>
  requireServerPermission(member(permissions), scope, method, route, {
    module,
    action,
  });
const denied = (work) => assert.throws(work, (error) => error.status === 403);

test('Rust Steam updates require image and lifecycle authority and modded updates additionally require executable framework authority', () => {
  const module = selectedApplication('rust'),
    vanilla = ['images.change', 'server.operate'],
    modded = [...vanilla, 'mods.manage', 'application.rust.framework.manage'];
  permits(module, ['images.change'], 'POST', '/jobs', 'software-check');
  permits(module, ['images.change'], 'POST', '/jobs', 'software-recover');
  permits(module, vanilla, 'POST', '/jobs', 'software-update');
  for (const grants of [[], ['images.change'], ['server.operate']])
    denied(() => permits(module, grants, 'POST', '/jobs', 'software-update'));
  for (const action of [
    'software-check-modded',
    'software-update-modded',
    'software-recover-modded',
  ]) {
    permits(module, modded, 'POST', '/jobs', action);
    for (const grants of [
      vanilla,
      ['mods.manage', 'application.rust.framework.manage'],
      [...vanilla, 'mods.manage'],
      [...vanilla, 'application.rust.framework.manage'],
    ])
      denied(() => permits(module, grants, 'POST', '/jobs', action));
  }
});

test('Factorio map permissions are independent of world management, each other and other instances', () => {
  const module = selectedApplication('factorio');
  for (const permission of Object.keys(module.contract.policy.permissions)) {
    assert.ok(permission.startsWith('application.factorio.'));
    assert.deepEqual(
      normalizeGrants(
        {[scope]: ['server.view', permission]},
        permissionCatalogFor(module),
      )[scope],
      [permission, 'server.view'],
    );
  }
  const view = 'application.factorio.map.view';
  for (const route of ['/map', '/map-status', '/live-players', '/preview']) {
    denied(() => permits(module, ['worlds.manage'], 'GET', route));
    permits(module, [view], 'GET', route);
  }
  const features = [
    ['application.factorio.map.generate', 'POST', '/jobs', 'refresh-map'],
    ['application.factorio.map.pins', 'POST', '/pins'],
    ['application.factorio.map.tracking', 'POST', '/jobs', 'live-tracking'],
  ];
  for (const [permission, method, route, action] of features) {
    permits(module, [permission], method, route, action);
    denied(() =>
      permits(module, ['worlds.manage', view], method, route, action),
    );
    for (const [other] of features)
      if (other !== permission)
        denied(() => permits(module, [other], method, route, action));
    assert.throws(
      () =>
        requireServerPermission(
          member([permission]),
          '/hosts/' + 'b'.repeat(32) + scope,
          method,
          route,
          {module, action},
        ),
      (error) => error.status === 404,
    );
  }
  for (const action of ['create', 'switch', 'world-options']) {
    permits(module, ['worlds.manage'], 'POST', '/jobs', action);
    denied(() =>
      permits(
        module,
        features.map(([permission]) => permission),
        'POST',
        '/jobs',
        action,
      ),
    );
  }
  assert.equal(
    module.presentation.screens.find((screen) => screen.id === 'map')
      .permission,
    view,
  );
});

test('Rust package permissions narrow executable mods and cover alternate catalogue and configuration routes', () => {
  const module = selectedApplication('rust');
  const capabilities = [
    {
      permission: 'application.rust.framework.manage',
      actions: ['install-framework', 'recover-framework'],
      routes: [['POST', '/mods-plan']],
    },
    {
      permission: 'application.rust.plugins.manage',
      actions: ['plugin', 'mod-library-install', 'mod-library-recover'],
      routes: [
        ['GET', '/mod-library'],
        ['POST', '/mod-library-plan'],
      ],
    },
    {
      permission: 'application.rust.plugins.configure',
      actions: ['plugin-config'],
      routes: [['GET', '/plugin-config']],
    },
  ];
  for (const {permission, actions, routes} of capabilities) {
    for (const grants of [[], ['mods.manage'], [permission]]) {
      for (const action of actions)
        denied(() => permits(module, grants, 'POST', '/jobs', action));
      for (const [method, route] of routes)
        denied(() => permits(module, grants, method, route));
      assert.deepEqual(
        publicAccess(member(grants), scope, module).allowedActions,
        [],
      );
    }
    const grants = ['mods.manage', permission];
    for (const action of actions)
      permits(module, grants, 'POST', '/jobs', action);
    for (const [method, route] of routes)
      permits(module, grants, method, route);
    assert.deepEqual(
      publicAccess(member(grants), scope, module).allowedActions.sort(),
      [...actions].sort(),
    );
    for (const {permission: other, actions: otherActions} of capabilities)
      if (other !== permission)
        for (const action of otherActions)
          denied(() => permits(module, grants, 'POST', '/jobs', action));
    denied(() => permits(module, grants, 'POST', '/jobs', 'start'));
    denied(() =>
      permits(selectedApplication('factorio'), grants, 'GET', '/map'),
    );
  }
});

test('combined permission contracts reject empty, duplicate, unknown, nested or weakened shared grants', () => {
  const module = selectedApplication('rust');
  for (const permission of [
    [],
    ['mods.manage', 'mods.manage'],
    ['mods.manage', 'application.rust.missing'],
    [['mods.manage']],
    ['application.rust.plugins.manage'],
  ]) {
    const changed = {
      ...module,
      contract: {
        ...module.contract,
        actions: {
          ...module.contract.actions,
          'mod-library-install': {
            ...module.contract.actions['mod-library-install'],
            permission,
          },
        },
      },
    };
    assert.throws(() => validateApplicationModule(changed));
  }
  for (const requirement of [
    [],
    ['mods.manage', null],
    ['mods.manage', 'application.factorio.map.view'],
  ]) {
    const changed = {
      ...module,
      contract: {
        ...module.contract,
        policy: {
          ...module.contract.policy,
          routes: {
            ...module.contract.policy.routes,
            '/mods-plan': {POST: requirement},
          },
        },
      },
    };
    assert.throws(() => validateApplicationModule(changed));
  }
});
