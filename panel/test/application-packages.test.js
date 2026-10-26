import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {registeredApplications} from '../applications/index.js';
import {definitionFor} from '../applications/registry.js';
import {applicationDefinition} from '../core/application-definition.js';

const run = promisify(execFile),
  panel = fileURLToPath(new URL('../', import.meta.url));

test('built-in packages bind their checked definitions and keep custom assets inside their package', async () => {
  for (const module of registeredApplications()) {
    assert.equal(module.definition, definitionFor(module.id));
    assert.equal(applicationDefinition(module.definition), module.definition);
    const root = new URL(
      './applications/' + module.id + '/',
      new URL('../', import.meta.url),
    );
    for (const file of module.web.publicRoot ? ['definition.json', 'presentation.json', 'index.js'] : ['definition.json'])
      assert.ok((await fs.stat(new URL(file, root))).isFile());
    if(module.web.publicRoot)assert.equal(module.web.publicRoot.href, new URL('public/', root).href);
    for (const [file] of Object.values(module.web.assets))
      assert.ok((await fs.stat(new URL(file, module.web.publicRoot))).isFile());
  }
});

test(
  'adding a game and a non-game application needs only packages and registry entries',
  {timeout: 20000},
  async (t) => {
    const base = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'lobby-application-packages-')),
    );
    t.after(() => fs.rm(base, {recursive: true, force: true}));
    const before = await fs.readFile(
      path.join(panel, 'applications/registry.json'),
    );
    const prepared = path.join(base, 'prepared');
    await run(
      process.execPath,
      [
        path.join(panel, 'test/prepare-runtime-acceptance.mjs'),
        '--out',
        prepared,
      ],
      {timeout: 15000},
    );
    const runtime = path.join(prepared, 'panel'),
      packageRoot = path.join(runtime, 'applications/web-stack');
    await fs.mkdir(packageRoot);
    const definition = JSON.parse(
      await fs.readFile(
        path.join(panel, 'test/fixtures/service-app-definition.json'),
        'utf8',
      ),
    );
    await fs.writeFile(
      path.join(packageRoot, 'definition.json'),
      JSON.stringify(definition),
    );
    await fs.writeFile(
      path.join(packageRoot, 'presentation.json'),
      JSON.stringify(definition.presentation),
    );
    // These synthetic providers only establish registration. Creating a process,
    // reading installation data or contacting Docker is forbidden in this test.
    await fs.writeFile(
      path.join(packageRoot, 'index.js'),
      `
import {definitionFor} from '../registry.js';
import {createServiceApplication} from '../../core/service-application.js';
const unused=()=>{throw Error('Package loading must not run application processes.');};
const tasks=Object.fromEntries(['initialize','cache','migrate'].map(id=>[id,{inspect:async()=> 'absent',run:unused}]));
export default createServiceApplication(definitionFor('web-stack'),{
 configuration:()=>({container:'synthetic-only',data:'/fixture/data',state:'/fixture/state',library:'/fixture/library',backupDir:'/fixture/backups'}),
 profiles:{'synthetic-process':{roles:['web','worker','scheduler'],imagePolicy:{version:1,defaultImage:'registry.example/service:1',referencePattern:'^registry\\\\.example/service:1$',architecture:'amd64',labels:{},captureLabels:{}},validate(){},create:unused,deploymentTasks:tasks}},
 secretProviders:{'fixture-key':unused},backup:{files:unused,validate:unused},
});
`,
    );
    const registry = path.join(runtime, 'applications/registry.json'),
      ids = JSON.parse(await fs.readFile(registry, 'utf8'));
    assert.deepEqual(ids, ['factorio', 'rust', 'status-page', 'arena']);
    await fs.writeFile(registry, JSON.stringify([...ids, 'web-stack']));
    const check = `
import assert from 'node:assert/strict';
import {registeredApplications,selectedApplication} from './applications/index.js';
import {definitionFor} from './applications/registry.js';
import {imagePolicies} from './applications/image-policies.js';
assert.deepEqual(registeredApplications().map(module=>module.id),['factorio','rust','status-page','arena','web-stack']);
assert.equal(imagePolicies.arena.defaultImage,'node:24-alpine');
const app=selectedApplication('web-stack');
assert.equal(app.definition,definitionFor('web-stack'));
assert.equal(app.definition.kind,'application');
assert.deepEqual(app.web.assets,{});
assert.equal(app.web.extensions,undefined);
console.log('Game and non-game packages loaded through one registry; process providers stayed idle.');
`;
    const result = await run(
      process.execPath,
      ['--input-type=module', '-e', check],
      {
        cwd: runtime,
        timeout: 5000,
        env: {...process.env, DOCKER_SOCKET: path.join(base, 'no-engine.sock')},
      },
    );
    assert.match(result.stdout, /providers stayed idle/);
    assert.deepEqual(
      await fs.readFile(path.join(panel, 'applications/registry.json')),
      before,
    );
    assert.equal(
      await fs.stat(path.join(packageRoot, 'public')).catch(() => null),
      null,
    );
  },
);
