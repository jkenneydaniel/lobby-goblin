// Shared application UI + real accounts/controller/jobs with three synthetic
// process drivers. No Docker socket, PHP process or existing installation.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {serviceApp} from './fixtures/service-app.js';
import {startController} from '../core/controller.js';
import {startWeb} from '../core/web.js';
import {hashPassword} from '../auth.js';
import {writeJSON} from '../common.js';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'lobby-service-app-browser-')),fixture=await serviceApp(root),token=path.join(root,'token'),auth=path.join(root,'auth');
await fs.mkdir(auth);await fs.writeFile(token,'synthetic-service-controller-token');
await writeJSON(path.join(auth,'users.json'),{Owner:{...hashPassword('application-preview-password'),role:'admin'},Read:{...hashPassword('application-preview-password'),role:'member',grants:{standalone:['server.view']}},Deployer:{...hashPassword('application-preview-password'),role:'member',grants:{standalone:['server.view','application.web-stack.deploy']}}});
const env={CONTROLLER_TOKEN_FILE:token,AUTH_DIR:auth,RELEASE_CHECKS:'false',PANEL_HOSTS:'127.0.0.1'};
const controller=await startController(fixture.module,{env,port:0,hostname:'127.0.0.1',docker:()=>{throw Error('Synthetic application cannot access Docker.');}});
const web=await startWeb(fixture.module,{env:{...env,CONTROLLER_URL:'http://127.0.0.1:'+controller.address().port},port:Number(process.env.APPLICATION_UI_PORT||31737),hostname:'127.0.0.1'});
let closing=false;
async function close(){if(closing)return;closing=true;for(const server of [web,controller]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await fs.rm(root,{recursive:true,force:true});}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close());
