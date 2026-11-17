import {definition} from './definition.js';
import {applicationMetadata} from '../../core/application-services.js';
const presentation=definition.presentation,imagePolicy=definition.services[0].configuration.imagePolicy;
import {contract} from './contract.js';
import path from 'node:path';
import {createFactorio} from './controller.js';
import {automaticMapActor} from './save-map.js';
import {UpdateManager} from './update-manager.js';
import {controllerDiagnostics} from '../../diagnostics.js';
import {web} from './web.js';
import {managed} from './managed.js';
import {storage} from './storage.js';

export const factorio={
  definition,application:applicationMetadata(definition),
  storage,
  presentation,
  contract,
  imagePolicy,
  id:'factorio',name:'Factorio',releaseRepository:'jkenneydaniel/lobby-goblin',stopTimeout:120,
  routes:Object.keys(contract.routes),
  configuration(env){
    const backups=env.BACKUPS_DIR||'/backups';
    return {data:env.FACTORIO_DATA||'/factorio',backups,state:env.STATE_DIR||'/state',container:env.FACTORIO_CONTAINER||'factorio-server',library:path.join(backups,'panel-worlds'),backupDir:path.join(backups,'panel-backups')};
  },
  createController:createFactorio,
  // Startup already reconciles isolated export workers. Automatic exports read a
  // saved copy and publish only validated map data, so they need no manual hold.
  discardOnRestart:job=>job.action==='refresh-map'&&job.actor===automaticMapActor,
  createUpdater:({env,...options})=>new UpdateManager({
    ...options,root:env.UPDATE_STATE_DIR||'/updates',repository:env.RELEASE_REPOSITORY||'jkenneydaniel/lobby-goblin',channel:env.RELEASE_CHANNEL||'preview',
    names:{game:env.FACTORIO_CONTAINER||'factorio-server',controller:env.CONTROLLER_CONTAINER||'factorio-panel-controller',panel:env.PANEL_CONTAINER||'factorio-panel'},
  }),
  diagnostics:controllerDiagnostics,
  managed,
  web,
};
export default factorio;
