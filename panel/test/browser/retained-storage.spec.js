import {test as base,expect} from '@playwright/test';
import {origins} from './playwright.config.js';
const test=base.extend({page:async({page},use)=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.context().route('**/*',route=>new URL(route.request().url()).origin===origins.fleet?route.continue():route.abort());
 await page.route('**/api/hosts',route=>route.fulfill({json:{hosts:[{id:'a'.repeat(32),name:'This host',local:true,connected:true}]}}));
 await use(page);expect(errors).toEqual([]);
}});
const id='9'.repeat(32),removed=()=>({id,name:'Retired island',game:'rust',volume:'synthetic-retained-volume',removedAt:'2026-10-27T12:00:00Z'});
const review=()=>({token:'synthetic-review',inspectedAt:new Date().toISOString(),fingerprint:'synthetic',summary:{files:1234,bytes:4*1024**3,sections:{data:{files:1200,bytes:3*1024**3},backups:{files:34,bytes:1024**3}}},recovery:{ready:true}});
async function open(page,user='Preview') {
 await page.goto(origins.fleet);await page.getByLabel('Username',{exact:true}).fill(user);await page.getByLabel('Password',{exact:true}).fill('isolated-panel-preview-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 if(user==='Preview')await page.getByRole('navigation',{name:/navigation/}).getByRole('link',{name:'Storage',exact:true}).click();
}
test('inspect, recover a stopped copy, and explicitly delete retained storage with refreshed review',async({page},info)=>{
 const item=removed(),requests=[];let refuse=true;
 await page.route('**/api/removed-servers**',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(request.method()==='GET')return route.fulfill({json:{servers:[item]}});
  const body=request.postDataJSON();requests.push({path:url.pathname,body});
  if(url.pathname.endsWith('/inspect'))item.storageReview=review();
  else if(url.pathname.endsWith('/recover')){expect(body).toMatchObject({name:item.name,newName:'Recovered island',confirm:true,reviewToken:'synthetic-review'});}
  else if(refuse)return route.fulfill({status:409,json:{error:'A container still uses this volume. Storage was preserved.'}});
  else {expect(body).toMatchObject({name:item.name,confirm:true,reviewToken:'synthetic-review'});item.storageDeletedAt=new Date().toISOString();delete item.storageReview;}
  return route.fulfill({status:202,json:{id:'synthetic-job',state:'running'}});
 });
 await open(page);await expect(page.getByRole('heading',{name:'Retired island',exact:true})).toBeVisible();await expect(page.getByText('Data retained.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Inspect storage',exact:true}).click();await expect(page.getByText(/4(?:\.0)? GiB.*1,?234 files/)).toBeVisible();
 await page.getByText('Recover into a new server',{exact:true}).click();const recovery=page.locator('[data-recover-storage]');await recovery.getByLabel('New server name').fill('Recovered island');await recovery.getByRole('textbox',{name:/confirm the source/}).fill(item.name);await recovery.getByRole('checkbox').check();
 await recovery.getByRole('button',{name:'Recover stopped server'}).click();await expect(page.locator('.product-feedback').filter({hasText:'Recovering an independent stopped server. Original storage is kept.'})).toBeVisible();
 expect(requests.filter(r=>r.path.endsWith('/recover'))).toHaveLength(1);
 await page.getByText('Permanently delete retained data',{exact:true}).click();let deletion=page.locator('[data-delete-storage]');await deletion.getByRole('textbox').fill(item.name);await deletion.getByRole('checkbox').check();await deletion.getByRole('button',{name:'Delete retained data'}).click();await expect(page.getByRole('alert')).toContainText('still uses');expect(item.storageDeletedAt).toBeUndefined();
 await page.getByText('Permanently delete retained data',{exact:true}).click();deletion=page.locator('[data-delete-storage]');await expect(deletion.getByRole('textbox')).toHaveValue(item.name);await expect(deletion.getByRole('checkbox')).toBeChecked();
 await page.evaluate(()=>globalThis.scrollTo(0,0));await page.screenshot({path:info.outputPath('retained-storage.png')});expect(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth)).toBe(true);
 refuse=false;await deletion.getByRole('button',{name:'Delete retained data'}).click();await expect(page.getByText('Data permanently deleted.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Inspect storage',exact:true})).toHaveCount(0);
});
test('expired inspections disable recovery and deletion; unsupported recovery explains the reason',async({page})=>{
 const item={...removed(),storageReview:{...review(),inspectedAt:'2020-01-01T00:00:00Z',recovery:{ready:false,reason:'An interrupted application change needs manual recovery review before copying.'}}};
 await page.route('**/api/removed-servers',route=>route.fulfill({json:{servers:[item]}}));await open(page);
 await expect(page.getByText('Inspection expired. Inspect again to continue.')).toBeVisible();await expect(page.getByText(/Recovery needs review:.*interrupted application change/)).toBeVisible();await expect(page.getByText('Recover into a new server',{exact:true})).toHaveCount(0);await page.getByText('Permanently delete retained data',{exact:true}).click();await expect(page.getByRole('button',{name:'Delete retained data'})).toBeDisabled();
});
test('viewers never see storage navigation or fetch retained volume details',async({page})=>{
 const reads=[];page.on('request',request=>{if(request.url().includes('/removed-servers'))reads.push(request.url());});await open(page,'Viewer');await expect(page.getByRole('navigation',{name:/navigation/}).getByRole('link',{name:'Storage',exact:true})).toHaveCount(0);
 await page.goto(origins.fleet+'/#storage');await expect(page.getByRole('heading',{name:/servers/i}).first()).toBeVisible();expect(reads).toEqual([]);
});

test('storage recovery remains scoped to the selected remote host when server IDs overlap',async({page})=>{
 const remote='d'.repeat(32),local=removed(),other={...removed(),name:'Remote island'},requests=[];
 for(const [resource,data] of [['servers',{servers:[]}],['snapshots',{snapshots:[]}],['jobs**',{jobs:[],active:null}]])await page.route('**/api/hosts/'+remote+'/'+resource,route=>route.fulfill({json:data}));
 await page.route('**/api/hosts',route=>route.fulfill({json:{hosts:[{id:'a'.repeat(32),name:'This host',local:true,connected:true},{id:remote,name:'Remote host',local:false,connected:true}]}}));
 await page.route('**/api/removed-servers',route=>route.fulfill({json:{servers:[local]}}));
 await page.route('**/api/hosts/'+remote+'/removed-servers**',route=>{
  const request=route.request();if(request.method()==='GET')return route.fulfill({json:{servers:[other]}});
  const path=new URL(request.url()).pathname;requests.push({path,body:request.postDataJSON()});if(path.endsWith('/inspect'))other.storageReview=review();
  return route.fulfill({status:202,json:{id:'remote-job',state:'running'}});
 });
 await open(page);const card=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Remote island',exact:true})});await card.getByRole('button',{name:'Inspect storage',exact:true}).click();await card.getByText('Recover into a new server',{exact:true}).click();const form=card.locator('[data-recover-storage]');await form.getByLabel('New server name').fill('Remote recovered');await form.getByRole('textbox',{name:/confirm the source/}).fill('Remote island');await form.getByRole('checkbox').check();await form.getByRole('button',{name:'Recover stopped server'}).click();
 await expect.poll(()=>requests.length).toBe(2);expect(requests[1]).toMatchObject({path:'/api/hosts/'+remote+'/removed-servers/'+id+'/recover',body:{newName:'Remote recovered',name:'Remote island'}});expect(local.storageReview).toBeUndefined();
});
