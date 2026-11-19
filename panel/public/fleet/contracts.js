/** @typedef {import('../shared/contracts.js').Session} Session */
/** @typedef {import('../shared/contracts.js').OperationJob} OperationJob */
/** @typedef {{id:string,name:string,local:boolean,connected:boolean,aligned?:boolean,error?:string,lastSeenAt?:number|null,cpuSample?:{percent:number,sampledAt:number}|null}} FleetHost */
/** @typedef {{id:string,state:string,applicationName?:string,applicationKind?:string,webProtocol?:string,hostId?:string,hostName?:string,manageUrl?:string,unavailable?:boolean}} FleetServer */
/** @typedef {{id:string,hostId?:string,hostName?:string,unavailable?:boolean}} FleetSnapshotRecord */
/** @typedef {OperationJob & {hostId:string,hostName:string}} FleetJob */
/** @typedef {{ready?:boolean,running?:boolean,state?:string,players?:string[]|number|null,cpu?:number|null,memory?:number|null}} FleetServerStatus */
/** @typedef {{id:string,snapshotHelp?:string}} FleetGame */
/** @typedef {{hosts:FleetHost[],hostClockOffset:number,servers:FleetServer[],snapshots:FleetSnapshotRecord[],jobs:FleetJob[],live:Map<string,FleetServerStatus>,hostJobs:Map<string,OperationJob|undefined>,active:OperationJob|null|undefined,games:FleetGame[],assigned:boolean,workflowUnavailable?:boolean}} FleetSnapshot */
/** @typedef {{request:import('../shared/contracts.js').ScreenRequest,getSession():Session|null,includeWorkflows?:boolean,onChange?:(snapshot:FleetSnapshot)=>void,onSettled?:(job:FleetJob)=>void,fetchStatus?:(url:string,signal:AbortSignal)=>Promise<FleetServerStatus|null>}} FleetModelOptions */
export {};
