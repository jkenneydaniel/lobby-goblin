import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {imagePolicies} from '../applications/image-policies.js';
import {
  acceptanceTarget,
  validateAcceptanceImage,
} from './image-acceptance-target.js';
import {migrationAcceptance} from './package-image-acceptance.mjs';
const id = 'sha256:' + 'a'.repeat(64),
  root = fileURLToPath(new URL('../../', import.meta.url));
test('native publication acceptance uses each package recipe and exact image ID while keeping installed defaults', async () => {
  for (const game of ['factorio', 'rust']) {
    const {imageDefinition} = await import(
      '../applications/' + game + '/images/build.mjs'
    );
    const definition = await imageDefinition(),
      calls = [];
    const run = (program, args) => {
      assert.equal(program, 'docker');
      calls.push(args);
      return id + '\n';
    };
    migrationAcceptance(game, definition, root, {
      run,
      env: {GITHUB_EVENT_NAME: 'pull_request'},
    });
    assert.equal(calls.length, 0);
    migrationAcceptance(game, definition, root, {
      run,
      env: {GITHUB_EVENT_NAME: 'workflow_dispatch'},
    });
    assert.deepEqual(calls[0], [
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      definition.image,
    ]);
    const runs = calls.filter((args) => args[0] === 'run');
    assert.equal(runs.length, game === 'rust' ? 2 : 1);
    for (const args of runs) {
      assert.ok(args.includes('ACCEPTANCE_TARGET_IMAGE=' + definition.image));
      assert.ok(args.includes('ACCEPTANCE_TARGET_ID=' + id));
    }
    if (game === 'rust') {
      assert.match(definition.image, /steam-lg\.4$/);
      assert.match(acceptanceTarget(game, {}).target, /steam-lg\.2$/);
      assert.ok(runs[1].includes('--mods'));
    }
    const target = acceptanceTarget(game, {
      ACCEPTANCE_TARGET_IMAGE: definition.image,
      ACCEPTANCE_TARGET_ID: id,
    });
    const policy = imagePolicies[game],
      match = new RegExp(policy.referencePattern).exec(target.target);
    const image = {
      Id: id,
      Os: 'linux',
      Architecture: policy.architecture,
      Config: {
        Labels: {
          ...policy.labels,
          ...Object.fromEntries(
            Object.entries(policy.captureLabels).map(([key, capture]) => [
              key,
              match.groups[capture],
            ]),
          ),
        },
      },
    };
    validateAcceptanceImage(game, target.target, id, image);
    assert.throws(
      () =>
        validateAcceptanceImage(
          game,
          target.target,
          'sha256:' + 'b'.repeat(64),
          image,
        ),
      /build changed/,
    );
    assert.throws(
      () => acceptanceTarget(game, {ACCEPTANCE_TARGET_IMAGE: definition.image}),
      /immutable/,
    );
    assert.throws(
      () =>
        acceptanceTarget(game, {
          ACCEPTANCE_TARGET_IMAGE: 'unreviewed:latest',
          ACCEPTANCE_TARGET_ID: id,
        }),
      /Unreviewed/,
    );
  }
});
test('historical Factorio describe commands remain usable without Docker', () => {
  for (const command of ['describe', 'runtime-describe']) {
    const output = execFileSync(
      process.execPath,
      [root + '/tools/factorio-image.mjs', command],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DOCKER_HOST: 'unix:///nonexistent-disposable-describe.sock',
        },
      },
    );
    assert.match(
      JSON.parse(output).image,
      /ghcr.io\/jkenneydaniel\/factorio-server:/,
    );
  }
});
