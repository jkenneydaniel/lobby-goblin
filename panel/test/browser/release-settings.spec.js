import {test,expect} from '@playwright/test';
import {origins} from './playwright.config.js';

test('administrator can enable release checks, choose a channel, and recover from a stale save',async({page},info)=>{
  let settings={version:1,enabled:false,channel:'preview',revision:0,editable:true},checks=0,conflict=false;
  const errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.context().route('**/*',route=>{
    if(new URL(route.request().url()).origin===origins.fleet)return route.continue();
    external.push(route.request().url());return route.abort();
  });
  await page.route('**/api/updates/settings',route=>{
    if(route.request().method()==='POST'){
      if(conflict)return route.fulfill({status:409,json:{error:'Release check settings changed in another session. Reload before saving.'}});
      const body=route.request().postDataJSON();expect(body.revision).toBe(settings.revision);settings={...settings,...body,revision:settings.revision+1};
    }
    return route.fulfill({json:settings});
  });
  await page.route(/\/api\/updates(?:\/check)?$/,route=>{
    if(route.request().method()==='POST')checks++;
    return route.fulfill({json:{current:'0.3.11-alpha',state:settings.enabled?'current':'disabled',channel:settings.channel,available:false,checkedAt:settings.enabled?'2026-10-27T12:00:00Z':null}});
  });
  await page.goto(origins.fleet);
  await page.getByLabel('Username',{exact:true}).fill('Preview');
  await page.getByLabel('Password',{exact:true}).fill('isolated-panel-preview-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('navigation',{name:/navigation/}).getByRole('link',{name:'Updates',exact:true}).click();
  await expect(page.getByText(/Release checks are off/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Check for updates',exact:true})).toBeDisabled();
  await page.getByLabel('Check GitHub for management releases').check();
  await page.getByRole('combobox',{name:'Release channel',exact:true}).selectOption('stable');
  await page.getByRole('button',{name:'Save release settings'}).click();
  await expect(page.getByText('You have the newest release in this channel.')).toBeVisible();
  expect(checks).toBe(1);
  await page.reload();
  await expect(page.getByLabel('Check GitHub for management releases')).toBeChecked();
  await expect(page.getByRole('combobox',{name:'Release channel',exact:true})).toHaveValue('stable');
  await page.screenshot({path:`../../../output/playwright/release-settings-${info.project.name}.png`,fullPage:true});
  conflict=true;
  await page.getByRole('combobox',{name:'Release channel',exact:true}).selectOption('preview');
  await page.getByRole('button',{name:'Save release settings'}).click();
  await expect(page.getByRole('alert')).toContainText('changed in another session');
  await page.reload();
  await expect(page.getByRole('combobox',{name:'Release channel',exact:true})).toHaveValue('stable');
  expect(errors).toEqual([]);expect(external).toEqual([]);
});

test('server creation follows package seed bounds without narrowing Factorio',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.context().route('**/*',route=>new URL(route.request().url()).origin===origins.fleet?route.continue():route.abort());
  await page.goto(origins.fleet);await page.getByLabel('Username',{exact:true}).fill('Preview');
  await page.getByLabel('Password',{exact:true}).fill('isolated-panel-preview-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Create server',exact:true}).click();
  const form=page.locator('#create'),seed=form.locator('[name=seed]');
  await expect(seed).toHaveAttribute('max','4294967295');await seed.fill('3532793187');
  expect(await seed.evaluate(input=>input.validity.rangeOverflow)).toBe(false);
  await form.locator('[name=game]').selectOption('rust');
  await expect(seed).toHaveAttribute('max','2147483647');
  expect(await seed.evaluate(input=>input.validity.rangeOverflow)).toBe(true);
  await seed.fill('2147483647');expect(await seed.evaluate(input=>input.checkValidity())).toBe(true);
  await form.locator('[name=game]').selectOption('factorio');
  await expect(seed).toHaveAttribute('max','4294967295');await seed.fill('4294967295');
  expect(await seed.evaluate(input=>input.checkValidity())).toBe(true);expect(errors).toEqual([]);
});
