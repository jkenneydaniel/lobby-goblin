local stream=assert(io.open(arg[1]));local program=stream:read('*a');stream:close()
for _,mode in ipairs({'replaced','cleared'})do
 local handlers,writes={},{}
 local surface={name='nauvis',map_gen_settings={seed=123},get_chunks=function()local done=false;return function()if not done then done=true;return {x=0,y=0}end end end,get_tile=function()return {name='grass',prototype={map_color={r=1,g=2,b=3}}}end,get_pollution=function()return 0 end,find_entities_filtered=function()return {}end}
 local force={get_spawn_position=function()return{x=0,y=0}end,is_chunk_charted=function()return true end,find_chart_tags=function()return{}end}
 local saved={surfaces={nauvis=surface},forces={player=force},players={},tick=123}
 game=nil;storage={sentinel=7};defines={events={on_tick=1}};log=function()end
 helpers={table_to_json=function(value)return value end,write_file=function(name,value)writes[name]=value end}
 script={mod_name='level',active_mods={base='2.0.77'},on_event=function(event,handler)handlers[event]=handler end,get_event_handler=function(event)return handlers[event]end}
 assert(load(program))()
 if mode=='replaced'then script.on_event(1,function()game.tick=999 end)else script.on_event(1,nil)end
 game=saved
 handlers[1]({name=1,tick=123})
 assert(writes['panel-map.json'].tick==123 and #writes['panel-map.json'].chunks==1,'Export must precede the scenario callback')
 assert(writes['panel-map.complete.json'].jobId=='12345678-1234-1234-1234-123456789abc')
 assert(storage.sentinel==7 and storage.panel_map==nil,'Instrument storage must not replace scenario storage')
 assert(debug.gethook()==nil,'Remove instrumentation immediately after export')
 if mode=='replaced'then assert(game.tick==999)end
end
print('Offline callback replacement, pre-update extraction and scenario-storage fixtures passed')
