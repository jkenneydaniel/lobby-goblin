import {runtimeImagePolicy} from '../applications/factorio/runtime.js';
import {imagePolicies,runtimeImagePolicies} from '../applications/image-policies.js';
import {imageMatch} from './image-policy.js';
// Only first-party images are used for new installations. Historical references
// are recognized here solely to perform the one-way 0.3.4 migration.
export const ownedImages=Object.freeze(Object.fromEntries(Object.entries(imagePolicies).map(([id,policy])=>[id,policy.defaultImage])));
export function legacyImage(game,image){
 if(game==='factorio')return /^factoriotools\/factorio:2\.0\.77(?:@sha256:[a-f0-9]{64})?$/.test(image||'');
 return game==='rust'&&image==='didstopia/rust-server@sha256:f935f9631e53ad1a235b446496716e1ae65a8d179a3b620abf38e29b9877f88e';
}
export function migrationImage(game,image){return legacyImage(game,image)||game==='factorio'&&/^ghcr\.io\/jkenneydaniel\/factorio-server:2\.0\.77-fc\.[12](?:@sha256:[a-f0-9]{64})?$/.test(image||'');}
export function ownedImage(game,image){return !!imageMatch(imagePolicies[game],image)||!!imageMatch(runtimeImagePolicies[game],image)||game==='factorio'&&!!imageMatch(runtimeImagePolicy,image);}
export function snapshotImageCompatible(game,from,to){
 if(from===to)return true;
 if(ownedImage(game,from)&&ownedImage(game,to)){const [a,ad]=from.split('@'),[b,bd]=to.split('@');if(a===b)return !ad||!bd||ad===bd;}
 return migrationImage(game,from)&&to.split('@')[0]===ownedImages[game];
}
