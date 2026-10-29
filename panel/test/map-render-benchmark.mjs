// Loopback-only renderer measurement. Uses generated coordinates; never reads a
// world, contacts a controller, or opens Docker. Optional Git baseline is fixed
// at startup, not selected by an HTTP request.
import http from 'node:http';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repository=new URL('../../',import.meta.url), source=new URL('../applications/factorio/public/',import.meta.url);
const baseline=process.argv[2], modules=['map.js','map-spatial.js','map-lod.js'], previous=new Map();
if(baseline){
 const revision=execFileSync('git',['rev-parse','--verify','--end-of-options',baseline+'^{commit}'],{cwd:fileURLToPath(repository),encoding:'utf8'}).trim();
 for(const name of modules){try{previous.set(name,execFileSync('git',['show',revision+':panel/applications/factorio/public/'+name],{cwd:fileURLToPath(repository),stdio:['ignore','pipe','ignore']}));}catch{}}
}
const html='<!doctype html><html><head><title>Isolated map renderer measurement</title><style>body{margin:0;background:#101a19;color:#ddd;font:16px system-ui}canvas{display:block;width:1200px;height:600px;max-width:95vw}button{padding:8px}pre{white-space:pre-wrap}</style></head><body><h1>Isolated map renderer measurement</h1><p>Generated coordinates only. No game or saved world access.</p><canvas id="world-map" tabindex="0"></canvas><div><button id="map-plus">Zoom in</button><button id="map-minus">Zoom out</button><button id="map-fit">Fit</button><button id="map-base">Base</button><button id="benchmark-run">Run measurements</button></div><p id="map-coordinates"></p><h2 id="map-selection-title"></h2><p id="map-selection-detail"></p><pre id="benchmark-results"></pre><script type="module" src="/benchmark.js"></script></body></html>';
const server=http.createServer(async(req,res)=>{
 try{
  const legacy=req.url.startsWith('/legacy/'), route=legacy?req.url.slice('/legacy'.length):req.url;
  if(modules.includes(route.slice(1))){
   res.setHeader('content-type','text/javascript');
   if(legacy){const data=previous.get(route.slice(1));if(!data){res.writeHead(404);return res.end();}return res.end(data);}
   return res.end(await fs.readFile(new URL(route.slice(1),source)));
  }
  if(route==='/benchmark.js'){res.setHeader('content-type','text/javascript');return res.end(await fs.readFile(new URL('map-render-benchmark.js',import.meta.url)));}
  if(route==='/'){res.setHeader('content-type','text/html');return res.end(legacy?html.replace('/benchmark.js','/legacy/benchmark.js'):html);}
  res.writeHead(404);res.end();
 }catch{res.writeHead(500);res.end('Benchmark source unavailable.');}
}).listen(41740,'127.0.0.1',()=>console.log('Open http://127.0.0.1:41740/ for current code'+(baseline?' and /legacy/ for '+baseline:'')+'. No game/Docker access.'));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close();});
