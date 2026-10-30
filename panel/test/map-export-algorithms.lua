local function source(file)local stream=assert(io.open(file));local text=stream:read('*a');stream:close();return text end
local init,batch=source(arg[1]),source(arg[2])
local origin={x=81.5,y=-33}
local surface={name='nauvis',map_gen_settings={seed=123}}
local force={get_spawn_position=function()return origin end,find_chart_tags=function()return {} end,is_chunk_charted=function(_,c)return c.x%5~=0 end}
game={surfaces={nauvis=surface},forces={player=force},players={},tick=123};rcon={print=function()end}
local function distance(c)return (c.x*32-origin.x)^2+(c.y*32-origin.y)^2 end
local function before(a,b)local da,db=distance(a),distance(b);return da<db or da==db and(a.x<b.x or a.x==b.x and a.y<b.y)end
local function initialize(count)
 storage={};local expected={}
 surface.get_chunks=function()local i=0;return function()if i>=count then return nil end;local p=(i*4051+17)%count;i=i+1;return {x=p%256-128,y=math.floor(p/256)-64}end end
 if count>0 then for c in surface.get_chunks()do if force.is_chunk_charted(surface,c)then expected[#expected+1]=c end end end
 table.sort(expected,before);assert(load(init))();local state=storage.panel_map
 assert(state.output.totalChunks==#expected and #state.queue==math.min(4096,#expected))
 assert(state.output.limited==(#expected>4096))
 for i,c in ipairs(state.queue)do assert(c.x==expected[i].x and c.y==expected[i].y);assert(c.distance==nil)end
 return state
end
initialize(32768);initialize(256);initialize(0)
local state=initialize(1);state.queue={{x=0,y=0}}
surface.get_tile=function()return {name='grass',prototype={map_color={r=50,g=70,b=30}}}end
surface.get_pollution=function()return 0 end
local objects={};surface.find_entities_filtered=function()return objects end
for i=1,160000 do state.output.entities[i]={category='resources'};state.resource_slots[i]=i end
for i=1,2000 do objects[i]={name='declined-ore',type='resource',force={name='neutral'},position={x=i/2001*31,y=8}}end
assert(load((batch:gsub('MAP_START','1'))))()
assert(#state.output.entities==160000 and state.output.entitiesLimited and next(state.seen)==nil,'Declined objects must not grow the deduplication table')
state=initialize(1);state.queue={{x=0,y=0}};local reads=0
local prototype=setmetatable({},{__index=function(_,key)if key=='map_color'then reads=reads+1;return {r=1,g=2,b=3}end end})
local function building(x,w,h,recipe)return {name='synthetic-building',type='assembling-machine',force={name='player'},position={x=x,y=8},bounding_box={left_top={x=0,y=0},right_bottom={x=w,y=h}},prototype=prototype,get_recipe=function()return {name=recipe}end}end
objects={building(8,3,5,'first-recipe'),building(16,5,3,'second-recipe')}
assert(load((batch:gsub('MAP_START','1'))))()
assert(reads==1,'Repeated prototypes should share color lookup work')
assert(state.output.entities[1].w==3 and state.output.entities[2].w==5 and state.output.entities[1].h==5 and state.output.entities[2].h==3,'Bounds remain per entity')
assert(state.output.entities[1].recipe=='first-recipe' and state.output.entities[2].recipe=='second-recipe','Recipes remain per entity')
print('Bounded chunk selection, declined-object bookkeeping and prototype metadata fixtures passed')
