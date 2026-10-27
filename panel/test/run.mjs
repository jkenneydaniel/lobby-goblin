import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {imageCatalogue} from '../core/application-image-build.js';

const panel=fileURLToPath(new URL('../',import.meta.url));
const tests=(await fs.readdir(path.join(panel,'test'))).filter(name=>name.endsWith('.test.js')).sort().map(name=>path.join(panel,'test',name));
for(const recipe of await imageCatalogue(path.dirname(panel.replace(/[\\/]$/,''))))
  for(const check of recipe.checks)
    if(check.runner==='node-test'){const file=await recipe.locate(check.file);if(!tests.includes(file))tests.push(file);}
const result=spawnSync(process.execPath,['--test',...process.argv.slice(2),...tests],{cwd:panel,stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
