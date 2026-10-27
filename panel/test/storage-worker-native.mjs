// Fresh CI containers and a unique disposable fixture volume only. No daemon,
// game process, existing installation, credentials, or world mounts are used.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runWorker} from '/app/fleet/worker.js';
import {makeZip} from '/app/core/archive.js';
import {verifySnapshot} from '/app/fleet/snapshots.js';
import {writeArchive} from '/app/applications/rust/archive.js';
import {selectedApplication} from '/app/applications/index.js';
const root='/fixture',instance=root+'/instance',library=root+'/library';
const fleet='a'.repeat(32),id='b'.repeat(32),snapshotId='c'.repeat(32);
const backup=instance+'/backups/panel-backups/private.zip';
const rustInstance=root+'/rust-instance',rustId='d'.repeat(32),rustSnapshotId='e'.repeat(32),rustBackup=rustInstance+'/backups/archives/private.tar.gz';
const rustConfig={action:'snapshot',fleet,id:rustId,game:'rust',snapshotId:rustSnapshotId,backup:'private.tar.gz',title:'Legacy overflow Rust',image:selectedApplication('rust').managed.catalog.image,seed:3532793187,worldSize:2000};
const rustSave='proceduralmap.2000.2147483647.289.sav';
const config={action:'snapshot',fleet,id,game:'factorio',snapshotId,backup:'private.zip',title:'Disposable private backup',image:'ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.3'};
if(process.argv[2]==='prepare'){
  await fs.mkdir(instance);await fs.mkdir(library);
  await runWorker({action:'provision',fleet,id,game:'factorio',name:'Fixture',maxPlayers:4,controllerToken:'fixture-token',rconPassword:'fixture-only-secret'},{instance,library});
  await fs.mkdir(path.dirname(backup),{recursive:true,mode:0o700});
  await fs.writeFile(backup,makeZip([
    {name:'panel-manifest.json',data:Buffer.from(JSON.stringify({activeSave:'world.zip'}))},
    {name:'saves/world.zip',data:makeZip([{name:'world/level.dat',data:Buffer.from('synthetic world')}])},
    {name:'config/rconpw',data:Buffer.from('never-copy-this-secret')},
  ]),{mode:0o600});
  await fs.writeFile(root+'/backup.sha256',crypto.createHash('sha256').update(await fs.readFile(backup)).digest('hex'));
  await fs.chown(backup,845,845);await fs.chown(path.dirname(backup),845,845);
  await fs.mkdir(rustInstance);
  await runWorker({action:'provision',fleet,id:rustId,game:'rust',name:'Rust fixture',maxPlayers:4,controllerToken:'rust-fixture-token',rconPassword:'rust-fixture-secret'},{instance:rustInstance,library});
  const identity=rustInstance+'/data/server/lobby-goblin-rust';
  await fs.writeFile(identity+'/'+rustSave,'synthetic overflow Rust world');
  await fs.appendFile(identity+'/cfg/server.cfg','rcon.password never-copy-rust-secret\n');
  await fs.mkdir(path.dirname(rustBackup),{recursive:true,mode:0o700});
  await writeArchive(rustBackup,identity,{identity:'lobby-goblin-rust',instance:rustId,label:'before-removal'});
  await fs.writeFile(root+'/rust-backup.sha256',crypto.createHash('sha256').update(await fs.readFile(rustBackup)).digest('hex'));
  await fs.chown(rustBackup,845,845);await fs.chown(path.dirname(rustBackup),845,845);

}else if(process.argv[2]==='before'){
  await assert.rejects(runWorker(config,{instance,library}),{code:'EACCES'});
  assert.deepEqual(await fs.readdir(library),[]);
  console.log('Reproduced pre-fix private backup access failure with all capabilities dropped.');
}else{
  const result=await runWorker(config,{instance,library});
  const manifest=await verifySnapshot(library,snapshotId,result.manifestSha256);
  assert.deepEqual(manifest.files.map(file=>file.name),['world.zip']);
  assert.equal((await fs.stat(backup)).uid,845);assert.equal((await fs.stat(backup)).mode&0o777,0o600);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(backup)).digest('hex'),await fs.readFile(root+'/backup.sha256','utf8'));
  console.log('Snapshot publication passed with DAC_OVERRIDE; backup ownership, privacy, and source bytes were preserved.');
  const rustResult=await runWorker(rustConfig,{instance:rustInstance,library});
  const rustManifest=await verifySnapshot(library,rustSnapshotId,rustResult.manifestSha256);
  assert.equal(rustManifest.seed,2147483647);assert.equal(rustManifest.worldSize,2000);
  assert.ok(rustManifest.files.every(file=>!file.name.includes('/cfg/')));
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(rustBackup)).digest('hex'),await fs.readFile(root+'/rust-backup.sha256','utf8'));
  assert.equal((await fs.stat(rustBackup)).uid,845);assert.equal((await fs.stat(rustBackup)).mode&0o777,0o600);
  console.log('Legacy Rust seed 3532793187 snapshot verified against backed-up seed 2147483647 / size 2000; source archive SHA-256 and permissions preserved.');

}
