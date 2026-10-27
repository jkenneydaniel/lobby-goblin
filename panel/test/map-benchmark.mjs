// Synthetic browser-logic benchmark. No Docker, save files or game access.
import {performance} from 'node:perf_hooks';
import {spatialIndex} from '../applications/factorio/public/map-spatial.js';
const result=[];
for(const count of [80000,160000,320000]){
  const items=Array.from({length:count},(_,i)=>({x:(i%800)*8-3200,y:Math.floor(i/800)*8-1600}));
  let start=performance.now();const index=spatialIndex(items),buildMs=performance.now()-start;
  const bounds=Array.from({length:120},(_,i)=>[-2400+i*16,-1400+i*2,-2000+i*16,-1100+i*2]);
  let scanCount=0,indexCount=0;
  for(const b of bounds)index.query(...b);
  start=performance.now();
  for(const [left,top,right,bottom] of bounds)scanCount+=items.filter(p=>p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom).length;
  const scanMs=performance.now()-start;
  start=performance.now();for(const b of bounds)indexCount+=index.query(...b).length;
  const indexedMs=performance.now()-start;
  if(scanCount!==indexCount)throw Error('Viewport mismatch');
  result.push({objects:count,indexBuildMs:+buildMs.toFixed(2),linearQueriesMs:+scanMs.toFixed(2),indexedQueriesMs:+indexedMs.toFixed(2),queries:bounds.length,averageCandidates:Math.round(indexCount/bounds.length)});
}
console.log(JSON.stringify({scope:'Synthetic viewport queries only; not gameplay, GPU frame timing, or full Factorio export',results:result},null,2));
