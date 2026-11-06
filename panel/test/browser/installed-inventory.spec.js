import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';

const origin = origins.modLibrary;
const test = base.extend({page: async ({page}, use) => {
  const routes = trackPageRoutes(page), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), blobs = new Map();
    globalThis.inventoryCaptures = [];
    globalThis.inventoryRevocations = [];
    URL.createObjectURL = blob => {const url = create(blob); blobs.set(url,blob); return url;};
    URL.revokeObjectURL = url => {globalThis.inventoryRevocations.push(url); revoke(url);};
    const click = globalThis.HTMLAnchorElement.prototype.click;
    globalThis.HTMLAnchorElement.prototype.click = function () {
      if (this.download === 'lobby-goblin-installed-mod-inventory.json') {
        globalThis.inventoryCaptures.push({filename:this.download,url:this.href,blob:blobs.get(this.href)});
        return;
      }
      return click.call(this);
    };
  });
  try {await use(page);} finally {page.releaseInventory?.(); await routes.dispose();}
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
}});
const download = page => page.getByRole('button',{name:'Download installed inventory',exact:true});
const samples = [
  {id:'same',title:'Literal <script>世界 & "name"</script>',version:'1.0',enabled:false,managed:true,modified:true,sha256:'AB'.repeat(32),name:'PRIVATE.cs',url:'https://private.invalid',dependencies:['PRIVATE'],config:'PRIVATE'},
  {id:'manual',title:'Manual unknown',version:null,enabled:true,managed:false,modified:false,sha256:'not-a-digest',source:{token:'PRIVATE'}},
];
const expected = (game, items = true) => ({game,scope:game==='rust'?'oxide':'factorio',reportedScopeVersion:game==='rust'?'2.0.7830':'2.0.77',items:items?[
  {id:'same',title:'Literal <script>世界 & "name"</script>',version:'1.0',enabled:false,managed:true,modified:true,sha256:'AB'.repeat(32)},
  {id:'manual',title:'Manual unknown',version:null,enabled:true,managed:false,modified:false,sha256:null},
]:[]});
async function capture(page, index=0) {
  return page.evaluate(async index => {
    const item = globalThis.inventoryCaptures[index];
    return {filename:item.filename,type:item.blob.type,text:await item.blob.text(),url:item.url};
  },index);
}

for (const game of ['factorio','rust']) test(`${game} installed inventory is a local complete allowlisted download with no mod action`, async ({page}) => {
  await page.clock.install();
  const prefix = '/servers/'+(game==='factorio'?'a':'b').repeat(32);
  let failure = false, empty = false, hold = false, release;
  const ledger = [];
  page.releaseInventory = () => release?.();
  page.on('request',request => {if(request.url().includes('/api/'))ledger.push(request.method()+' '+request.url());});
  await page.route('**/api/mod-library?*',async route => {
    const tab = new URL(route.request().url()).searchParams.get('tab');
    if(hold && tab==='installed') {hold=false; await new Promise(resolve=>release=resolve);}
    if(failure && tab==='installed') return route.fulfill({status:503,json:{error:'Synthetic inventory read failed'}});
    await route.fulfill({json:{game,scope:game==='rust'?'oxide':'factorio',version:game==='rust'?'2.0.7830':'2.0.77',source:'Synthetic catalogue',tab,items:tab==='installed'&&!empty?samples:[],page:1,pages:1,running:true,hotAvailable:game==='rust',recoveryRequired:true,account:{connected:true,token:'PRIVATE'},policy:'PRIVATE',note:'PRIVATE',hostId:'PRIVATE'}});
  });
  await page.goto(origin+prefix+'/#mods');
  await expect(page.locator('.ml-status')).toContainText('Synthetic catalogue');
  await expect(download(page)).toBeHidden();
  await page.getByRole('tab',{name:'Installed',exact:true}).click();
  await expect(download(page)).toBeEnabled();
  await expect(page.locator('.ml-item')).toHaveCount(2);
  await expect(page.locator('.ml-item [data-mod]').first()).toBeDisabled();
  await expect(page.locator('.ml-account')).toBeVisible({visible:game==='factorio'});
  await page.locator('[data-mode]').selectOption('restart');
  const before = [...ledger];
  await download(page).focus();
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>globalThis.inventoryCaptures.length)).toBe(1);
  const result = await capture(page);
  expect(result.filename).toBe('lobby-goblin-installed-mod-inventory.json');
  expect(result.type).toBe('application/json');
  expect(JSON.parse(result.text)).toEqual(expected(game));
  expect(result.text).not.toContain('PRIVATE');
  expect(ledger).toEqual(before);
  await expect(page.locator('[data-mode]')).toHaveValue('restart');
  await expect(page.locator('.ml-review')).not.toBeVisible();
  await page.clock.fastForward(1100);
  expect(await page.evaluate(()=>globalThis.inventoryRevocations)).toEqual([result.url]);
  // Failed and pending requests cannot relabel retained cards as a current report.
  failure=true;
  await page.getByRole('button',{name:'Refresh catalogue',exact:true}).click();
  await expect(page.locator('.ml-error').first()).toContainText('Synthetic inventory read failed');
  await expect(download(page)).toBeDisabled();
  failure=false; hold=true;
  await page.getByRole('button',{name:'Refresh catalogue',exact:true}).click();
  await expect(download(page)).toBeDisabled();
  await page.getByRole('tab',{name:'Updates',exact:true}).click();
  await expect(download(page)).toBeHidden();
  release();
  await expect(page.locator('.ml-results')).toHaveAttribute('aria-busy','false');
  await expect(download(page)).toBeHidden();
  empty=true;
  await page.getByRole('tab',{name:'Installed',exact:true}).click();
  await expect(download(page)).toBeEnabled();
  await expect(page.locator('.ml-item')).toHaveCount(0);
  await download(page).click();
  expect(JSON.parse((await capture(page,1)).text)).toEqual(expected(game,false));
});

test('mount request ownership fences out-of-order, disposal and equal IDs across contexts',async ({page})=>{
  const prefix = '/servers/'+'a'.repeat(32);
  await page.route('**/inventory-harness',route=>route.fulfill({contentType:'text/html',body:'<main id="fixture"></main>'}));
  await page.goto(origin+prefix+'/inventory-harness');
  await page.evaluate(async prefix=>{
    const {mountModLibrary}=await import(prefix+'/mod-library.js');
    const root=globalThis.document.querySelector('#fixture');
    globalThis.pendingInventory=[];
    globalThis.mountInventory=()=>{
      globalThis.library=mountModLibrary(root,{api:()=>new Promise((resolve,reject)=>globalThis.pendingInventory.push({resolve,reject})),job:()=>{throw Error('Unexpected mutation');},manageAccount:false});
    };
    globalThis.resolveInventory=(index,scope)=>globalThis.pendingInventory[index].resolve({game:'rust',scope,tab:'installed',items:[{id:'same',title:scope,version:null,enabled:false,managed:false,modified:false}],page:1,pages:1});
    globalThis.mountInventory();
  },prefix);
  await page.getByRole('tab',{name:'Installed',exact:true}).click();
  await expect(download(page)).toBeDisabled();
  await page.evaluate(()=>globalThis.resolveInventory(1,'local'));
  await expect(download(page)).toBeEnabled();
  await page.evaluate(()=>globalThis.resolveInventory(0,'old-browse'));
  await download(page).click();
  expect(JSON.parse((await capture(page)).text).scope).toBe('local');
  await expect(page.locator('.ml-account')).toBeHidden();
  await page.evaluate(()=>{void globalThis.library.refresh();globalThis.library.dispose();globalThis.resolveInventory(2,'disposed');});
  await expect(download(page)).toBeDisabled();
  await page.evaluate(()=>{globalThis.history.pushState({},'', '/hosts/'+'c'.repeat(32)+'/servers/'+'d'.repeat(32)+'/');globalThis.mountInventory();});
  await expect(download(page)).toBeHidden();
  await page.getByRole('tab',{name:'Installed',exact:true}).click();
  await page.evaluate(()=>globalThis.resolveInventory(4,'remote'));
  await expect(download(page)).toBeEnabled();
  await download(page).click();
  const remote=JSON.parse((await capture(page,1)).text);
  expect(remote.scope).toBe('remote');
  expect(remote.items[0].id).toBe('same');
  expect(remote.items[0].title).toBe('remote');
  await page.evaluate(()=>{globalThis.library.dispose();globalThis.document.querySelector('#fixture').replaceChildren();});
  await expect(download(page)).toHaveCount(0);
});

test('replacement inventory controls stay owned after old dispose and post-disposal refresh',async ({page})=>{
  const prefix='/servers/'+'a'.repeat(32);
  await page.route('**/inventory-harness',route=>route.fulfill({contentType:'text/html',body:'<main id="fixture"></main>'}));
  await page.goto(origin+prefix+'/inventory-harness');
  await page.evaluate(async prefix=>{
    const {mountModLibrary}=await import(prefix+'/mod-library.js');
    const root=globalThis.document.querySelector('#fixture');
    globalThis.inventoryOwnership={a:[],b:[],calls:[]};
    globalThis.mountInventoryOwner=owner=>mountModLibrary(root,{
      api:route=>{globalThis.inventoryOwnership.calls.push(owner+' '+route);return new Promise(resolve=>globalThis.inventoryOwnership[owner].push(resolve));},
      job:()=>{throw Error('Unexpected mutation');},
    });
    globalThis.resolveInventoryOwner=(owner,index)=>globalThis.inventoryOwnership[owner][index]({game:'rust',scope:'oxide',version:'scope-version',tab:'installed',items:[{id:'same',title:owner,version:null,enabled:false,managed:false,modified:false}],page:1,pages:1});
    globalThis.oldInventoryOwner=globalThis.mountInventoryOwner('a');
  },prefix);
  await page.getByRole('tab',{name:'Installed',exact:true}).click();
  await page.evaluate(()=>globalThis.resolveInventoryOwner('a',1));
  await expect(download(page)).toBeEnabled();
  await page.evaluate(()=>{
    globalThis.oldInventoryOwner.dispose();
    globalThis.currentInventoryOwner=globalThis.mountInventoryOwner('b');
    globalThis.resolveInventoryOwner('b',0);
  });
  await expect(download(page)).toBeEnabled();
  await page.evaluate(()=>globalThis.oldInventoryOwner.dispose());
  await expect(download(page)).toBeEnabled();
  await page.evaluate(()=>{globalThis.oldInventoryRefresh=globalThis.oldInventoryOwner.refresh();});
  await expect(download(page)).toBeEnabled();
  await page.evaluate(async ()=>{globalThis.resolveInventoryOwner('a',2);await globalThis.oldInventoryRefresh;});
  await expect(download(page)).toBeEnabled();
  const before=await page.evaluate(()=>[...globalThis.inventoryOwnership.calls]);
  await download(page).click();
  expect(JSON.parse((await capture(page)).text)).toEqual({game:'rust',scope:'oxide',reportedScopeVersion:'scope-version',items:[{id:'same',title:'b',version:null,enabled:false,managed:false,modified:false,sha256:null}]});
  expect(await page.evaluate(()=>globalThis.inventoryCaptures.length)).toBe(1);
  expect(await page.evaluate(()=>globalThis.inventoryOwnership.calls)).toEqual(before);
  await page.evaluate(()=>globalThis.currentInventoryOwner.dispose());
});

for(const game of ['factorio','rust']) for(const granted of [false,true]) test(`${game} inventory keeps existing delegated mod visibility: ${granted}`,async ({page})=>{
  const prefix='/servers/'+(game==='factorio'?'a':'b').repeat(32);
  let signedOut=false;
  await page.route('**/api/session',route=>route.fulfill(signedOut?{status:401,json:{error:'Synthetic session ended'}}:{json:{username:'Assigned',role:'member',csrf:'fixture',permissions:granted?['server.view','mods.manage','application.rust.plugins.manage']:['server.view'],allowedActions:granted?['mod-library-install','mod-library-recover']:[],onboarding:{completed:true}}}));
  await page.goto(origin+prefix+'/#mods');
  await expect(page.locator('.product-shell')).toBeVisible();
  if(granted) {
    await expect(page.locator('.ml-status')).toContainText(game==='factorio'?'Factorio Mod Portal':'uMod');
    await page.getByRole('tab',{name:'Installed',exact:true}).click();
    await expect(download(page)).toBeEnabled();
    await expect(page.locator('.ml-account')).toBeHidden();
    await download(page).click();
    expect(JSON.parse((await capture(page)).text).items).toEqual([]);
  } else {
    await expect(download(page)).toHaveCount(0);
    await expect(page.getByRole('tab',{name:'Installed',exact:true})).toHaveCount(0);
  }
  signedOut=true;
  await page.reload();
  await expect(page.getByLabel('Username',{exact:true})).toBeVisible();
  await expect(download(page)).toHaveCount(0);
});
