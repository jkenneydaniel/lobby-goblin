import {runtimeImageDefinition,testRuntimeImage} from '../build.mjs';
await testRuntimeImage(await runtimeImageDefinition());
