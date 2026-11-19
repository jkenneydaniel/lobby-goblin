import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostCpuSampler,hostCpuSample} from '../fleet/host-cpu.js';

test('host CPU uses elapsed counters across all cores and ages the last usable sample', t => {
 t.mock.timers.enable({apis:['setInterval']});
 const core=(user,idle)=>({times:{user,idle}});
 let now=0,cores=[core(50,50),core(50,50)];
 const sampler=createHostCpuSampler({read:()=>cores,now:()=>now});
 t.after(sampler.close);
 assert.equal(sampler.read(),null);
 cores=[core(130,70),core(90,110)];
 now=5000;
 t.mock.timers.tick(5000);
 assert.deepEqual(sampler.read(),{percent:60,ageMs:0});
 cores=[];
 now=40_000;
 t.mock.timers.tick(5000);
 assert.deepEqual(sampler.read(),{percent:60,ageMs:35_000});
 cores=[core(1,1),core(1,1)];
 t.mock.timers.tick(5000);
 assert.deepEqual(sampler.read(),{percent:60,ageMs:35_000});
 cores=[core(1,101),core(1,101)];
 t.mock.timers.tick(5000);
 assert.deepEqual(sampler.read(),{percent:0,ageMs:0});
});

test('remote CPU age is translated to the panel clock and unsupported samples stay unavailable', () => {
 assert.deepEqual(hostCpuSample({percent:0,ageMs:1500},10_000),{percent:0,sampledAt:8500});
 for(const sample of [undefined,{percent:101,ageMs:0},{percent:10,ageMs:-1},{percent:10,ageMs:11_000},{percent:'10',ageMs:0}])
  assert.equal(hostCpuSample(sample,10_000),null);
});
