// Loopback-only browser fixture; the Docker seam is simulated and cannot reach
// an engine. Native process/provisioning acceptance runs separately on Linux.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {containerFixture} from './container-application-fixture.js';
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'status-ui-')));
const fixture=await containerFixture(root,{webPort:Number(process.env.STATUS_UI_PORT || 41738)});
let closing=false;
async function close(){if(closing)return;closing=true;await fixture.close();await fs.rm(root,{recursive:true,force:true});}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>void close());
