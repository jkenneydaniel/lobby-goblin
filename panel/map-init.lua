local s=game.surfaces.nauvis
local f=game.forces.player
local origin=f.get_spawn_position(s)
local chunks={}
local total=0
local function farther(a,b)
  return a.distance>b.distance or a.distance==b.distance and (a.x>b.x or a.x==b.x and a.y>b.y)
end
for c in s.get_chunks() do
  if f.is_chunk_charted(s,c) then
    total=total+1
    local item={x=c.x,y=c.y,distance=(c.x*32-origin.x)^2+(c.y*32-origin.y)^2}
    if #chunks<4096 then
      chunks[#chunks+1]=item
      local i=#chunks
      while i>1 do
        local parent=math.floor(i/2)
        if not farther(chunks[i],chunks[parent]) then break end
        chunks[i],chunks[parent]=chunks[parent],chunks[i]
        i=parent
      end
    elseif farther(chunks[1],item) then
      chunks[1]=item
      local i=1
      while i*2<=#chunks do
        local child=i*2
        if child<#chunks and farther(chunks[child+1],chunks[child]) then child=child+1 end
        if not farther(chunks[child],chunks[i]) then break end
        chunks[i],chunks[child]=chunks[child],chunks[i]
        i=child
      end
    end
  end
end
table.sort(chunks,function(a,b) return farther(b,a) end)
for _,c in ipairs(chunks) do c.distance=nil end
storage.panel_map={queue=chunks,palette_lookup={},prototype_lookup={},seen={},resource_slots={},object_slots={},unit_slots={},output={version=1,surface=s.name,seed=s.map_gen_settings.seed,tick=game.tick,step=2,totalChunks=total,limited=total>#chunks,enemyUnits=true,chunks={},palette={},entities={},players={},tags={}}}
local m=storage.panel_map.output
for _,p in pairs(game.players) do
  if p.surface==s and f.is_chunk_charted(s,{math.floor(p.position.x/32),math.floor(p.position.y/32)}) then m.players[#m.players+1]={name=p.name,x=p.position.x,y=p.position.y} end
end
for _,tag in pairs(f.find_chart_tags(s)) do
  if f.is_chunk_charted(s,{math.floor(tag.position.x/32),math.floor(tag.position.y/32)}) then m.tags[#m.tags+1]={label=tag.text,x=tag.position.x,y=tag.position.y} end
end
rcon.print('MAP_CHUNKS='..#chunks)
