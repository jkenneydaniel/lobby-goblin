import {canonicalRepository} from './branding.js';
// Public release metadata only. This service never downloads/executes updates.
export function version(value){
  const match=String(value).match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/);
  if(!match)return null;
  const core=match.slice(1,4).map(Number),pre=match[4]?.split('.')||[];
  if(core.some(n=>!Number.isSafeInteger(n))||pre.some(s=>/^\d+$/.test(s)&&(s.length>1&&s[0]==='0'||!Number.isSafeInteger(Number(s)))))return null;
  return {core,pre};
}
export function compareVersions(left,right){
  const a=version(left),b=version(right);if(!a||!b)throw new Error('Invalid version.');
  for(let i=0;i<3;i++)if(a.core[i]!==b.core[i])return Math.sign(a.core[i]-b.core[i]);
  if(!a.pre.length||!b.pre.length)return a.pre.length?-1:b.pre.length?1:0;
  for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){
    if(a.pre[i]===undefined)return -1;if(b.pre[i]===undefined)return 1;
    const x=a.pre[i],y=b.pre[i];if(x===y)continue;
    const nx=/^\d+$/.test(x),ny=/^\d+$/.test(y);
    return nx&&ny?Math.sign(Number(x)-Number(y)):nx!==ny?nx?-1:1:x<y?-1:1;
  }
  return 0;
}
export function selectRelease(releases,channel){
  return releases.filter(r=>!r.draft&&r.published_at&&version(r.tag_name)&&(channel==='preview'||!r.prerelease&&!version(r.tag_name).pre.length))
    .sort((a,b)=>compareVersions(b.tag_name,a.tag_name))[0]||null;
}
export class ReleaseChecks{
  constructor({repository='jkenneydaniel/lobby-goblin',current,channel='preview',enabled=true,fetcher=fetch,now=Date.now,interval=6*3600000}={}){
    repository=canonicalRepository(repository);
    Object.assign(this,{repository,current,channel,enabled,fetcher,now,interval});
    this.generation=0;this.checked=0;this.pending=null;this.etag=null;this.releases=[];
    this.result={state:enabled?'unchecked':'disabled',current,channel,repository,available:false,installation:'manual',checkedAt:null};
  }
  configure({enabled,channel}){
    if(enabled===this.enabled&&channel===this.channel)return;
    this.generation++;this.enabled=enabled;this.channel=channel;this.checked=0;this.pending=null;this.etag=null;this.releases=[];
    this.result={state:enabled?'unchecked':'disabled',current:this.current,channel,repository:this.repository,available:false,installation:'manual',checkedAt:null};
  }
  async check({force=false}={}){
    if(!this.enabled)return this.result;
    if(this.pending)return this.pending;
    if(this.checked&&this.now()-this.checked<(force?Math.min(this.interval,60000):this.interval))return this.result;
    const pending=this.run();this.pending=pending;try{return await pending;}finally{if(this.pending===pending)this.pending=null;}
  }
  async run(){
    const generation=this.generation,channel=this.channel;this.checked=this.now();
    try{
      if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(this.repository)||!version(this.current)||!['stable','preview'].includes(this.channel))throw new Error('Invalid release-check configuration.');
      const headers={accept:'application/vnd.github+json','user-agent':'Lobby Goblin-release-check','x-github-api-version':'2022-11-28'};
      if(this.etag)headers['if-none-match']=this.etag;
      const response=await this.fetcher(`https://api.github.com/repos/${this.repository}/releases?per_page=100`,{headers,redirect:'error',signal:AbortSignal.timeout(8000)});
      if(response.status!==304){
        if(response.status===404)throw new Error('Release repository is unavailable or not public.');
        if(response.status===403||response.status===429)throw new Error('GitHub rate limit or access restriction. Checks will retry later.');
        if(!response.ok)throw new Error('GitHub release check is temporarily unavailable.');
        let size=0;const chunks=[];
        for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)throw new Error('Release response exceeds the size limit.');chunks.push(chunk);}
        const releases=JSON.parse(Buffer.concat(chunks).toString());
        if(!Array.isArray(releases)||releases.length>100)throw new Error('Invalid release response.');
        if(generation!==this.generation)return this.result;
        this.releases=releases.filter(r=>r&&typeof r==='object');this.etag=response.headers.get('etag');
      }
      if(generation!==this.generation)return this.result;
      const latest=selectRelease(this.releases,channel),available=!!latest&&compareVersions(latest.tag_name,this.current)>0;
      this.result={...this.result,state:latest?available?'available':'current':'no-releases',available,latest:latest?{tag:latest.tag_name,published:latest.published_at,notes:typeof latest.body==='string'?latest.body.slice(0,16000):'',url:`https://github.com/${this.repository}/releases/tag/${encodeURIComponent(latest.tag_name)}`} :null,error:null};
    }catch(error){if(generation!==this.generation)return this.result;this.result={...this.result,state:'unavailable',available:false,latest:null,error:['Invalid release-check configuration.','Release repository is unavailable or not public.','GitHub rate limit or access restriction. Checks will retry later.','Release response exceeds the size limit.','Invalid release response.'].includes(error.message)?error.message:'Cannot reach GitHub. The server can keep running; release checks will retry later.'};}
    this.result.checkedAt=new Date(this.checked).toISOString();return this.result;
  }
}
