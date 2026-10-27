// Synthetic browser-logic benchmark. No Docker, save files or game access.
import {performance} from 'node:perf_hooks';
import {spatialIndex} from '../applications/factorio/public/map-spatial.js';
const result=[];
for(const count of [80000,160000,320000]){
  const items=Array.from({length:count},(_,i)=>({x:(i%800)*8-3200,y:Math.floor(i/800)*8-1600}));
  let start=performance.now();const index=spatialIndex(items),buildMs=performance.now()-start;
  const bounds=Array.from({length:120},(_,i)=>[-2400+i*16,-1400+i*2,-2000+i*16,-1100+i*2]);
  const scan=([left,top,right,bottom])=>items.filter(p=>p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom),indexed=b=>index.query(...b);
  const measure=fn=>{let found=0;const at=performance.now();for(const b of bounds)found+=fn(b).length;return {ms:performance.now()-at,found};};
  // Equal warm-up and alternating measured order reduce JIT/order bias. Report
  // a median rather than the most flattering pass; verify every result count.
  for(let i=0;i<3;i++){measure(scan);measure(indexed);}
  const timings={scan:[],indexed:[]};let candidates=0;
  for(let i=0;i<7;i++){
    let a,b;if(i%2){b=measure(indexed);a=measure(scan);}else{a=measure(scan);b=measure(indexed);}
    if(a.found!==b.found)throw Error('Viewport mismatch');
    timings.scan.push(a.ms);timings.indexed.push(b.ms);candidates=b.found;
  }
  const median=values=>+values.sort((a,b)=>a-b)[Math.floor(values.length/2)].toFixed(2);
  result.push({objects:count,indexBuildMs:+buildMs.toFixed(2),linearQueriesMedianMs:median(timings.scan),indexedQueriesMedianMs:median(timings.indexed),warmupsPerPath:3,measuredPassesPerPath:7,queriesPerPass:bounds.length,averageCandidates:Math.round(candidates/bounds.length)});
}
console.log(JSON.stringify({scope:'Synthetic viewport queries only; not gameplay, GPU frame timing, or full Factorio export',results:result},null,2));
