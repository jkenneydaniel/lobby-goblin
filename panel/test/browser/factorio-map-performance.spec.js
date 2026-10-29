import {test as base,expect} from '@playwright/test';
import {scope,origins} from './playwright.config.js';
const test=base.extend({page:async({page},use)=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.context().route('**/*',route=>Object.values(origins).includes(new URL(route.request().url()).origin)?route.continue():route.abort());
 await use(page);expect(errors).toEqual([]);
}});
const revision='a'.repeat(64);
async function open(page){await page.goto(origins.factorio+scope+'/#map');await expect(page.locator('#world-map')).toBeVisible();}
async function delivery(page,{manual={availableAt:0,serverNow:Date.now()}}={}){
 const requests=[],pins=[];let full=0;
 const fixture={requests,pins,manual,staleWorld:false,get full(){return full;}};
 await page.route(/\/api\/map(?:\?.*)?$/,async route=>{
  const url=new URL(route.request().url());requests.push(url.search);
  if(url.searchParams.get('revision')===revision)return route.fulfill({json:{unchanged:true,revision,pins,manual,staleWorld:fixture.staleWorld}});
  const response=await route.fetch(),data=await response.json();full++;await route.fulfill({json:{...data,revision,pins,manual,staleWorld:fixture.staleWorld}});
 });
 return fixture;
}
for(const retain of [false,true])test('pin changes reuse the renderer and revisiting the map reuses its snapshot'+(retain?' with retained screen DOM':''),async({page})=>{
 if(retain)await page.route('**/application/host.js',async route=>{
  // The screen router permits retained roots; exercise that lifecycle without
  // depending on the application's current eager clearing of inactive roots.
  const response=await route.fetch(),source=await response.text(),clear='if (root.hidden) root.replaceChildren();';
  expect(source).toContain(clear);return route.fulfill({response,body:source.replace(clear,'')});
 });
 const fixture=await delivery(page);
 await page.route('**/api/pins',route=>{
  const body=route.request().postDataJSON();
  if(body.remove)fixture.pins.splice(0);else fixture.pins.push({id:'synthetic-pin',...body});
  return route.fulfill({json:{ok:true}});
 });
 await open(page);await page.locator('#world-map').evaluate(canvas=>globalThis.originalMapCanvas=canvas);
 await page.getByLabel('Pin label',{exact:true}).fill('Copper outpost');await page.locator('#pin-form').getByRole('button',{name:'Add shared pin',exact:true}).click();
 await expect(page.getByRole('button',{name:'Copper outpost · 0, 0',exact:true})).toBeVisible();
 expect(await page.locator('#world-map').evaluate(canvas=>canvas===globalThis.originalMapCanvas)).toBe(true);
 await page.locator('[data-remove-pin]').click();await expect(page.getByText('No shared pins yet.',{exact:true})).toBeVisible();
 expect(fixture.full).toBe(1);expect(fixture.requests.slice(1).every(query=>query.includes('revision='))).toBe(true);
 await page.getByRole('navigation',{name:/navigation/}).getByRole('link',{name:'Overview',exact:true}).click();
 await expect(page.locator('[data-view=overview]')).toBeVisible();await expect(page.locator('#world-map')).toBeHidden();
 await page.getByRole('navigation',{name:/navigation/}).getByRole('link',{name:'Map',exact:true}).click();
 await expect(page.locator('#world-map')).toBeVisible();expect(fixture.full).toBe(1);
 expect(await page.locator('#world-map').evaluate(canvas=>canvas===globalThis.originalMapCanvas)).toBe(false);
 const image=await page.locator('#world-map').evaluate(canvas=>canvas.toDataURL());
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();
 await expect.poll(()=>page.locator('#world-map').evaluate(canvas=>canvas.toDataURL())).not.toBe(image);
 await page.getByLabel('Pin label',{exact:true}).fill('Revisited outpost');await page.locator('#pin-form').getByRole('button',{name:'Add shared pin',exact:true}).click();
 await expect(page.getByRole('button',{name:'Revisited outpost · 0, 0',exact:true})).toBeVisible();
 expect(fixture.pins).toHaveLength(1);expect(fixture.full).toBe(1);
});
test('map status uses a 30-second budget and disabled tracking does not poll every two seconds',async({page})=>{
 await page.clock.install();let status=0,players=0;
 await page.route('**/api/map-status',async route=>{status++;return route.fulfill({json:{created:'unchanged',revision,automatic:{enabled:true,intervalMinutes:15}}});});
 await page.route('**/api/live-players',route=>{players++;return route.fulfill({json:{enabled:false,state:'disabled',players:[]}});});
 await delivery(page);await open(page);await expect.poll(()=>players).toBe(1);
 await page.clock.fastForward(29000);expect(status).toBe(0);expect(players).toBe(1);
 await page.clock.fastForward(6000);await expect.poll(()=>status).toBe(1);expect(players).toBe(1);
});
test('manual refresh shows a shared cooldown, becomes available locally, and starts only one explicit job',async({page},info)=>{
 await page.clock.install();const now=Date.now(),fixture=await delivery(page,{manual:{availableAt:now+60000,serverNow:now}}),submissions=[];
 let job=null;
 await page.route(/\/api\/jobs(?:\?.*)?$/,route=>{
  if(route.request().method()==='POST'){
   const body=route.request().postDataJSON();submissions.push(body);expect(body.action).toBe('refresh-map');
   fixture.manual.availableAt=Date.now()+120000;fixture.manual.serverNow=Date.now();
   job={id:'synthetic-manual-map',action:'refresh-map',state:'succeeded',message:'Synthetic map refreshed.',started:new Date().toISOString()};
   return route.fulfill({status:202,json:job});
  }
  return route.fulfill({json:{jobs:job?[job]:[],active:null}});
 });
 await open(page);await expect(page.locator('[data-map-refresh]')).toBeDisabled();await expect(page.locator('[data-map-refresh]')).toContainText('Refresh map in');
 await page.clock.fastForward(61000);await expect(page.locator('[data-map-refresh]')).toBeEnabled();expect(submissions).toEqual([]);
 await page.locator('[data-map-refresh]').click();await expect.poll(()=>submissions.length).toBe(1);
 await page.clock.fastForward(5000);await expect(page.locator('[data-map-refresh]')).toBeDisabled();
 await expect(page.locator('#map-manual-state')).toContainText('shared by everyone');
 await page.screenshot({path:info.outputPath('map-cooldown.png')});
 expect(submissions).toHaveLength(1);
});
test('a hidden map tab performs no snapshot or player polling',async({page})=>{
 await page.clock.install();let reads=0;
 await page.addInitScript(()=>{globalThis.mapTestHidden=false;Object.defineProperty(globalThis.document,'hidden',{configurable:true,get:()=>globalThis.mapTestHidden});});
 await page.route(/\/api\/(?:map-status|live-players)(?:\?.*)?$/,route=>{reads++;return route.fulfill({json:{enabled:false,state:'disabled',players:[],revision}});});
 await delivery(page);await open(page);await expect.poll(()=>reads).toBe(1);await page.evaluate(()=>globalThis.mapTestHidden=true);
 await page.clock.fastForward(65000);expect(reads).toBe(1);
});

test('an unchanged snapshot still updates the different-world warning after the active world changes',async({page})=>{
 const fixture=await delivery(page);
 await page.route('**/api/pins',route=>route.fulfill({json:{ok:true}}));
 await open(page);await expect(page.getByText('This snapshot belongs to a different world.',{exact:false})).toHaveCount(0);
 fixture.staleWorld=true;
 await page.getByLabel('Pin label',{exact:true}).fill('Review old world');await page.locator('#pin-form').getByRole('button',{name:'Add shared pin',exact:true}).click();
 await expect(page.getByText('This snapshot belongs to a different world.',{exact:false})).toBeVisible();expect(fixture.full).toBe(1);
});
