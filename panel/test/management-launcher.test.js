import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const windows = process.platform === 'win32', fleet = 'a'.repeat(32), image = 'sha256:' + 'b'.repeat(64);
for (const pending of [false, true]) test('native Fleet launcher honors portable update selection; pending=' + pending, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-launcher-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  for (const name of ['Fleet.sh', 'Fleet.ps1']) await fs.copyFile(new URL('../../scripts/fleet/' + name, import.meta.url), path.join(directory, name));
  const config = 'FLEET_ID=' + fleet + '\nFLEET_IMAGE=local/lobby-goblin-host:fixture\n';
  await fs.writeFile(path.join(directory, '.env.fleet'), config); await fs.writeFile(path.join(directory, 'fleet.compose.yaml'), 'legacy fixture');
  const bin = path.join(directory, 'bin'); await fs.mkdir(bin);
  const log = path.join(directory, 'calls.jsonl'), mock = path.join(bin, 'mock.mjs');
  await fs.writeFile(mock, `#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2), fleet='${fleet}', image='${image}', volume='lobby-goblin-fleet-'+fleet+'-management-updates';
const record={args};if(args[0]==='compose'&&args.includes('up')){const positions=args.flatMap((v,i)=>v==='-f'?[i+1]:[]);record.overlay=JSON.parse(fs.readFileSync(args[positions.at(-1)],'utf8'));}
fs.appendFileSync(process.env.LAUNCHER_LOG,JSON.stringify(record)+'\\n');
const format=args[args.indexOf('--format')+1];
if(args[0]==='info')console.log(format==='{{.ID}}'?'fixture-engine':format==='{{json .}}'?JSON.stringify({OSType:'linux',Architecture:'amd64',ServerVersion:'29.0'}):'linux/amd64/29.0');
else if(args[0]==='volume'&&args[1]==='ls')console.log(volume);
else if(args[0]==='volume')console.log(args.includes('--format')?'local|null|'+fleet+'|management-update-ledger|fixture-engine':JSON.stringify([{Name:volume,Driver:'local',Options:null,Labels:{'io.lobby-goblin.fleet':fleet,'io.lobby-goblin.role':'management-update-ledger','io.lobby-goblin.engine':'fixture-engine'}}]));
else if(args[0]==='inspect')console.log(args.includes('--format')?(format==='{{.Image}}'?image:'created|none|true|0|'+fleet+'|management-update-anchor|fixture-engine'):JSON.stringify([{Image:image,State:{Status:'created'},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true},Mounts:[],Config:{Labels:{'io.lobby-goblin.fleet':fleet,'io.lobby-goblin.role':'management-update-anchor','io.lobby-goblin.engine':'fixture-engine'}}}]));
else if(args[0]==='run'){if(process.env.LAUNCHER_PENDING==='true')process.exit(42);console.log(JSON.stringify({services:{'fleet-controller':{image,environment:{FLEET_IMAGE:image,FLEET_SKIP_MIGRATIONS:'true'}},'fleet-web':{image}}}));}
`);
  await fs.chmod(mock, 0o755);
  let command, args;
  if (windows) {
    const quote = text => "'" + text.replaceAll("'", "''") + "'";
    await fs.writeFile(path.join(bin, 'docker.ps1'), '& ' + quote(process.execPath) + ' ' + quote(mock) + ' @args\n');
    command = 'powershell.exe'; args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'Fleet.ps1')];
  } else {await fs.symlink(mock, path.join(bin, 'docker')); command = 'sh'; args = [path.join(directory, 'Fleet.sh')];}
  const env = {...process.env, PATH: bin + path.delimiter + process.env.PATH, LAUNCHER_LOG: log, LAUNCHER_PENDING: String(pending)};
  delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT;
  const result = spawnSync(command, args, {env, encoding: 'utf8'}), calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(value => JSON.parse(value));
  assert.equal(await fs.readFile(path.join(directory, '.env.fleet'), 'utf8'), config, 'Enrolled startup never rewrites original configuration.');
  const reader = calls.find(v => v.args[0] === 'run').args;
  assert.ok(reader.includes('type=volume,source=lobby-goblin-fleet-' + fleet + '-management-updates,target=/management,readonly,volume-nocopy'));
  assert.equal(reader.some(v => v.includes('docker.sock')), false);
  assert.equal(reader.some(v => v.includes(directory)), false);
  if (pending) {assert.notEqual(result.status, 0); assert.equal(calls.some(v => v.args.includes('pull') || v.args.includes('up')), false);}
  else {assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(calls.find(v => v.args.includes('up')).overlay.services['fleet-controller'].image, image);}
});
