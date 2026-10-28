import {ManagementFailure} from './management-errors.js';

export function managementSocketKind(mount) {
  if (mount?.Type !== 'bind' || mount.Destination !== '/var/run/docker.sock')
    return null;
  if (mount.Source === '/var/run/docker.sock') return 'canonical';
  // Docker Desktop's VM proxy, observed on Windows and independently documented
  // in docker/for-win#11300. This is an exact alias, not a path-prefix exception.
  if (mount.Source === '/run/host-services/docker.proxy.sock')
    return 'desktop-proxy';
  return null;
}

// Execute only in an already owned, running management service with checked
// mounts/commands. Read one fixed endpoint through the existing socket; never
// mount a new source, import broker credentials or execute an operator command.
export const managementSocketProbe = `
import fs from 'node:fs/promises';
import http from 'node:http';
if (!(await fs.lstat('/var/run/docker.sock')).isSocket()) throw Error('not a socket');
const info = await new Promise((resolve, reject) => {
 const req = http.get({socketPath:'/var/run/docker.sock',path:'/info'}, res => {
  let bytes = ''; res.setEncoding('utf8');
  res.on('data', chunk => {bytes += chunk; if (bytes.length > 65536) req.destroy(Error('too large'));});
  res.on('end', () => {try {if (res.statusCode !== 200) throw Error('unavailable'); resolve(JSON.parse(bytes));} catch(error) {reject(error);}});
  res.on('error', reject);
 });
 req.setTimeout(5000, () => req.destroy(Error('timeout'))); req.on('error', reject);
});
console.log(JSON.stringify({ID:info.ID,OSType:info.OSType}));`;

export async function verifyManagementSocket(info, engine, read) {
  const mounts = info.Mounts.filter((mount) => mount.Type === 'bind');
  if (mounts.some((mount) => !managementSocketKind(mount)) || mounts.length > 1)
    throw new ManagementFailure('docker-socket-unverified');
  if (!mounts.some((mount) => managementSocketKind(mount) === 'desktop-proxy'))
    return;
  if (engine?.OSType !== 'linux' || engine.OperatingSystem !== 'Docker Desktop')
    throw new ManagementFailure('docker-socket-unverified');
  try {
    const reached = await read(info.Id, managementSocketProbe);
    if (reached?.ID !== engine.ID || reached.OSType !== 'linux')
      throw Error('different engine');
  } catch (cause) {
    throw new ManagementFailure('docker-socket-unverified', {cause});
  }
}
