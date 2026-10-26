import http from 'node:http';
import fs from 'node:fs/promises';
const file = process.env.SETTINGS_FILE || '/data/settings.json';
const settings = JSON.parse(await fs.readFile(file, 'utf8'));
if (typeof settings.title !== 'string' || typeof settings.message !== 'string')
  throw Error('Invalid status page settings.');
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type': 'application/json'});
    return res.end('{"ready":true}');
  }
  if (req.method !== 'GET' || req.url !== '/') {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' +
      escape(settings.title) +
      '</title><style>body{font:20px system-ui;max-width:44rem;margin:10vh auto;padding:2rem;line-height:1.6}p{white-space:pre-wrap}</style><h1>' +
      escape(settings.title) +
      '</h1><p>' +
      escape(settings.message) +
      '</p></html>',
  );
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () =>
  console.log('Status page ready on port ' + server.address().port),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => server.close(() => process.exit(0)));
