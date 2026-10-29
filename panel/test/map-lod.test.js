import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewIndex} from '../applications/factorio/public/map-lod.js';
const resource=(x,y)=>({category:'resources',type:'resource',name:'iron-ore',x,y,w:1,h:1,color:[70,100,160]});
test('overview work depends on occupied visual cells while detailed views retain the exact objects',()=>{
 const items=Array.from({length:320000},(_,i)=>resource(i%800,Math.floor(i/800))),index=overviewIndex(items);
 const low=index.query(-1000,-1000,1000,1000,.1);assert.ok(low.length<items.length/100);assert.equal(low.reduce((n,p)=>n+p.count,0),items.length);
 assert.deepEqual(index.query(-10,-10,10,10,2),items.filter(p=>p.x<=10&&p.y<=10));
 for(const scale of [.4,.05,.02,.1])assert.ok(index.query(-1000,-1000,1000,1000,scale).length<items.length);
});
test('negative cells, layer colors, power, rails, enemies and oversized objects retain their meaning',()=>{
 const items=[resource(-1,-1),resource(-2,-2),{...resource(-1,-1),color:[1,2,3]},{...resource(-1,-1),category:'buildings',power:true},{...resource(-1,-1),category:'enemies',type:'unit-spawner'},{...resource(-1,-1),category:'railways'},{...resource(-1,-1),category:'buildings',w:1600}];
 const marks=overviewIndex(items).query(-2000,-2000,2000,2000,.1);
 assert.equal(marks.length,6);assert.equal(marks[0].count,2);
 assert.ok(marks.includes(items[4]));assert.ok(marks.includes(items[5]));assert.ok(marks.includes(items[6]));
 assert.notEqual(marks[0],items[0],'Raw objects are not mutated or substituted for inspection.');assert.equal(items[0].count,undefined);
});
