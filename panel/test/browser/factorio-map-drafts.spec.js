import {test as base,expect} from '@playwright/test';
import {scope,origins} from './playwright.config.js';
import {emptySetups,changeSetups} from '../../applications/factorio/world-setups.js';

const test=base.extend({page:async({page},use)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.context().route('**/*',route=>Object.values(origins).includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  await use(page);expect(errors).toEqual([]);
}});
async function open(page,hash,role='admin'){
  await page.route('**/api/session',async route=>{
    const response=await route.fetch();await route.fulfill({json:{...await response.json(),role,onboarding:{completed:true}}});
  });
  await page.goto(origins.factorio+scope+'/'+hash);
}
async function drafts(page,{conflict=false,delay=0}={}){
  let setups=emptySetups();const submissions=[];
  await page.route('**/api/world-setups',async route=>{
    try{
      if(route.request().method()==='POST'){
        const body=route.request().postDataJSON();submissions.push(body);
        if(body.operation==='draft'&&delay)await new Promise(resolve=>setTimeout(resolve,delay));
        if(body.operation==='discard'&&conflict)throw Object.assign(Error('Your saved setups changed in another tab. Reload before editing.'),{status:409});
        setups=changeSetups(setups,body);
      }
      await route.fulfill({json:setups});
    }catch(error){await route.fulfill({status:error.status||400,json:{error:error.message}});}
  });
  return {get setups(){return setups;},submissions};
}

test('map refresh preferences are editable, retained after navigation, and describe save-based timing',async({page},info)=>{
  let automatic={enabled:true,intervalMinutes:0,pending:false,running:false,lastError:null};const writes=[];
  await page.route('**/api/map',async route=>{const response=await route.fetch();await route.fulfill({json:{...await response.json(),automatic}});});
  await page.route('**/api/map-status',async route=>{const response=await route.fetch();await route.fulfill({json:{...await response.json(),automatic}});});
  await page.route('**/api/map-settings',async route=>{const body=route.request().postDataJSON();writes.push(body);automatic={...automatic,...body};await route.fulfill({json:automatic});});
  await open(page,'#map');await page.getByText('Map refresh settings',{exact:true}).click();
  await page.getByLabel('Minimum time between refreshes (minutes)',{exact:true}).fill('15');
  await page.getByRole('button',{name:'Save map refresh settings',exact:true}).click();
  await expect(page.locator('#map-refresh-state')).toContainText('at most once every 15 minutes');
  await expect(page.locator('#map-settings-result')).toHaveText('Map refresh settings saved.');
  expect(writes).toEqual([{enabled:true,intervalMinutes:15}]);
  await page.screenshot({path:info.outputPath('map-refresh-'+info.project.name+'.png'),fullPage:true});
  await page.getByLabel('Refresh automatically after saves',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Save map refresh settings',exact:true}).click();
  await expect(page.locator('#map-refresh-state')).toContainText('Automatic refresh is off');
  await page.goto(origins.factorio+scope+'/#worlds');await page.goto(origins.factorio+scope+'/#map');
  await page.getByText('Map refresh settings',{exact:true}).click();
  await expect(page.getByLabel('Refresh automatically after saves',{exact:true})).not.toBeChecked();
  await expect(page.getByLabel('Minimum time between refreshes (minutes)',{exact:true})).toHaveValue('15');
});
test('map refresh settings are hidden from viewers',async({page})=>{
  await open(page,'#map','viewer');await expect(page.locator('#world-map')).toBeVisible();
  await expect(page.getByText('Map refresh settings',{exact:true})).toHaveCount(0);
});
test('cancel draft settles a pending autosave, deletes it once, and returns to library without creating worlds',async({page},info)=>{
  const store=await drafts(page,{delay:200}),jobs=[];
  await page.route('**/api/jobs',route=>{if(route.request().method()==='POST')jobs.push(route.request().postDataJSON());return route.continue();});
  await open(page,'#worlds/create');await page.getByRole('textbox',{name:/^World name/}).fill('Cancelled copper coast');
  await page.getByRole('button',{name:'Cancel draft',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('draft-cancel-'+info.project.name+'.png')});
  await page.getByRole('button',{name:'Cancel draft',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Cancel this world draft?'});
  await expect(dialog).toContainText('This does not cancel a submitted Create world operation.');
  await dialog.getByRole('button',{name:'Cancel draft',exact:true}).click();
  await expect(page).toHaveURL(/#worlds$/);await expect(page.locator('#create-form')).toHaveCount(0);
  expect(store.setups.draft).toBeNull();expect(store.submissions.filter(body=>body.operation==='discard')).toHaveLength(1);
  await expect(page.getByRole('link',{name:'Resume world draft',exact:true})).toHaveCount(0);
  await page.waitForTimeout(900);expect(store.setups.draft).toBeNull();expect(jobs).toEqual([]);
  await page.reload();await expect(page.getByRole('link',{name:'Resume world draft',exact:true})).toHaveCount(0);
});
test('a rejected draft cancellation retains the editor and saved draft',async({page})=>{
  const store=await drafts(page,{conflict:true});await open(page,'#worlds/create');
  await page.getByRole('textbox',{name:/^World name/}).fill('Keep this draft');
  await expect(page.locator('#draft-save-state')).toContainText('Draft saved to your account');
  await page.getByRole('button',{name:'Cancel draft',exact:true}).click();
  await page.getByRole('dialog',{name:'Cancel this world draft?'}).getByRole('button',{name:'Cancel draft',exact:true}).click();
  await expect(page.locator('#world-form-error')).toContainText('another tab');
  await expect(page).toHaveURL(/#worlds\/create$/);
  await expect(page.getByRole('textbox',{name:/^World name/})).toHaveValue('Keep this draft');
  expect(store.setups.draft.name).toBe('Keep this draft');await expect(page.locator('#create-form')).not.toHaveAttribute('inert');
});
test('large saved-map rendering preserves inspection, zoom, layers and one terrain atlas',async({page},info)=>{
  await page.addInitScript(()=>{const create=globalThis.document.createElement.bind(globalThis.document);globalThis.mapAtlasCount=0;globalThis.document.createElement=function(name,...args){if(name==='canvas')globalThis.mapAtlasCount++;return create(name,...args);};});
  await page.route('**/api/map',async route=>{
    const response=await route.fetch(),value=await response.json(),map=value.snapshot;
    map.chunks=Array.from({length:2048},(_,i)=>({x:(i%64)-32,y:Math.floor(i/64)-16,tiles:[1,256],pollution:0}));
    map.entities=Array.from({length:79999},(_,i)=>({name:'iron-ore',type:'resource',category:'resources',x:(i%400)*5-1000,y:Math.floor(i/400)*5-500,w:1,h:1,color:[70,100,160],amount:1000}));
    map.entities.push({name:'biter-spawner',type:'unit-spawner',category:'enemies',x:0,y:0,w:7,h:7,color:[220,30,20]});map.enemyUnits=true;
    await route.fulfill({json:value});
  });
  await open(page,'#map');await expect(page.locator('#world-map')).toBeVisible();
  await page.getByRole('button',{name:'Base / spawn',exact:true}).click();
  const box=await page.locator('#world-map').boundingBox();await page.locator('#world-map').click({position:{x:box.width/2,y:box.height/2}});
  await expect(page.locator('#map-selection-title')).toHaveText('biter spawner');
  await expect(page.locator('#map-selection-detail')).toContainText('Enemy base');
  await page.getByLabel('Enemies & bases',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await page.getByRole('button',{name:'Fit map',exact:true}).click();
  expect(await page.evaluate(()=>globalThis.mapAtlasCount)).toBe(1);
  await page.screenshot({path:info.outputPath('large-map-'+info.project.name+'.png'),fullPage:true});
});
test('a submitted world operation disables draft cancellation',async({page})=>{
  const job={id:'fixture-create',action:'create',state:'running',message:'Creating the library world…',started:new Date().toISOString()};
  await page.route(/\/api\/jobs(?:\?.*)?$/,route=>route.fulfill({json:{jobs:[job],active:job}}));
  await open(page,'#worlds/create');await expect(page.getByRole('button',{name:'Cancel draft',exact:true})).toBeDisabled();
});
test('oversized modded objects remain visible and selectable when their center is outside the viewport',async({page})=>{
  await page.route('**/api/map',async route=>{
    const response=await route.fetch(),value=await response.json();
    Object.assign(value.snapshot,{players:[],entities:[{name:'oversized-modded-building',category:'buildings',x:800,y:0,w:1600,h:40,color:[100,100,20]}]});
    await route.fulfill({json:value});
  });
  await open(page,'#map');await page.getByRole('button',{name:'Base / spawn',exact:true}).click();
  const canvas=page.locator('#world-map'),box=await canvas.boundingBox();
  await canvas.click({position:{x:box.width/2+12,y:box.height/2}});
  await expect(page.locator('#map-selection-title')).toHaveText('oversized modded building');
  await expect.poll(()=>canvas.evaluate(element=>{
    const ratio=element.width/element.getBoundingClientRect().width;
    return [...element.getContext('2d').getImageData(Math.floor(element.width/2+30*ratio),Math.floor(element.height/2),1,1).data];
  })).toEqual([229,201,133,255]);
});
