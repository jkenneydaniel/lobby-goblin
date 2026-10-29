import {mountMap} from './map.js';
const stats=[];let calls=null, cleanup=null;
const originalFrame=globalThis.requestAnimationFrame.bind(globalThis);
globalThis.requestAnimationFrame=callback=>originalFrame(time=>{
 if(callback.name!=='draw')return callback(time);
 const current={fillRect:0,drawImage:0,paths:0},before=performance.now();calls=current;callback(time);calls=null;
 stats.push({...current,ms:performance.now()-before});
});
for(const method of ['fillRect','drawImage','fill']){
 const original=globalThis.CanvasRenderingContext2D.prototype[method];
 globalThis.CanvasRenderingContext2D.prototype[method]=function(...args){if(calls)calls[method==='fill'?'paths':method]++;return original.apply(this,args);};
}
const frame=()=>new Promise(resolve=>originalFrame(()=>originalFrame(resolve)));
globalThis.runMapBench=async(objects,chunks)=>{
 cleanup?.();stats.length=0;
 for(const id of ['world-map','map-plus','map-minus','map-fit','map-base']){const element=globalThis.document.getElementById(id);element.replaceWith(element.cloneNode(true));}
 const columns=chunks===2048?64:128, entityColumns=objects===80000?400:800;
 const snapshot={version:1,step:2,world:'Synthetic.zip',seed:1,surface:'nauvis',chunks:Array.from({length:chunks},(_,i)=>({x:i%columns-columns/2,y:Math.floor(i/columns)-chunks/columns/2,tiles:[1,256],pollution:0})),palette:[{color:[70,100,40]}],entities:Array.from({length:objects},(_,i)=>({name:i%10===0?'assembling-machine-1':'iron-ore',type:i%10===0?'assembling-machine':'resource',category:i%10===0?'buildings':'resources',x:(i%entityColumns)*5-entityColumns*2.5,y:Math.floor(i/entityColumns)*5-objects/entityColumns*2.5,w:1,h:1,color:[70,100,160]})),players:[],tags:[]};
 const json=JSON.stringify(snapshot),parseAt=performance.now();JSON.parse(json);const parseMs=performance.now()-parseAt;
 const start=performance.now();cleanup=mountMap({snapshot,pins:[]});const mountMs=performance.now()-start;await frame();const first=stats.slice();
 stats.length=0;const canvas=globalThis.document.querySelector('canvas');
 for(let i=0;i<15;i++){canvas.dispatchEvent(new globalThis.KeyboardEvent('keydown',{key:i%2?'ArrowLeft':'ArrowRight',bubbles:true}));await frame();}
 const pan=stats.slice(3),median=a=>a.slice().sort((a,b)=>a-b)[Math.floor(a.length/2)];
 stats.length=0;for(let i=0;i<5;i++){cleanup.updatePlayers({enabled:false,state:'disabled',players:[],updatedAt:null});await frame();}
 const idle=stats.slice();
 return {objects,chunks,jsonBytes:new TextEncoder().encode(json).length,parseMs,mountMs,firstFrames:first,panMedianMs:median(pan.map(v=>v.ms)),panMedianFillRects:median(pan.map(v=>v.fillRect)),panMedianImages:median(pan.map(v=>v.drawImage)),unchangedPlayerDraws:idle.length,unchangedPlayerDrawCalls:idle.reduce((n,v)=>n+v.fillRect+v.drawImage+v.paths,0)};
};
globalThis.mapBenchmarkReady=true;

globalThis.document.querySelector('#benchmark-run')?.addEventListener('click', async () => {
 const output=globalThis.document.querySelector('#benchmark-results');
 output.textContent='Measuring synthetic browser work…';
 const runs=[];for(const [objects,chunks] of [[80000,2048],[320000,8192]])for(let pass=0;pass<3;pass++)runs.push({...await globalThis.runMapBench(objects,chunks),pass});
 output.textContent=JSON.stringify(runs,null,2);
});
