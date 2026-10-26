import {requireAdmin} from '../auth.js';
import {AuditLog} from '../core/audit.js';
import {fleetAssets} from './web-assets.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {startWeb} from '../core/web.js';import {selectedApplication,registeredApplications} from '../applications/index.js';import {Accounts} from '../core/accounts.js';import {assert,json} from '../common.js';
import {requireAssignment,validScope,permissionCatalogFor} from '../core/permissions.js';
import {remoteGateway} from './agent-web.js';
export async function startFleetWeb({env=process.env,port=Number(env.PORT||8080),hostname='0.0.0.0'}={}){
 const auth=env.AUTH_DIR||'/web-state/auth',file=env.CONTROLLER_TOKEN_FILE||'/web-state/secrets/controller-token',token=(await fs.readFile(file,'utf8')).trim(),controller=env.CONTROLLER_URL||'http://fleet-controller:8091';
 const audit=new AuditLog(auth);
 const accounts=new Accounts(auth,{permissionCatalog:Object.assign({},...registeredApplications().map(permissionCatalogFor))}),sessions=new Map(),children=new Map();
 accounts.deletionRecords=async(user,snapshot)=>(await Promise.all(registeredApplications().map(module=>module.web.accountDeletionRecords?.(accounts,user,snapshot)||[]))).flat();
 accounts.onDelete=async(user,snapshot)=>{for(const module of registeredApplications())await module.web.deleteAccountData?.(accounts,user,snapshot);};
 async function read(route){const response=await fetch(controller+route,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});assert(response.ok,'The host is unavailable.',502);return response.json();}
 async function accessResources(){
  const {hosts}=await read('/hosts'),resources=[];
  for(const host of hosts){if(!host.connected)continue;try{const prefix=host.local?'':'/hosts/'+host.id;const {servers}=await read(prefix+'/servers');for(const item of servers)if(item.state!=='removed')resources.push({id:prefix+'/servers/'+item.id,name:host.name+' · '+item.name});}catch{}}
  return resources;
 }
 const gateway=remoteGateway({env,controller,token});
 const web={accessResources,Accounts,sessionCookie:'fleet_session',accountRoutes:[],adminReadRoutes:['/host-pairing','/host-setup','/removed-servers','/application-releases'],assets:fleetAssets,diagnosticsReport:(version,data)=>({version,...data}),validateOnboarding:value=>assert(value.ready,'The host manager is unavailable.'),allowRoute:route=>/^(?:\/hosts\/[a-f0-9]{32})?\/(?:snapshots\/[a-f0-9]{32}(?:\/remove)?|removed-servers)$/.test(route)||/^\/servers(?:\/[a-f0-9]{32}(?:\/(?:snapshot|remove))?)?$/.test(route)||['/catalog','/application-releases','/snapshots','/host-settings','/hosts','/host-pairing','/host-setup','/removed-servers','/application-releases','/host-setup-plan'].includes(route)||/^\/hosts\/[a-f0-9]{32}\/(?:application-releases|catalog|servers(?:\/[a-f0-9]{32}\/(?:snapshot|remove))?|snapshots|jobs(?:\/recovery)?|operations(?:\/recovery)?|host-settings|disconnect|agent-status|agent-update|agent-update-plan)$/.test(route),
  async dispatch(req,res,url,context){
   if(await gateway(req,res,url))return true;
   if(/^\/api\/hosts\/[a-f0-9]{32}\/operations(?:\/recovery)?$/.test(url.pathname)||/^\/api\/hosts\/[a-f0-9]{32}\/jobs$/.test(url.pathname)&&url.searchParams.has('workflows')){const user=await context.session(req);assert(user,'Please sign in.',401);requireAdmin(user);}
   if(/^\/api(?:\/hosts\/[a-f0-9]{32})?\/(?:snapshots\/[a-f0-9]{32}(?:\/remove)?$|(?:removed-servers|application-releases)$)/.test(url.pathname)){const user=await context.session(req);assert(user,'Please sign in.',401);requireAdmin(user);}
   if(url.pathname==='/api/assigned-servers'){
    const user=await context.session(req);assert(user,'Please sign in.',401);assert(req.method==='GET'&&user.role==='member','Assigned-server access is required.',403);
    const servers=[];
    for(const scope of Object.keys(user.grants||{}).slice(0,64)){
     if(scope==='standalone'||!validScope(scope)||!user.grants[scope].includes('server.view'))continue;
     try{const item=await read(scope);if(item.state!=='removed')servers.push({id:item.id,name:item.name,game:item.game,state:item.state,address:item.address,manageUrl:scope+'/'});}catch{}
    }
    json(res,200,{servers});return true;
   }
   const match=url.pathname.match(/^((?:\/hosts\/[a-f0-9]{32})?\/servers\/([a-f0-9]{32}))(\/.*)?$/);if(!match)return false;
   const user=await context.session(req);if(!user){if(match[3]?.startsWith('/api/'))json(res,401,{error:'Your session has ended. Please sign in again.'});else{res.writeHead(302,{location:'/'});res.end();}return true;}
   const prefix=match[1],id=match[2],tail=match[3];requireAssignment(user,prefix);if(!tail){res.writeHead(302,{location:prefix+'/'});res.end();return true;}
   // Always re-read registration; removed instances cannot retain a working web route.
   const response=await fetch(controller+prefix,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});assert(response.ok,response.status===404?'Server not found.':'This host is unavailable or access was revoked.',response.status===404?404:502);const info=await response.json();assert(info.state!=='removed','This server was removed. Its data volume was kept.',410);
   if(!children.has(prefix)){
    const scope=prefix.startsWith('/hosts/')?crypto.createHash('sha256').update(prefix).digest('hex').slice(0,32):id;
    const module=selectedApplication(info.game),extensions=module.web.accountExtensions?.(accounts,scope)||{},scopedAccounts=new Proxy(accounts,{get(target,key){if(Object.hasOwn(extensions,key))return extensions[key];const value=target[key];return typeof value==='function'?value.bind(target):value;}});
    const child=await startWeb({...module,web:{...module.web,sessionCookie:'fleet_session'}},{env:{...env,AUTH_DIR:auth,CONTROLLER_URL:controller+prefix+'/controller',CONTROLLER_TOKEN_FILE:file,RELEASE_CHECKS:'false'},accounts:scopedAccounts,sessions,audit,controllerToken:token,listen:false,assetPrefix:prefix});children.set(prefix,child);
   }
   req.url=tail+url.search;children.get(prefix).emit('request',req,res);return true;
  },
 };
 const module={id:'fleet',name:'Lobby Goblin host manager',contract:{version:1,kind:'gateway',features:{},actions:{},routes:{}},releaseRepository:'jkenneydaniel/lobby-goblin',routes:['/servers','/catalog','/snapshots'],web,configuration:()=>({}),createController:()=>{},createUpdater:()=>{},diagnostics:()=>{}};
 const server=await startWeb(module,{env:{...env,AUTH_DIR:auth,CONTROLLER_URL:controller,CONTROLLER_TOKEN_FILE:file,RELEASE_CHECKS:env.RELEASE_CHECKS||'true'},accounts,sessions,audit,controllerToken:token,port,hostname});
 server.once('close',()=>{for(const child of children.values())child.emit('close');});return server;
}
