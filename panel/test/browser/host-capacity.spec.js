import {test as base,expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';
import {catalog} from '../../fleet/catalog.js';
const test=base.extend({page:async({page},use)=>{
 const routes=trackPageRoutes(page),errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.context().route('**/*',route=>{const url=new URL(route.request().url());if(Object.values(origins).includes(url.origin))return route.continue();external.push(url.origin);return route.abort();});
 try{await use(page);}finally{await routes.dispose();}
 expect(errors).toEqual([]);expect(external).toEqual([]);
}});
const local='a'.repeat(32),remote='d'.repeat(32);
const nav=page=>page.getByRole('navigation',{name:/navigation/});
const cards=page=>page.locator('#hosts-list article');
async function fixture(page,username='Preview'){
 const state={hosts:[{id:local,name:'This host',local:true,connected:true},{id:remote,name:'Weekend host',local:false,connected:true,aligned:true}],capacityReads:[],catalogReads:[],mutations:[],failRemote:false,local:{memoryBudgetGiB:24,allocatedMemoryGiB:17,availableMemoryGiB:7,dockerMemoryGiB:32},remote:{memoryBudgetGiB:64,allocatedMemoryGiB:30,availableMemoryGiB:34,dockerMemoryGiB:96}};
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(route.request().method()!=='GET'){if(!path.endsWith('/login'))state.mutations.push(path);return route.fallback();}
  if(path==='/api/hosts')return route.fulfill({json:{hosts:state.hosts}});
  if(path==='/api/host-settings'||path==='/api/hosts/'+remote+'/host-settings'){
   const target=path==='/api/host-settings'?'local':'remote';state.capacityReads.push(path);
   return route.fulfill({status:target==='remote'&&state.failRemote?503:200,json:target==='remote'&&state.failRemote?{error:'Synthetic unavailable'}:state[target]});
  }
  if(/\/(servers|snapshots)$/.test(path))return route.fulfill({json:{servers:[],snapshots:[]}});
  if(/\/jobs$/.test(path))return route.fulfill({json:{jobs:[],active:null}});
  if(/\/catalog$/.test(path)){state.catalogReads.push(path);return route.fulfill({json:{games:Object.values(catalog)}});}
  return route.fallback();
 });
 await page.goto(origins.fleet);await page.getByLabel('Username',{exact:true}).fill(username);await page.getByLabel('Password',{exact:true}).fill('isolated-panel-preview-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('.product-shell')).toBeVisible();return state;
}
for(const username of ['Preview','Viewer'])test('compare authoritative host allocations without mutations for '+username,async({page},info)=>{
 await page.clock.install();const state=await fixture(page,username);expect(state.capacityReads).toEqual([]);
 await nav(page).getByRole('link',{name:'Hosts',exact:true}).click();await expect(cards(page)).toHaveCount(2);
 await expect(cards(page).first().locator('.capacity-summary dd')).toHaveText(['24 GiB','17 GiB','7 GiB','32.0 GiB']);
 await expect(cards(page).nth(1).locator('.capacity-summary dd')).toHaveText(['64 GiB','30 GiB','34 GiB','96.0 GiB']);
 await expect(cards(page).first()).toContainText('Configured allocations, not live RAM usage. Checked');
 const reads=state.capacityReads.length;await page.clock.fastForward(6000);expect(state.capacityReads.length).toBe(reads);
 state.remote={...state.remote,allocatedMemoryGiB:50,availableMemoryGiB:14};await page.getByRole('button',{name:'Refresh capacity',exact:true}).click();await expect(cards(page).nth(1).locator('.capacity-summary dd')).toHaveText(['64 GiB','50 GiB','14 GiB','96.0 GiB']);
 if(username==='Preview'){
  await cards(page).nth(1).getByRole('button',{name:'Create server here',exact:true}).click();await expect(page.getByRole('dialog').getByRole('combobox',{name:'Host',exact:true})).toHaveValue(remote);expect(state.catalogReads.at(-1)).toBe('/api/hosts/'+remote+'/catalog');await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
 }else await expect(page.getByRole('button',{name:'Create server here',exact:true})).toHaveCount(0);
 expect(state.mutations).toEqual([]);expect(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('host-capacity-'+username+'.png'),fullPage:true});
});
test('capacity handles partial failures, Docker unknown and offline hosts without fabricated headroom',async({page})=>{
 await page.clock.install();const state=await fixture(page);state.failRemote=true;state.local.dockerMemoryGiB=null;await nav(page).getByRole('link',{name:'Hosts',exact:true}).click();
 await expect(cards(page).first()).toContainText('Not reported');await expect(cards(page).nth(1)).toContainText('Capacity unavailable. Refresh capacity');
 state.failRemote=false;await page.getByRole('button',{name:'Refresh capacity',exact:true}).click();await expect(cards(page).nth(1)).toContainText('34 GiB');
 state.hosts[1].connected=false;await page.clock.fastForward(6000);await expect(cards(page).nth(1)).toContainText('Capacity unavailable while this host is offline');await expect(cards(page).nth(1).locator('.capacity-summary')).toHaveCount(0);await expect(cards(page).nth(1).getByRole('button',{name:'Create server here'})).toBeDisabled();expect(state.mutations).toEqual([]);
});
test('assigned accounts do not load host capacity even when navigating to the hosts hash',async({page})=>{
 const state=await fixture(page,'Assigned');await page.goto(origins.fleet+'/#hosts');await expect(page.getByRole('heading',{name:'Your hosts',exact:true})).not.toBeVisible();expect(state.capacityReads).toEqual([]);await expect(nav(page).getByRole('link',{name:'Hosts',exact:true})).toHaveCount(0);
});
