import {test as base, expect} from '@playwright/test';
import {origins} from './playwright.config.js';
import {trackPageRoutes} from './route-drain.js';
const test=base.extend({page:async({page},use)=>{
 const routes=trackPageRoutes(page),errors=[],external=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.context().route('**/*',route=>{const url=new URL(route.request().url());if(Object.values(origins).includes(url.origin))return route.continue();external.push(url.origin);return route.abort();});
 try{await use(page);}finally{await routes.dispose();}
 expect(errors).toEqual([]);expect(external).toEqual([]);
}});
const local='a'.repeat(32),remote='d'.repeat(32),id='b'.repeat(32);
const service={id,game:'status-page',applicationName:'Status Page',applicationKind:'application',webProtocol:'http',name:'Public service',address:'service.example.test:35000',state:'installed',cpu:1,memoryGiB:2,manageUrl:'/servers/'+id+'/'};
const cards=page=>page.locator('#servers article.card');
async function fixture(page,{assigned=false}={}){
 const state={hosts:[{id:local,name:'This host',local:true,connected:true},{id:remote,name:'Remote host',local:false,connected:true}],local:[{...service}],remote:[{...service,name:'Remote service',address:'remote.example.test:35003'}],reads:[]};
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(route.request().method()!=='GET')return route.fallback();
  state.reads.push(path);
  if(path==='/api/hosts')return route.fulfill({json:{hosts:state.hosts}});
  if(path==='/api/servers')return route.fulfill({json:{servers:state.local}});
  if(path==='/api/hosts/'+remote+'/servers')return route.fulfill({json:{servers:state.remote}});
  if(path==='/api/assigned-servers')return route.fulfill({json:{servers:[{...state.remote[0],manageUrl:'/hosts/'+remote+'/servers/'+id+'/'}]}});
  if(/\/snapshots$/.test(path))return route.fulfill({json:{snapshots:[]}});
  if(/\/jobs$/.test(path))return route.fulfill({json:{jobs:[],active:null}});
  if(/\/servers\/[a-f0-9]{32}\/api\/status$/.test(path))return route.fulfill({json:{ready:true,running:true,players:[]}});
  return route.fallback();
 });
 await page.goto(origins.fleet);
 await page.getByLabel('Username',{exact:true}).fill(assigned?'Assigned':'Viewer');
 await page.getByLabel('Password',{exact:true}).fill('isolated-panel-preview-password');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('searchbox',{name:'Find servers',exact:true})).toBeVisible();
 return state;
}
test('application cards distinguish management from a user-opened public endpoint on desktop and mobile',async({page},info)=>{
 const requests=[];
 await page.context().route('http://service.example.test:35000/',route=>{return route.request().allHeaders().then(headers=>{requests.push(headers);return route.fulfill({contentType:'text/html',body:'<h1>Synthetic public application</h1>'});});});
 await fixture(page);
 await expect(cards(page)).toHaveCount(2);
 const card=cards(page).first(),link=card.getByRole('link',{name:'Open application',exact:true});
 await expect(card.getByRole('link',{name:'Manage application'})).toHaveAttribute('href','/servers/'+id+'/');
 await expect(card).toContainText('STATUS PAGE');await expect(card).not.toContainText('players');
 await expect(card).toContainText('separate from panel sign-in · not encrypted');
 await expect(link).toHaveAttribute('href','http://service.example.test:35000/');await expect(link).toHaveAttribute('rel','noopener noreferrer');
 expect(requests).toHaveLength(0);
 await link.focus();const popupPromise=page.context().waitForEvent('page');await page.keyboard.press('Enter');const popup=await popupPromise;
 await expect(popup.getByRole('heading')).toHaveText('Synthetic public application');expect(await popup.evaluate(()=>globalThis.opener === null)).toBe(true);
 expect(requests).toHaveLength(1);expect(requests[0].cookie).toBeUndefined();expect(requests[0].referer).toBeUndefined();await popup.close();
 await expect(cards(page).nth(1).getByRole('link',{name:'Manage application'})).toHaveAttribute('href','/hosts/'+remote+'/servers/'+id+'/');
 await expect(cards(page).nth(1).getByRole('link',{name:'Open application'})).toHaveAttribute('href','http://remote.example.test:35003/');
 expect(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('application-public-access.png'),fullPage:true});
});
test('assigned application access uses only its minimal scoped list',async({page})=>{
 const state=await fixture(page,{assigned:true});await expect(cards(page)).toHaveCount(1);
 await expect(cards(page).getByRole('link',{name:'Open application'})).toHaveAttribute('href','http://remote.example.test:35003/');
 await expect(cards(page).getByRole('link',{name:'Manage application'})).toHaveAttribute('href','/hosts/'+remote+'/servers/'+id+'/');
 expect(state.reads.some(path=>path==='/api/hosts'||path==='/api/catalog'||path.endsWith('/api/status'))).toBe(false);
 await expect(page.getByRole('button',{name:'Publish snapshot',exact:true})).toHaveCount(0);
});
test('offline cached applications lose public actions and unsafe destinations never become links',async({page})=>{
 await page.clock.install();const state=await fixture(page);await expect(cards(page)).toHaveCount(2);
 state.hosts[1].connected=false;state.local[0].address='user:pass@evil.example:80';
 await page.clock.fastForward(6000);await expect(cards(page).nth(1)).toContainText('Host unavailable');
 await expect(page.getByRole('link',{name:'Open application',exact:true})).toHaveCount(0);
 await expect(cards(page).first().getByRole('button',{name:'Copy address'})).toBeVisible();
});

for(const assigned of [false,true])test('same-host public applications never expose an action that sends panel cookies '+assigned,async({page})=>{
 await page.clock.install();const state=await fixture(page,{assigned});
 state.local[0].address='127.1:35000';state.remote[0].address='127.0.0.1:35003';
 await page.clock.fastForward(6000);
 await expect(page.getByRole('link',{name:'Open application',exact:true})).toHaveCount(0);
 await expect(cards(page).first()).toContainText('keep panel sign-in cookies separate');
 await expect(cards(page).first().getByRole('link',{name:'Manage application'})).toBeVisible();
 await expect(cards(page).first().getByRole('button',{name:'Copy address'})).toBeVisible();
});
