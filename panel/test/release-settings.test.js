import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReleaseSettings} from '../core/release-settings.js';
import {planStorageMigration,applyStorageMigration} from '../core/storage/migrations.js';
import {closeStorage} from '../core/storage/selection.js';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-release-settings-'));
  t.after(async()=>{await closeStorage(root);await fs.rm(root,{recursive:true,force:true});});return root;
}
for(const sqlite of [false,true])test(`release preferences persist with revisions and environment defaults (${sqlite?'SQLite':'legacy files'})`,async t=>{
  const root=await fixture(t),settings=new ReleaseSettings(root,{enabled:false,channel:'preview'});
  assert.deepEqual(await settings.read(),{version:1,enabled:false,channel:'preview',revision:0});
  await settings.save({enabled:true,channel:'stable',revision:0});
  if(sqlite)await applyStorageMigration(await planStorageMigration(root,'accounts'),{confirm:true,offline:true});
  const restarted=new ReleaseSettings(root,{enabled:false,channel:'preview'});
  assert.equal((await restarted.read()).enabled,true);assert.equal((await restarted.read()).channel,'stable');
  await assert.rejects(restarted.save({enabled:false,channel:'preview',revision:0}),/another session/);
  const results=await Promise.allSettled([settings.save({enabled:false,channel:'stable',revision:1}),restarted.save({enabled:true,channel:'preview',revision:1})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await settings.read()).revision,2);
  await assert.rejects(settings.save({enabled:'false',channel:'stable',revision:2}),/valid release channel/);
  await assert.rejects(settings.save({enabled:true,channel:'https://evil.example',revision:2}),/valid release channel/);
});
