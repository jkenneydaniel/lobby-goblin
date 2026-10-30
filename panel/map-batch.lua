local state=storage.panel_map
local m=state.output
local s=game.surfaces.nauvis
local function rgb(c)
  return {math.floor(c.r or 76),math.floor(c.g or 102),math.floor(c.b or 76)}
end
for index=MAP_START,math.min(MAP_START+15,#state.queue) do
  local c=state.queue[index]
  local chunk={x=c.x,y=c.y,tiles={},pollution=s.get_pollution({c.x*32+16,c.y*32+16})}
  for y=0,30,2 do for x=0,30,2 do
    local tile=s.get_tile(c.x*32+x,c.y*32+y)
    local id=state.palette_lookup[tile.name]
    if not id then id=#m.palette+1;state.palette_lookup[tile.name]=id;m.palette[id]={name=tile.name,color=rgb(tile.prototype.map_color)} end
    local runs=chunk.tiles
    if #runs>0 and runs[#runs-1]==id then runs[#runs]=runs[#runs]+1 else runs[#runs+1]=id;runs[#runs+1]=1 end
  end end
  m.chunks[#m.chunks+1]=chunk
  for _,e in pairs(s.find_entities_filtered{area={{c.x*32,c.y*32},{c.x*32+32,c.y*32+32}}}) do
    local kind=e.type
    local force=e.force.name
    local category=nil
    if kind=='resource' then category='resources'
    elseif string.find(kind,'rail') and force=='player' then category='railways'
    elseif force=='enemy' and (kind=='unit-spawner' or kind=='turret' or kind=='unit') then category='enemies'
    elseif force=='player' and kind~='character' and kind~='entity-ghost' and kind~='tile-ghost' then category='buildings' end
    local position=e.position
    local key=category and e.name..':'..position.x..':'..position.y
    if category and not state.seen[key] and position.x>=c.x*32 and position.x<c.x*32+32 and position.y>=c.y*32 and position.y<c.y*32+32 then
      local slot=#m.entities+1
      if slot>160000 then
        m.entitiesLimited=true
        if category=='enemies' then
          slot=table.remove(state.resource_slots) or table.remove(state.object_slots)
          if not slot and kind~='unit' then slot=table.remove(state.unit_slots) end
        end
      end
      if slot and slot<=160000 then
        state.seen[key]=true
        local b=e.bounding_box
        local color=state.prototype_lookup[e.name]
        if not color then color=rgb(e.prototype.map_color or e.prototype.friendly_map_color);state.prototype_lookup[e.name]=color end
        local power=kind=='electric-pole' or kind=='generator' or kind=='solar-panel' or kind=='accumulator' or kind=='power-switch'
        local item={name=e.name,type=kind,x=position.x,y=position.y,w=math.min(128,b.right_bottom.x-b.left_top.x),h=math.min(128,b.right_bottom.y-b.left_top.y),category=category,power=power,color=color}
        if category=='resources' then item.amount=e.amount end
        if kind=='assembling-machine' or kind=='furnace' then local ok,recipe=pcall(function() return e.get_recipe() end);if ok and recipe then item.recipe=recipe.name end end
        m.entities[slot]=item
        if category=='resources' then state.resource_slots[#state.resource_slots+1]=slot
        elseif category~='enemies' then state.object_slots[#state.object_slots+1]=slot
        elseif kind=='unit' then state.unit_slots[#state.unit_slots+1]=slot end
      end
    end
  end
end
rcon.print('MAP_BATCH_OK')
