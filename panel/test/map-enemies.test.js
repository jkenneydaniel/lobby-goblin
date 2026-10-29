import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mountMap} from '../applications/factorio/public/map.js';

const lua=spawnSync('lua',['-v'],{encoding:'utf8'});
test('Lua exports enemies in explored areas and preserves bases at the object cap',{skip:lua.error?'Lua interpreter unavailable; covered by isolated Factorio acceptance':false},()=>{
  const paths=['./map-enemies.lua','../map-init.lua','../map-batch.lua'].map(name=>fileURLToPath(new URL(name,import.meta.url)));
  const result=spawnSync('lua',paths,{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('enemy markers stay visible above other layers at overview zoom and respect the layer toggle',t=>{
  const draws=[],frames=[],elements=new Map(),context={setTransform(){},drawImage(){},fillRect(){draws.push({shape:'rectangle',color:this.fillStyle});},beginPath(){this.shape='path';},moveTo(x,y){this.origin=[x,y];},lineTo(){},closePath(){this.shape='diamond';},arc(x,y,radius){this.shape='circle';this.radius=radius;},fill(){draws.push({shape:this.shape,radius:this.radius,color:this.fillStyle});},stroke(){},fillText(){}};
  function element(){return {textContent:'',handlers:{},addEventListener(type,fn){this.handlers[type]=fn;}};}
  for(const id of ['world-map','map-fit','map-base','map-plus','map-minus','map-coordinates','map-selection-title','map-selection-detail'])elements.set('#'+id,element());
  const canvas=elements.get('#world-map');Object.assign(canvas,{setPointerCapture(){},getContext:()=>context,getBoundingClientRect:()=>({left:0,top:0,width:800,height:600})});
  const layer=element();Object.assign(layer,{dataset:{mapLayer:'enemies'},checked:true});
  const globals={document:{createElement:()=>({width:300,height:150,getContext:()=>context}),querySelector:selector=>elements.get(selector)||null,querySelectorAll:()=>[layer]},devicePixelRatio:1,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){}};
  for(const [key,value] of Object.entries(globals)){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);}
  const entity=(name,type,category,x=0)=>({name,type,category,x,y:0,w:2,h:2,color:[100,100,20]});
  const payload={snapshot:{chunks:[],entities:[entity('ore-under-base','resource','resources'),entity('biter-spawner','unit-spawner','enemies'),entity('worm','turret','enemies',500),entity('biter','unit','enemies',1000),entity('ore-painted-last','resource','resources')],players:[],tags:[]},pins:[]};
  const cleanup=mountMap(payload,{cx:0,cy:0,scale:.02,layers:['enemies','resources']});t.after(cleanup);frames.shift()();
  assert.deepEqual(draws.filter(d=>d.color==='#e75e51').map(({shape})=>shape),['diamond','circle','circle']);
  assert.deepEqual(draws.filter(d=>d.color==='#e75e51').map(({radius})=>radius).slice(1),[3,1.5]);
  assert.equal(draws.at(-1).color,'#e75e51','Enemies must be painted after the resource layer even if they appear first in the export.');
  canvas.handlers.pointerdown({pointerId:1,clientX:400,clientY:300});
  canvas.handlers.pointerup({pointerId:1,clientX:400,clientY:300});
  assert.match(elements.get('#map-selection-detail').textContent,/Enemy base · Saved position/);
  draws.length=0;layer.checked=false;layer.handlers.change();frames.shift()();
  assert.equal(draws.some(d=>d.color==='#e75e51'),false,'Disabled enemy layer must not draw markers.');
});
