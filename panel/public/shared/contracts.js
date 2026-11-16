// Type-only contracts expressed as JSDoc keep both historical source bundles and
// existing updater allowlists compatible. There are no browser runtime imports.
/** @typedef {{username:string,role:'admin'|'viewer'|'member',csrf:string,permissions?:string[],allowedActions?:string[],onboarding?:{completed:boolean}}} Session */
/**
 * @typedef {{
 * (route:'/session'):Promise<Session>;
 * (route:'/login'|'/register'|'/password',options:{method:'POST',body:Record<string,unknown>}):Promise<Session>;
 * (route:'/logout',options:{method:'POST',body:Record<string,unknown>}):Promise<{ok:boolean}>;
 * }} SessionRequest
 */
/**
 * @typedef {{
 * readonly current:Session|null;
 * set(value:Session|null):Session|null;
 * bootstrap(options?:{invitation?:boolean}):Promise<Session|null>;
 * signIn(body:Record<string,unknown>):Promise<Session>;
 * register(body:Record<string,unknown>):Promise<Session>;
 * changePassword(body:Record<string,unknown>):Promise<Session>;
 * signOut():Promise<void>;
 * }} SessionController
 */
/** @typedef {{id:'inspect'|'acknowledge'|'open',label:string,href?:string}} RecoveryControl */
/**
 * @typedef {{id:string,source?:string,sourceId?:string,action:string,state:'queued'|'running'|'succeeded'|'failed'|'interrupted',message:string,result?:unknown,recovery?:{required:boolean,checkedAt?:string,retryable?:boolean,actions?:RecoveryControl[]}}} OperationJob
 */
/** @typedef {{jobs:OperationJob[],active:OperationJob|null,recoveryRequired?:boolean,workflow?:{operations:OperationJob[],sources:{id:string,available:boolean}[]}}} OperationSnapshot */
/**
 * @typedef {{
 * (route:`/jobs?progress=1${string}`,options?:{method?:'GET'}):Promise<OperationSnapshot>;
 * (route:'/jobs',options:{method:'POST',body:{action:string,params:Record<string,unknown>}}):Promise<OperationJob>;
 * (route:'/operations/recovery',options:{method:'POST',body:{source:string,id:string,operation:string,confirm:true}}):Promise<OperationJob>;
 * (route:'/jobs/recovery',options:{method:'POST',body:{id:string,operation:string,confirm:true}}):Promise<OperationJob>;
 * }} OperationRequest
 */
/**
 * @typedef {{
 * readonly active:OperationJob|null;
 * readonly jobs:OperationJob[];
 * readonly recoveryRequired:boolean;
 * readonly workflowUnavailable:boolean;
 * readonly sending:boolean;
 * readonly busy:boolean;
 * reset():void;
 * update(value:OperationSnapshot):Promise<OperationSnapshot>;
 * refresh():Promise<OperationSnapshot>;
 * start(action:string,params?:Record<string,unknown>,options?:{wait?:boolean,onAccepted?:(job:OperationJob)=>void|Promise<void>}):Promise<OperationJob>;
 * }} OperationController
 */
/**
 * @typedef {{
 * request:OperationRequest;
 * shell:{operation(job:OperationJob|null):void,recovery(jobs:OperationJob[],onAction:(job:OperationJob,operation:string)=>Promise<void>,options:{admin:boolean}):void};
 * isAdmin():boolean;
 * includeWorkflows?:boolean;
 * onChange?:(controller:OperationController)=>void;
 * onSettled?:(job:OperationJob)=>void|Promise<void>;
 * onRecovery?:()=>void|Promise<void>;
 * notify?:(message:string,error?:boolean)=>void;
 * pollMs?:number;
 * }} OperationControllerOptions
 */
export {};
/** @typedef {(route:string,options?:{method?:string,body?:unknown,raw?:boolean,signal?:AbortSignal})=>Promise<unknown>} ScreenRequest */
/**
 * @typedef {{root:HTMLElement,signal:AbortSignal,isCurrent():boolean,request:ScreenRequest,
 * confirm(title:string,message:string,label?:string):Promise<boolean>,render(html:string|Node):void,
 * on(target:EventTarget,type:string,listener:(event:Event)=>void|Promise<void>):void,onDispose(dispose:()=>void):void}} ScreenContext
 */
/** @typedef {{mount(context:ScreenContext,options:Record<string,unknown>):void|Promise<void>,refresh?:(context:ScreenContext,options:Record<string,unknown>)=>void|Promise<void>,beforeLeave?:()=>boolean|void|Promise<boolean|void>,dispose?:()=>void}} Screen */
/** @typedef {{factories:Record<string,()=>Screen>,root(id:string):HTMLElement,request:ScreenRequest,prepare?:(context:ScreenContext,options:Record<string,unknown>)=>void|Promise<void>,confirm?:(title:string,message:string,label?:string)=>Promise<boolean>,onChange?:(id:string)=>void,onError?:(error:Error,phase:'event'|'load')=>void}} ScreenRouterOptions */
