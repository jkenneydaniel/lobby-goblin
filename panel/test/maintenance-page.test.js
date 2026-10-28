import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {respondMaintenancePage} from '../core/maintenance-page.js';
import {watchMaintenance,checkMaintenancePage} from '../public/maintenance-reconnect.js';

test('maintenance documents are self-contained, private, uncacheable and protected by exact CSP hashes', async t => {
  const server = http.createServer((req, res) => void respondMaintenancePage(req, res).then(handled => {
    if (!handled) {res.writeHead(503, {'content-type':'application/json'});res.end('{"error":"held"}');}
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections();server.close();});
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const route of ['/', '/servers/' + 'a'.repeat(32) + '/', '/?return=%3Cscript%3Eprivate-marker']) {
    const response = await fetch(origin + route, {headers:{accept:'text/html'}}), html = await response.text();
    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('retry-after'), '3');
    assert.match(html, /A little goblin upkeep/);
    assert.match(html, /<svg /);
    assert.doesNotMatch(html, /private-marker|<script[^>]+src=|<link /);
    for (const [tag, directive] of [['style','style-src'], ['script','script-src']]) {
      const body = html.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)</'+tag+'>'))[1];
      const hash = crypto.createHash('sha256').update(body).digest('base64');
      assert.ok(response.headers.get('content-security-policy').includes(directive + " 'sha256-" + hash + "'"));
    }
    assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  }
  const head = await fetch(origin, {method:'HEAD',headers:{accept:'text/html'}});
  assert.equal(head.status,503);assert.equal(await head.text(),'');
  for (const [route,method,accept] of [['/api/session','GET','text/html'], ['/hosts/'+'a'.repeat(32)+'/servers/'+'b'.repeat(32)+'/api/login','POST','text/html'], ['/management/status','GET','text/html'], ['/maintenance.css','GET','text/html'], ['/','GET','application/json'], ['/','POST','text/html']]) {
    const response = await fetch(origin+route,{method,headers:{accept}});
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'held'});
  }
});

function fixture() {
  let pending, checks = 0, ready = 0, slow = 0, time = 0, scheduled;
  const result = {status:503,headers:new Headers({'content-type':'text/html'})};
  const watcher = watchMaintenance({
    check: async () => {checks++;if(pending)await pending;return result;},
    ready:()=>ready++,slow:()=>slow++,now:()=>time,
    schedule:fn=>{scheduled=fn;return 1;},cancel:()=>{scheduled=null;},
  });
  return {watcher,result,get checks(){return checks;},get ready(){return ready;},get slow(){return slow;},tick:async()=>scheduled?.(),time:value=>{time=value;},block:value=>{pending=value;}};
}
test('reconnection ignores healthy JSON, survives unavailable ingress and returns only when the original HTML is ready',async()=>{
  const f=fixture();await f.tick();assert.equal(f.checks,1);assert.equal(f.ready,0);
  f.result.status=200;f.result.headers=new Headers({'content-type':'application/json'});await f.tick();assert.equal(f.ready,0);
  f.result.status=502;await f.tick();assert.equal(f.ready,0);
  f.result.status=200;f.result.headers=new Headers({'content-type':'text/html; charset=utf-8'});await f.tick();assert.equal(f.ready,1);
  await f.watcher.retry();assert.equal(f.checks,4);
});
test('a longer wait offers help once, manual retries do not overlap and disposal prevents a late reload',async()=>{
  const f=fixture();f.time(120001);await f.tick();assert.equal(f.slow,1);await f.tick();assert.equal(f.slow,1);
  let finish;f.block(new Promise(resolve=>{finish=resolve;}));
  const first=f.watcher.retry();await f.watcher.retry();assert.equal(f.checks,3);
  f.watcher.stop();f.result.status=200;finish();await first;assert.equal(f.ready,0);
});
test('a connection failure keeps checking without resubmitting any update',async()=>{
  let task, checks=0;
  const watcher=watchMaintenance({check:async()=>{checks++;throw Error('connection reset');},ready:()=>assert.fail('Not ready'),slow:()=>{},schedule:fn=>{task=fn;},cancel:()=>{}});
  await task();await task();assert.equal(checks,2);watcher.stop();
});

test('local and remote server session redirects reconnect only through the fixed same-origin sign-in page',async()=>{
  for(const scope of ['/servers/'+'a'.repeat(32)+'/', '/hosts/'+'b'.repeat(32)+'/servers/'+'a'.repeat(32)+'/']){
    const calls=[];
    const result=await checkMaintenancePage('http://panel.test'+scope+'?view=panel#updates',async(url,options)=>{
      calls.push({url,options});
      return calls.length===1?{status:0,type:'opaqueredirect'}:{status:200,headers:new Headers({'content-type':'text/html'})};
    });
    assert.equal(result.signIn,true);assert.equal(result.status,200);
    assert.deepEqual(calls.map(x=>x.url),['http://panel.test'+scope+'?view=panel','http://panel.test/']);
    assert.deepEqual(calls.map(x=>x.options.redirect),['manual','error']);
    assert.ok(calls.every(x=>x.options.method==='GET'&&x.options.credentials==='same-origin'));
  }
});
test('non-server redirects are not followed and an unavailable sign-in page cannot signal readiness',async()=>{
  let calls=0;
  const result=await checkMaintenancePage('http://panel.test/',async()=>{calls++;return {type:'opaqueredirect',status:0};});
  assert.equal(calls,1);assert.equal(result.status,0);
  const scoped=await checkMaintenancePage('http://panel.test/servers/'+'a'.repeat(32)+'/',async(url)=>{
    assert.ok(url.startsWith('http://panel.test/'));
    return url==='http://panel.test/'?{status:503,headers:new Headers({'content-type':'text/html'})}:{status:302,headers:new Headers({location:'https://untrusted.example/'})};
  });
  assert.equal(scoped.status,503);
});
