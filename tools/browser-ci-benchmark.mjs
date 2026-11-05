// Branch-only experiment. The required CI workflow and test configuration stay intact.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'output/browser-ci-benchmark');
await fs.mkdir(directory, {recursive: true});
const project = process.env.BENCHMARK_PROJECT || 'all';
if (!['all', 'desktop', 'mobile'].includes(project)) throw Error('Invalid project');
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Use Node 24');
const image = process.env.BENCHMARK_IMAGE === 'true';
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
const evidence = {
  commit: git('rev-parse', 'HEAD'),
  panelTree: git('rev-parse', 'HEAD:panel'),
  workflow: 'browser-ci-benchmark.yml',
  runId: process.env.GITHUB_RUN_ID || null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  repeat: process.env.BENCHMARK_REPEAT || null,
  runnerImage: process.env.ImageOS || null,
  runnerImageVersion: process.env.ImageVersion || null,
  node: process.version,
  npm: execFileSync('npm', ['--version'], {encoding: 'utf8'}).trim(),
  os: await fs.readFile('/etc/os-release', 'utf8'),
  kernel: os.release(),
  arch: os.arch(),
  cpus: os.availableParallelism(),
  memoryBytes: os.totalmem(),
  image: image ? 'mcr.microsoft.com/playwright:v1.64.1-noble' : null,
  project,
  startedAt: new Date().toISOString(),
  phases: [],
  fixtureEvents: [],
};
const started = performance.now();
async function phase(name, command, args, options = {}) {
  const begin = performance.now();
  const record = {name, startedAt: new Date().toISOString(), command, args};
  evidence.phases.push(record);
  const log = await fs.open(path.join(directory, name + '.log'), 'w');
  const child = spawn(command, args, {
    cwd: root,
    env: {...process.env, ...options.env},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let pending = '';
    stream.on('data', buffer => {
      output.write(buffer);
      // Use the open descriptor synchronously to retain output ordering.
      fsSyncWrite(log.fd, buffer);
      pending += buffer.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line.includes('Starting WebServer process') || line.includes('WebServer available at')) {
          evidence.fixtureEvents.push({secondsSinceTestCommand: (performance.now() - begin) / 1000, line: line.replace(/\x1b\[[0-9;]*m/g, '')});
        }
      }
    });
  }
  try {
    record.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        record.signal = signal;
        resolve(code);
      });
    });
  } finally {
    record.seconds = (performance.now() - begin) / 1000;
    await log.close();
    await fs.writeFile(path.join(directory, 'timings.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  if (record.exitCode !== 0) throw Error(`${name} exited ${record.exitCode} (${record.signal || 'no signal'})`);
}
// Avoid an asynchronous log write completing after the descriptor closes.
import {writeSync as fsSyncWrite} from 'node:fs';

try {
  await phase('runtime-install', 'npm', ['ci', '--prefix', 'panel', '--ignore-scripts', '--no-audit', '--no-fund']);
  await phase('browser-install', 'npm', ['ci', '--prefix', 'panel/test/browser', '--ignore-scripts', '--no-audit', '--no-fund']);
  if (!image) await phase('chromium-install', 'npm', ['exec', '--prefix', 'panel/test/browser', '--', 'playwright', 'install', '--with-deps', 'chromium']);
  const configPath = path.join(directory, 'benchmark.config.mjs');
  const reporterPath = path.join(directory, 'lifecycle-reporter.mjs');
  const lifecyclePath = path.join(directory, 'lifecycle.json');
  await fs.writeFile(reporterPath, `import fs from 'node:fs';
export default class {
  data = {};
  onBegin(config, suite) { this.data.begin = Date.now(); this.data.tests = suite.allTests().length; this.save(); }
  onTestBegin() { if (!this.data.firstTest) { this.data.firstTest = Date.now(); this.save(); } }
  onEnd(result) { this.data.end = Date.now(); this.data.status = result.status; this.save(); }
  save() { fs.writeFileSync(${JSON.stringify(lifecyclePath)}, JSON.stringify(this.data, null, 2)); }
}
`);
  await fs.writeFile(configPath, `import config from ${JSON.stringify(pathToFileURL(path.join(root, 'panel/test/browser/playwright.config.js')).href)};
export default {...config, testDir: ${JSON.stringify(path.join(root, 'panel/test/browser'))},
  webServer: config.webServer.map(server => ({...server, cwd: ${JSON.stringify(path.join(root, 'panel/test/browser'))}})),
  outputDir: ${JSON.stringify(path.join(root, 'output/playwright/results'))},
  reporter: [...config.reporter.map(entry => entry[0] === 'html' ? ['html', {outputFolder: ${JSON.stringify(path.join(root, 'output/playwright/report'))}, open: 'never'}] : entry),
    ['json', {outputFile: ${JSON.stringify(path.join(directory, 'report.json'))}}], [${JSON.stringify(reporterPath)}]]};
`);
  evidence.testCommandStartedAt = Date.now();
  await phase('acceptance', process.execPath, [
    'panel/test/browser/node_modules/@playwright/test/cli.js', 'test',
    '--config', configPath, ...(project === 'all' ? [] : ['--project', project]),
  ], {env: {DEBUG: 'pw:webserver'}});
} catch (error) {
  evidence.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  evidence.totalHarnessSeconds = (performance.now() - started) / 1000;
  evidence.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'timings.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
