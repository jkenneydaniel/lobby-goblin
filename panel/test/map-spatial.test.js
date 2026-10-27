import test from 'node:test';
import assert from 'node:assert/strict';
import {spatialIndex} from '../applications/factorio/public/map-spatial.js';

test('viewport queries and hit-test neighborhoods match a scan in export order, including negative coordinates',()=>{
  const items=Array.from({length:160000},(_,i)=>({x:((i*137)%4000)-2000,y:Math.floor(i/400)-200,id:i})),index=spatialIndex(items);
  for(const [left,top,right,bottom] of [[-80,-90,90,100],[-129,-129,-128,-128],[-1e9,-1e9,1e9,1e9],[1900,150,2000,200],[3000,3000,4000,4000]])
    assert.deepEqual(index.query(left,top,right,bottom),items.filter(p=>p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom));
  const nearby=index.query(-40,-40,40,40);
  assert.ok(nearby.length<items.length/100,'A zoomed viewport must not submit the entire object list to painting/hit testing.');
  assert.equal(index.query(-1e9,-1e9,1e9,1e9)[12],items[12],'Objects retain identity.');
});
test('chunk projection, empty maps and sparse overviews stay bounded',()=>{
  const chunks=[{x:-1,y:-1},{x:0,y:0},{x:10000000,y:10000000}],index=spatialIndex(chunks,32,c=>({x:c.x*32,y:c.y*32}));
  assert.deepEqual(index.query(-32,-32,0,0),chunks.slice(0,2));
  assert.deepEqual(index.query(-1e12,-1e12,1e12,1e12),chunks);
  assert.deepEqual(spatialIndex([]).query(0,0,100,100),[]);
});
