// Loopback-only browser fixture. All game state and mod changes are synthetic
// and in memory. There is no Docker socket, controller, account or world access.
import http from 'node:http';
import {sharedAssets} from '../core/web-assets.js';
import fs from 'node:fs/promises';
import {factorio} from '../applications/factorio/index.js';
import {rust} from '../applications/rust/index.js';
import {publicContract} from '../core/game-contract.js';
const states=new Map();
for(const [id,module] of [['a'.repeat(32),factorio],['b'.repeat(32),rust]])states.set(id,{module,game:module.id,connected:false,installed:[],plans:new Map(),jobs:[],running:true});
const examples={factorio:[['BottleneckLite','Bottleneck Lite','See which machines are waiting for ingredients or running at full capacity.','raiguard','1.2.8'],['SqueakThrough','Squeak Through','Walk between closely placed machines and explore your factory more comfortably.','Supercheese','1.8.2'],['FactoryPlanner','Factory Planner','Plan production chains and understand what your next factory needs.','Therenas','2.0.11']],rust:[['GatherManager','Gather Manager','Adjust gathering rates for resources, quarries and pickups.','Mughisi','2.2.78'],['Vanish','Vanish','Become invisible while administering your server.','Whispers88','2.1.5'],['BetterLoot','Better Loot','Customize the native loot system for your community.','MagicServices','4.5.4']]};
if(process.env.MOD_LIBRARY_UI_UPDATES==='1')for(const state of states.values()){const [id,title,summary,author]=examples[state.game][0];state.installed.push({id:state.game==='rust'?id.toLowerCase():id,name:id+(state.game==='rust'?'.cs':''),title,summary,author,version:'1.0.0',enabled:true,managed:true,source:'fixture'});}
const reply=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://preview'),match=url.pathname.match(/^\/servers\/([ab]{32})(\/.*)?$/),state=states.get(match?.[1]);if(!state)return reply(res,404,{error:'Choose an isolated preview URL.'});
    const route=match[2]||'/',prefix='/servers/'+match[1],game=state.game,items=examples[game].map(([id,title,summary,author,version])=>({id:game==='rust'?id.toLowerCase():id,name:id+(game==='rust'?'.cs':''),title,summary,author,version,url:game==='rust'?'https://umod.org/plugins/'+id.toLowerCase():'https://mods.factorio.com/mod/'+id,available:true}));
    if(route.startsWith('/api/')){
      let body={};if(req.method==='POST'){let text='';for await(const part of req)text+=part;body=JSON.parse(text);}
      const api=route.slice(5),stamp=new Date().toISOString(),job={id:'fixture-'+Date.now(),state:'succeeded',action:body.action,message:'Synthetic mod operation completed. No real server was contacted.',started:stamp,finished:stamp,actor:'Preview'};
      if(api==='session')return reply(res,200,{username:'Preview',role:'admin',csrf:'preview',onboarding:{completed:true}});
      if(api==='status')return reply(res,200,{game,name:game==='rust'?'North Coast':'Copper Coast',running:state.running,ready:state.running,state:state.running?'running':'exited',players:game==='rust'?3:[],maxPlayers:50,fps:60,uptime:1200,cpu:2,memory:536870912,connection:'preview.example:34197',version:'2.0.77',image:'fixture:2.0.77',currentWorld:'Preview.zip',playtime:'12 hours',schedule:{enabled:false,hours:6,keep:12},activeJob:null});
      if(api==='jobs'){if(req.method==='POST'){if(body.action==='mod-library-install'){const plan=state.plans.get(body.params.planId);if(!plan)return reply(res,409,{error:'Review this fixture change again.'});const item=items.find(item=>item.id===plan.mod);if(plan.operation==='install'){state.installed=state.installed.filter(value=>value.id!==item.id);state.installed.push({...item,enabled:true,managed:true,source:'fixture'});}else if(plan.operation==='remove')state.installed=state.installed.filter(value=>value.id!==plan.mod);else state.installed.find(item=>item.id===plan.mod).enabled=plan.operation==='enable';state.running=plan.mode!=='stopped';}state.jobs.unshift(job);return reply(res,202,job);}return reply(res,200,{jobs:state.jobs,active:null});}
      if(api==='mod-library'){const tab=url.searchParams.get('tab'),query=(url.searchParams.get('query')||'').toLowerCase();return reply(res,200,{game,scope:game==='rust'?'oxide':'factorio',source:game==='rust'?'uMod':'Factorio Mod Portal',version:game==='rust'?'2.0.7830':'2.0.77',tab,running:state.running,hotAvailable:game==='rust',editable:!state.running,account:{connected:state.connected},items:tab==='installed'?state.installed:tab==='updates'?state.installed.filter(item=>item.version==='1.0.0').map(item=>({...items.find(value=>value.id===item.id),installedVersion:'1.0.0'})):items.filter(item=>(item.title+' '+item.summary).toLowerCase().includes(query)),page:1,pages:1,checkedAt:stamp});}
      if(api==='mod-library-plan'){if(game==='factorio'&&!state.connected)return reply(res,409,{error:'Connect a Factorio account before downloading mods.'});const item=items.find(item=>item.id===body.id),plan={id:crypto.randomUUID(),mod:body.id,mode:body.mode,operation:body.operation,releases:[{...item,sha256:'a'.repeat(64),dependencies:game==='factorio'?['base >= 2.0.0']:[]}],files:[{name:item.name,remove:body.operation==='remove'}],message:body.mode==='hot'?'Rust stays online. Reload the reviewed plugin without stopping.':body.mode==='restart'?'Players disconnect while the server saves, stops, installs, and starts.':'The server will remain stopped after this change.'};state.plans.set(plan.id,plan);return reply(res,200,plan);}
      if(api==='mod-library-account'){state.connected=!body.disconnect;return reply(res,200,{connected:state.connected});}
      if(api==='mods')return reply(res,200,{available:true,framework:'oxide',version:'2.0.7830',plugins:[],configs:[],message:'Synthetic framework fixture. No game engine is connected.',imageCapable:true});
      if(api==='updates')return reply(res,200,{current:'0.3.5-alpha',available:false,state:'current'});
      if(api==='update-status')return reply(res,200,{busy:false,jobs:[]});
      if(api==='backups')return reply(res,200,{backups:[],schedule:{},health:{state:'none'},retention:{policy:{enabled:false}}});
      return reply(res,404,{error:'This isolated fixture only supports the mod library.'});
    }
    if(route==='/application-definition.json')return reply(res,200,publicContract(state.module));
    const asset={...sharedAssets,...state.module.web.assets}[route];if(!asset)return reply(res,404,{error:'Unknown fixture asset.'});
    let data=await fs.readFile(new URL(asset[0],Object.hasOwn(state.module.web.assets,route)?state.module.web.publicRoot:new URL('../public/',import.meta.url)));if(asset[1].startsWith('text/html'))data=Buffer.from(data.toString().replace(/(src|href)="\/(?!\/)/g,'$1="'+prefix+'/'));
    res.writeHead(200,{'content-type':asset[1],'cache-control':'no-store'});res.end(data);
  }catch(error){reply(res,500,{error:error.message});}
});
server.listen(Number(process.env.MOD_LIBRARY_UI_PORT||8096),'127.0.0.1',()=>{for(const [id,state]of states)console.log(state.game+': http://127.0.0.1:'+server.address().port+'/servers/'+id+'/#mods');});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit()));
