-- Run the production exporter against deterministic explored/capped fixtures.
local init,batch=arg[1],arg[2]
local function source(file)
  local stream=assert(io.open(file));local text=stream:read('*a');stream:close();return text
end
local init_source,batch_source=source(init),source(batch)
local objects={}
local force={is_chunk_charted=function(_,c) return c.x~=2 end,get_spawn_position=function() return {x=0,y=0} end,find_chart_tags=function() return {} end}
local surface={name='nauvis',map_gen_settings={seed=123},get_pollution=function() return 0 end,
  get_tile=function() return {name='grass',prototype={map_color={r=50,g=70,b=30}}} end,
  find_entities_filtered=function() return objects end,
  get_chunks=function() local i=-1;return function() i=i+1;if i<3 then return {x=i,y=0} end end end}
game={surfaces={nauvis=surface},forces={player=force},players={},tick=123}
rcon={print=function() end}
local function reset()
  storage={};assert(load(init_source))();objects={}
  assert(#storage.panel_map.queue==2,'Unexplored chunks must not be exported')
  assert(storage.panel_map.output.enemyUnits==true)
end
local function entity(name,kind,force,x)
  return {name=name,type=kind,force={name=force},position={x=x or 8,y=8},bounding_box={left_top={x=7,y=7},right_bottom={x=9,y=9}},prototype={map_color={r=200,g=40,b=30}}}
end
local function run(start)
  assert(load((batch_source:gsub('MAP_START',tostring(start or 1)))))()
  assert(#storage.panel_map.output.entities<=160000)
  return storage.panel_map.output
end
local function count(m,kind)
  local n=0;for _,e in ipairs(m.entities) do if e.type==kind and e.category=='enemies' then n=n+1 end end;return n
end
local function fill(category,kind,slots)
  local state=storage.panel_map
  for i=1,160000 do
    state.output.entities[i]={category=category,type=kind}
    if slots then state[slots][i]=i end
  end
end
reset()
objects={entity('biter-spawner','unit-spawner','enemy'),entity('spitter-spawner','unit-spawner','enemy',16),
  entity('small-worm-turret','turret','enemy',24),entity('small-biter','unit','enemy',6),entity('small-spitter','unit','enemy',12),
  entity('neutral-unit','unit','neutral',10),entity('unexplored-base','unit-spawner','enemy',70)}
local m=run()
assert(count(m,'unit-spawner')==2 and count(m,'turret')==1 and count(m,'unit')==2,'Include bases, worms and mobile enemies only in explored chunks')
assert(#m.entities==5,'Do not include neutral units or unexplored enemies')
run();assert(#m.entities==5,'Overlapping batches must not duplicate enemies')

reset();fill('resources','resource','resource_slots')
objects={entity('small-biter','unit','enemy'),entity('biter-spawner','unit-spawner','enemy',16),entity('small-worm-turret','turret','enemy',24)}
m=run();assert(count(m,'unit-spawner')==1 and count(m,'turret')==1 and count(m,'unit')==1,'Resources must not crowd out enemies')
assert(m.entitiesLimited and #m.entities==160000)

reset();fill('buildings','furnace','object_slots')
objects={entity('small-biter','unit','enemy'),entity('biter-spawner','unit-spawner','enemy',16)}
m=run();assert(count(m,'unit-spawner')==1 and count(m,'unit')==1,'Protect enemies when buildings fill the cap')

reset();fill('enemies','unit','unit_slots')
objects={entity('biter-spawner','unit-spawner','enemy'),entity('small-worm-turret','turret','enemy',16)}
m=run();assert(count(m,'unit-spawner')==1 and count(m,'turret')==1 and count(m,'unit')==159998,'Bases and worms take priority over unit swarms')

reset();fill('enemies','unit-spawner')
objects={entity('small-biter','unit','enemy'),entity('extra-base','unit-spawner','enemy',16)}
m=run();assert(#m.entities==160000 and m.entitiesLimited and count(m,'unit')==0,'Keep the hard cap and its warning when only bases remain')

reset();objects={entity('boundary-base','unit-spawner','enemy',31)}
m=run();assert(#m.entities==1,'A base crossing a chunk boundary is exported once')
print('Enemy export fixtures passed: classification, explored bounds, deduplication, cap priority and hard limit')
