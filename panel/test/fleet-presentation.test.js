import test from 'node:test';
import assert from 'node:assert/strict';
import {registeredApplications, selectedApplication} from '../applications/index.js';
import {fleetPresentation} from '../applications/fleet-presentation.js';
import {definitionFingerprint} from '../core/application-services.js';
import {gameCatalog} from '../core/managed-game.js';
import {applicationURL, applicationLink} from '../public/fleet/application-link.js';
import {serverCards} from '../public/fleet/cards.js';

const service = {id:'a',game:'status-page',applicationName:'Status Page',applicationKind:'application',webProtocol:'http',address:'service.example.test:35000',name:'Service',state:'installed',manageUrl:'/servers/a/',hostId:'local',hostName:'Local',cpu:1,memoryGiB:2};
test('reviewed presentation retains existing runtime fingerprints and never infers HTTP from TCP or application kind',()=>{
 const hashes={factorio:'a3dba839bc4a05710fedb82a4c57d1d18552184f3b9fc03d2f0066f85f557b2b',rust:'cbdc243b1f281bb0f370485b1098f1b05563f61da861202c0f6f5dba5e3ce8c8','status-page':'b6ccb081b976408e673d5d7378a9ac9fbe02a26135de22b55104e0ddb657a1f2'};
 for(const module of registeredApplications()) {
  assert.equal(definitionFingerprint(module.definition),hashes[module.id]);
  assert.equal(gameCatalog(module).webProtocol,module.id==='status-page'?'http':undefined);
 }
 const module=selectedApplication('status-page');
 assert.deepEqual(fleetPresentation({...module,id:'unknown-application'}),{});
 assert.throws(()=>fleetPresentation({...module,definition:{...module.definition,kind:'game'}}),/presentation/);
 assert.throws(()=>fleetPresentation({...module,managed:{...module.managed,ports:[{key:'gamePort',protocol:'udp'}]}}),/presentation/);
});
test('public links accept only explicit HTTP(S) host and allocated port destinations',()=>{
 assert.equal(applicationURL(service),'http://service.example.test:35000/');
 assert.equal(applicationURL({...service,webProtocol:'https',address:'[::1]:443'}),'https://[::1]/');
 for(const address of ['javascript:alert(1)','user:pass@host:80','host:80/path','host:80?x=1','host:80#x','//host:80','host:0','host:65536','host:80\\evil','host:80\n','host:80" onclick="x','[not-ip]:80','host:80@other:80','host..example:80','-host.example:80','host-.example:80'])assert.equal(applicationURL({...service,address}),'',address);
 for(const patch of [{webProtocol:'javascript'},{webProtocol:undefined},{applicationKind:'game'},{applicationKind:undefined}])assert.equal(applicationURL({...service,...patch}),'');
 assert.match(applicationLink(service,false,'panel.example.test'),/rel="noopener noreferrer"/);
 assert.match(applicationLink(service,false,'panel.example.test'),/separate from panel sign-in.*not encrypted/);
 assert.equal(applicationLink(service,true,'panel.example.test'),'');assert.equal(applicationLink(service,false,''),'');assert.ok(!applicationLink(service,false,'service.example.test').includes('Open application'));assert.match(applicationLink(service,false,'SERVICE.EXAMPLE.TEST.'),/cookies separate/);assert.ok(!applicationLink({...service,address:'127.1:35000'},false,'127.0.0.1').includes('Open application'));assert.equal(applicationLink({...service,state:'removed'}),'');
});
test('mixed fleet cards preserve game players and scoped management while applications expose distinct public context',()=>{
 const model={servers:[service,{...service,id:'b',game:'factorio',applicationName:'Factorio',applicationKind:'game',webProtocol:undefined}],hosts:[{id:'local',connected:true}],live:new Map(),hostJobs:new Map()};
 const html=serverCards(model,true);assert.equal((html.match(/Open application/g)||[]).length,0);assert.equal((html.match(/players/g)||[]).length,1);assert.match(html,/Manage application/);assert.match(html,/Open server/);assert.match(html,/STATUS PAGE/);
 assert.ok(!serverCards({...model,hosts:[]},true).includes('Open application'));
 const assigned=serverCards({...model,servers:[service],assigned:true},false);assert.ok(!assigned.includes('Open application'));assert.match(assigned,/Manage application/);assert.ok(!assigned.includes('Publish snapshot'));
});
