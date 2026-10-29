import {assert} from '../../common.js';

// Fixed telemetry only. No user-provided Lua is accepted. Enabling this on a
// world requires explicit acknowledgement that Lua disables achievements.
export const PLAYER_QUERY='/silent-command local list = {}; for _, p in pairs(game.connected_players) do local pos = p.physical_position; local c = p.color; list[#list+1] = {name=p.name,x=pos.x,y=pos.y,surface=p.physical_surface.name,color={c.r,c.g,c.b}}; end; rcon.print("PANEL_LIVE_PLAYERS:"..helpers.table_to_json({players=list,tick=game.tick,seed=game.surfaces.nauvis.map_gen_settings.seed}))';
export function parsePlayers(output){
  const marker='PANEL_LIVE_PLAYERS:',index=output.lastIndexOf(marker);assert(index>=0,'Factorio did not return live positions.');
  const value=JSON.parse(output.slice(index+marker.length).trim());
  if(value.players&&!Array.isArray(value.players)&&Object.keys(value.players).length===0)value.players=[];
  assert(Array.isArray(value.players)&&value.players.length<=1000&&Number.isFinite(value.seed)&&Number.isFinite(value.tick),'Invalid live player response.');
  const players=value.players.map(player=>{
    assert(typeof player.name==='string'&&player.name.length<=200&&typeof player.surface==='string'&&player.surface.length<=200&&Number.isFinite(player.x)&&Number.isFinite(player.y),'Invalid live player coordinates.');
    const color=Array.isArray(player.color)&&player.color.length===3&&player.color.every(Number.isFinite)?player.color:[1,.9,.6];
    const multiplier=color.every(component=>component>=0&&component<=1)?255:1;
    return {name:player.name,surface:player.surface,x:player.x,y:player.y,color:color.map(component=>Math.round(Math.max(0,Math.min(255,component*multiplier))))};
  });
  return {players,seed:value.seed,tick:value.tick};
}
export class LivePlayers {
  constructor({config={enabled:false},scope,query,persist,now=Date.now}){Object.assign(this,{config,scope,query,persist,now});this.cache=null;this.cacheAt=0;this.pending=null;this.generation=0;}
  async validate(params){
    assert(typeof params.enabled==='boolean','Choose whether to enable live player tracking.');
    if(!params.enabled)return null;
    assert(params.confirm===true,'Live tracking requires acknowledging that achievements will be disabled.');
    const scope=await this.scope();assert(scope.running,'Start Factorio before enabling live tracking.',409);
    assert(params.world===scope.world&&params.seed===scope.seed,'The current world changed. Reload the map before enabling tracking.',409);return scope;
  }
  async configure(params,actor){
    const scope=await this.validate(params);
    const config=params.enabled?{enabled:true,world:scope.world,seed:scope.seed,approvedBy:actor,approvedAt:new Date(this.now()).toISOString()}:{...this.config,enabled:false};
    await this.persist(config);this.config=config;this.generation++;this.cache=null;
  }
  get(){
    if(!this.config.enabled)return Promise.resolve({enabled:false,state:'disabled',players:[],updatedAt:null});
    if(this.pending)return this.pending;
    if(this.cache&&this.now()-this.cacheAt<4500)return Promise.resolve(this.cache);
    const generation=this.generation;
    this.pending=this.sample(generation).then(value=>{if(generation===this.generation){this.cache=value;this.cacheAt=this.now();}return value;}).finally(()=>{this.pending=null;});return this.pending;
  }
  async sample(generation){
    const base={enabled:true,world:this.config.world,seed:this.config.seed,players:[],updatedAt:null};
    try{
      const scope=await this.scope();
      if(!scope.running)return {...base,state:'offline'};
      if(scope.world!==this.config.world||scope.seed!==this.config.seed)return {...base,enabled:false,state:'different-world'};
      if(generation!==this.generation||!this.config.enabled)return {enabled:false,state:'disabled',players:[],updatedAt:null};
      let output=await this.query(PLAYER_QUERY);
      if(!output.includes('PANEL_LIVE_PLAYERS:')&&/achievement|repeat.*command/i.test(output)){
        if(generation!==this.generation||!this.config.enabled)return {enabled:false,state:'disabled',players:[],updatedAt:null};
        // Repeat only this fixed, explicitly approved telemetry command.
        output=await this.query(PLAYER_QUERY);
      }
      const result=parsePlayers(output);assert(result.seed===scope.seed,'World changed while reading player positions.');
      if(generation!==this.generation||!this.config.enabled)return {enabled:false,state:'disabled',players:[],updatedAt:null};
      return {...base,...result,state:'live',updatedAt:new Date(this.now()).toISOString()};
    }catch{return {...base,state:'unavailable'};}
  }
}
