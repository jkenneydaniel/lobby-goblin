import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {acceptanceTarget} from './image-acceptance-target.js';

export function migrationAcceptance(
  game,
  definition,
  root,
  {run = execFileSync, env = process.env} = {},
) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') return;
  const target = definition.image;
  const expectedId = run(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}', target],
    {encoding: 'utf8'},
  ).trim();
  acceptanceTarget(game, {
    ACCEPTANCE_TARGET_IMAGE: target,
    ACCEPTANCE_TARGET_ID: expectedId,
  });
  assert.match(expectedId, /^sha256:[a-f0-9]{64}$/);
  const panel = 'local/lobby-' + game + '-acceptance';
  run('docker', ['build', '-t', panel, root + '/panel'], {stdio: 'inherit'});
  for (const extra of game === 'rust' ? [[], ['--fresh', '--mods']] : [[]])
    run(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '0:0',
        '--memory',
        '1g',
        '--mount',
        'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
        '--mount',
        'type=bind,source=' + root + ',target=/source,readonly',
        '--workdir',
        '/source',
        '-e',
        'ACCEPTANCE_PANEL_IMAGE=' + panel,
        '-e',
        'ACCEPTANCE_TARGET_IMAGE=' + target,
        '-e',
        'ACCEPTANCE_TARGET_ID=' + expectedId,
        '--entrypoint',
        'node',
        panel,
        'panel/test/image-acceptance.mjs',
        game,
        ...extra,
      ],
      {stdio: 'inherit'},
    );
}
