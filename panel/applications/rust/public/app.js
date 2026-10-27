import {mountApplication} from './application/host.js';
import {rustMods} from './rust/mods-capability.js';

import {rustSoftware} from './rust/software-capability.js';

await mountApplication({
  extensions: {'rust.mods': rustMods, 'rust.software': rustSoftware},
});
