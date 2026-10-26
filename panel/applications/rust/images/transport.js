import {existsSync} from 'node:fs';
const source=new URL('../transport.js',import.meta.url);
export const {createWebRcon}=await import(existsSync(source)?source:new URL('../../../applications/rust/transport.js',import.meta.url));
