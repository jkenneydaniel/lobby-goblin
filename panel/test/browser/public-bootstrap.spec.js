import {test as base,expect} from '@playwright/test';
import {origins} from './playwright.config.js';
const test=base.extend({page:async({page},use)=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.context().route('**/*',route=>new URL(route.request().url()).origin===origins.fleet?route.continue():route.abort());
 await use(page);expect(errors).toEqual([]);
}});
async function open(page){
 await page.goto(origins.fleet);await page.getByLabel('Username',{exact:true}).fill('Preview');await page.getByLabel('Password',{exact:true}).fill('isolated-panel-preview-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('navigation',{name:/navigation/}).getByRole('link',{name:'Hosts',exact:true}).click();await page.locator('#add-host').click();await page.locator('#choose-manual').click();await page.getByText('I need to install the agent',{exact:true}).click();
}
test('manual host pairing offers copyable curl/wget commands pinned to the panel release',async({page},info)=>{
 await page.addInitScript(()=>{globalThis.bootstrapClipboard=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{globalThis.bootstrapClipboard.push(text);}}});});
 await open(page);const version=(await(await page.request.get(origins.fleet+'/api/status')).json()).version,command=page.locator('#manual-host-command');
 await expect(command).toHaveValue(new RegExp('^curl -fsSL https://raw.githubusercontent.com/jkenneydaniel/lobby-goblin/main/Install.sh \\| bash -s -- --version '+version.replaceAll('.','\\.')+' --host-agent --start '));
 await page.locator('#copy-host-command').click();expect(await page.evaluate(()=>globalThis.bootstrapClipboard.at(-1))).toContain('--version '+version);
 await page.locator('#manual-install-docker').check();await expect(command).toHaveValue(/--host-agent --install-docker --start/);
 await page.locator('#manual-download-tool').selectOption('wget');await expect(command).toHaveValue(/^wget -qO-/);await command.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('public-host-command.png')});
 await page.locator('#close-add-host').click();await page.locator('#add-host').click();await page.locator('#choose-manual').click();await expect(page.locator('#manual-download-tool')).toHaveValue('curl');await expect(command).toHaveValue(/^curl -fsSL/);
});
test('an unavailable release disables command copying without hiding connected hosts',async({page})=>{
 await page.route('**/api/status',route=>route.fulfill({status:503,json:{error:'Status unavailable'}}));await open(page);
 await expect(page.locator('#manual-host-command')).toHaveValue(/Cannot read this panel/);await expect(page.locator('#copy-host-command')).toBeDisabled();
});
