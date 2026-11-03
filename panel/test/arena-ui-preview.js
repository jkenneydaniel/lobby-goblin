import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {arena} from './fixtures/arena-game.js';
import {hashPassword} from '../auth.js';
import {writeJSON} from '../common.js';
import {startController} from '../core/controller.js';
import {startWeb} from '../core/web.js';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-arena-browser-')),auth=path.join(root,'auth'),token=path.join(root,'token');
await fs.mkdir(auth);await fs.writeFile(token,'synthetic-arena-controller-token');
const module=arena(root);
await writeJSON(path.join(auth,'users.json'),{
  Assigned:{...hashPassword('arena-preview-password'),role:'member',grants:{standalone:['server.view','game.arena.rotate']}},
  Read:{...hashPassword('arena-preview-password'),role:'member',grants:{standalone:['server.view']}},
});
const env={CONTROLLER_TOKEN_FILE:token,AUTH_DIR:auth,RELEASE_CHECKS:'false',PANEL_HOSTS:'127.0.0.1'};
const controller=await startController(module,{env,hostname:'127.0.0.1',port:0,docker:()=>{throw Error('Arena browser fixture cannot contact Docker');}});
const web=await startWeb(module,{env:{...env,CONTROLLER_URL:'http://127.0.0.1:'+controller.address().port},hostname:'127.0.0.1',port:Number(process.env.ARENA_UI_PORT||31736)});
async function close(){for(const server of [web,controller]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await fs.rm(root,{recursive:true,force:true});}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close().then(()=>process.exit(0));});
