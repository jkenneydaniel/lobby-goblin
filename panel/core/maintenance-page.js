import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {maintenanceView} from '../public/shared/maintenance-view.js';

let page;
async function content() {
  const [css, script] = await Promise.all(['maintenance.css', 'maintenance-reconnect.js'].map(name => fs.readFile(new URL('../public/' + name, import.meta.url), 'utf8')));
  const hash = value => "'sha256-" + crypto.createHash('sha256').update(value).digest('base64') + "'";
  return {
    policy: `default-src 'none'; script-src ${hash(script)}; style-src ${hash(css)}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    html: Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lobby Goblin · A little upkeep</title><style>${css}</style></head><body class="maintenance-document"><main>${maintenanceView({standalone:true})}<button type="button" data-maintenance-retry>Check again</button><div data-maintenance-help hidden><details class="maintenance-help"><summary>Taking longer than expected?</summary><p>You can leave this page and return later. Recovery records are saved automatically; there’s no update ID to write down.</p><p>If the panel stays unavailable, the host administrator can inspect its saved update using the <a href="https://github.com/jkenneydaniel/lobby-goblin/blob/main/docs/MANAGEMENT_UPDATES.md" target="_blank" rel="noopener noreferrer">recovery guide</a>.</p></details></div><noscript><p class="maintenance-help">Refresh this page to check whether your panel is ready.</p></noscript></main><script type="module">${script}</script></body></html>`),
  };
}

// Browser documents get a self-contained page. Machine APIs, private operator
// routes and asset requests retain their existing status and JSON contracts.
export async function respondMaintenancePage(req, res) {
  const pathname = new URL(req.url, 'http://maintenance').pathname;
  if (!['GET', 'HEAD'].includes(req.method) ||
    /(?:^|\/)(?:api|management)(?:\/|$)/.test(pathname) ||
    /\.[^/]+$/.test(pathname) && !pathname.endsWith('.html') ||
    !(req.headers['sec-fetch-mode'] === 'navigate' || /\btext\/html\b/i.test(req.headers.accept || ''))) return false;
  page ||= content().catch(error => {page = null; throw error;});
  const {html, policy} = await page;
  res.writeHead(503, {'content-type':'text/html; charset=utf-8','content-length':html.length,'cache-control':'no-store','retry-after':'3','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':policy});
  res.end(req.method === 'HEAD' ? undefined : html);
  return true;
}
