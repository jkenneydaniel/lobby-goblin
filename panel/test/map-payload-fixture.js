// Deterministic synthetic data only. No engine, worlds or deployment paths.
export function mapPayloadFixture(count=160000,chunkCount=4096){
 const types=[['iron-ore','resource','resources',1,1],['copper-ore','resource','resources',1,1],['assembling-machine-2','assembling-machine','buildings',3,3],['straight-rail','straight-rail','railways',2,4],['biter-spawner','unit-spawner','enemies',7,7],['small-biter','unit','enemies',1,1]];
 return {version:1,step:2,surface:'nauvis',seed:12345,world:'Synthetic-only.zip',tick:123,created:'2026-10-30T00:00:00Z',enemyUnits:true,
 chunks:Array.from({length:chunkCount},(_,i)=>({x:i%64-32,y:Math.floor(i/64)-16,tiles:[1,256],pollution:i%13})),palette:[{name:'grass-1',color:[40,60,30]}],players:[],tags:[],
 entities:Array.from({length:count},(_,i)=>{const [name,type,category,w,h]=types[i%types.length],entity={name,type,x:i%512-256+(i%7)/256,y:Math.floor(i/512)-80+(i%13)/256,w,h,category,power:false,color:[60+i%6,90+i%6,30]};if(category==='resources')entity.amount=(i*7919)%100000;if(type==='assembling-machine')entity.recipe=['iron-gear-wheel','electronic-circuit','advanced-circuit'][i%3];return entity;})};
}
