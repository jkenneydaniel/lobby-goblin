// Shared by the trusted controller and managed image. Node built-ins only, so
// the image receives this exact package-owned module without management code.
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import tools from './mod-runtime-tools.json' with {type: 'json'};

const check = (value, message) => {
  if (!value) throw Error(message);
};
const optional = async (location) => {
  try {
    return await fs.lstat(location);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
export const oxideCompiler = Object.freeze(tools.oxideCompiler);
export const carbonHookPaths = Object.freeze([
  'carbon/managed/hooks/Carbon.Hooks.Community.dll',
  'carbon/managed/hooks/Carbon.Hooks.Oxide.dll',
]);
export const carbonConflicts = Object.freeze([
  'RustDedicated_Data/Managed/Microsoft.CodeAnalysis.CSharp.dll',
  'RustDedicated_Data/Managed/Microsoft.CodeAnalysis.dll',
  'RustDedicated_Data/Managed/System.Collections.Immutable.dll',
]);
export function carbonHooksReceipt(value) {
  check(
    value &&
      Object.keys(value).every((key) =>
        ['format', 'buildId', 'protocol', 'packageSha256', 'files'].includes(
          key,
        ),
      ) &&
      value.format === 1 &&
      /^[a-f0-9]{64}$/.test(value.packageSha256 || '') &&
      /^[1-9]\d{0,19}$/.test(value.buildId || '') &&
      /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value.protocol || '') &&
      value.protocol.split('.').every((part) => Number(part) <= 65535) &&
      Array.isArray(value.files) &&
      value.files.length === carbonHookPaths.length &&
      value.files.every(
        (file, index) =>
          file &&
          Object.keys(file).every((key) =>
            ['name', 'size', 'sha256'].includes(key),
          ) &&
          file.name === carbonHookPaths[index] &&
          Number.isSafeInteger(file.size) &&
          file.size > 0 &&
          file.size <= 16 * 1024 ** 2 &&
          /^[a-f0-9]{64}$/.test(file.sha256 || ''),
      ),
    'Prepared Carbon hooks need an exact build and bounded component hashes',
  );
  return JSON.parse(JSON.stringify(value));
}
export const carbonDataDirectories = Object.freeze([
  'plugins',
  'configs',
  'data',
  'modules',
  'logs',
  'lang',
  'profiles',
  'temp',
  'compiler',
  'modifiers',
  'extensions',
  'developer',
]);
export const carbonDataFiles = Object.freeze([
  'config.json',
  'config.auto.json',
  'config.profiler.json',
  'config.webpanel.json',
  'oxide.config.json',
]);
export const oxideNativeConfigPath =
  'RustDedicated_Data/Managed/Oxide.References.dll.config';
export function oxideNativeConfig() {
  const root = '/steamcmd/rust/engine/RustDedicated_Data/Managed';
  return `<configuration>\n<dllmap dll="MonoPosixHelper" target="${root}/x86/libMonoPosixHelper.so" os="!windows,osx" wordsize="32" />\n<dllmap dll="MonoPosixHelper" target="${root}/x64/libMonoPosixHelper.so" os="!windows,osx" wordsize="64" />\n</configuration>`;
}
export async function modDirectory(
  location,
  {create = false, sealed = false} = {},
) {
  check(
    path.isAbsolute(location) &&
      path.resolve(location) === location &&
      location !== '/',
    'Invalid framework storage path',
  );
  let current = path.parse(location).root;
  for (const part of location.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    let stat = await optional(current);
    if (!stat && create) {
      await fs.mkdir(current, {mode: 0o755});
      stat = await fs.lstat(current);
    }
    check(
      stat?.isDirectory() && !stat.isSymbolicLink(),
      'Framework storage cannot use linked parents',
    );
  }
  check(
    (await fs.realpath(location)) === location,
    'Framework storage cannot be linked',
  );
  if (sealed) {
    const stat = await fs.lstat(location);
    check(
      stat.uid === process.getuid() && !(stat.mode & 0o022),
      'Framework code must be controller-owned',
    );
  }
  return location;
}
async function boundLink(source, target, {file = false} = {}) {
  await modDirectory(path.dirname(source), {sealed: true});
  await modDirectory(file ? path.dirname(target) : target, {create: true});
  const expected = path.relative(path.dirname(source), target),
    existing = await optional(source);
  if (existing?.isSymbolicLink()) {
    check(
      existing.uid === process.getuid() &&
        (await fs.readlink(source)) === expected,
      'Framework data link differs from its fixed target',
    );
  } else {
    if (existing) {
      check(
        !file &&
          existing.isDirectory() &&
          existing.uid === process.getuid() &&
          !(existing.mode & 0o022) &&
          (await fs.readdir(source)).length === 0,
        'Framework data remains in the execution tree; prepare it before starting',
      );
      await fs.rmdir(source);
    }
    await fs.symlink(expected, source);
  }
  if (!file)
    check(
      (await fs.realpath(source)) === target,
      'Framework data link escaped its world storage',
    );
  else {
    const stored = await optional(target);
    check(
      !stored ||
        (stored.isFile() &&
          !stored.isSymbolicLink() &&
          stored.nlink === 1 &&
          stored.size <= 512 * 1024),
      'Framework configuration must be a bounded ordinary file',
    );
  }
}
async function nativeBindings(engine, initialize) {
  const target = path.join(engine, oxideNativeConfigPath);
  await modDirectory(path.dirname(target), {sealed: true});
  const existing = await optional(target);
  check(
    !existing ||
      (existing.isFile() &&
        !existing.isSymbolicLink() &&
        existing.nlink === 1 &&
        existing.uid === process.getuid() &&
        !(existing.mode & 0o022) &&
        existing.size <= 512 * 1024),
    'Oxide native bindings must be controller-owned',
  );
  const expected = oxideNativeConfig();
  if (initialize) {
    const temporary = target + '.' + randomUUID();
    try {
      await fs.writeFile(temporary, expected, {flag: 'wx', mode: 0o644});
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, {force: true});
    }
  } else
    check(
      existing && (await fs.readFile(target, 'utf8')) === expected,
      'Prepare Oxide native bindings before starting',
    );
}

export async function prepareFrameworkLayout({
  engine,
  worldRoot,
  identity,
  framework,
  initializeNative = false,
}) {
  check(
    ['carbon', 'oxide'].includes(framework) &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(identity || ''),
    'Invalid managed framework identity',
  );
  await modDirectory(engine, {sealed: true});
  await modDirectory(worldRoot);
  const mutable = path.join(worldRoot, identity, 'mods', framework);
  await modDirectory(mutable, {create: true});
  if (framework === 'oxide') {
    await boundLink(path.join(engine, 'oxide'), mutable);
    await nativeBindings(engine, initializeNative);
    return {mutable, compiler: path.join(engine, 'Oxide.Compiler')};
  }
  const carbon = path.join(engine, 'carbon');
  await modDirectory(carbon, {sealed: true});
  for (const name of carbonConflicts)
    check(
      !(await optional(path.join(engine, name))),
      'Prepare Carbon compiler libraries privately before starting',
    );
  for (const name of [
    'managed',
    'managed/lib',
    'managed/modules',
    'managed/hooks',
  ])
    await modDirectory(path.join(carbon, name), {create: true, sealed: true});
  for (const name of carbonDataDirectories)
    await boundLink(path.join(carbon, name), path.join(mutable, name));
  for (const name of carbonDataFiles)
    await boundLink(path.join(carbon, name), path.join(mutable, name), {
      file: true,
    });
  return {mutable, carbonConfig: path.join(mutable, 'config.json')};
}

// Always invoked as UID/GID 1000 by the supervisor. Mutable configuration never
// receives a privileged write, and no loader/password environment is inherited.
export async function prepareCarbonConfig(root) {
  await modDirectory(root);
  const target = path.join(root, 'config.json');
  let handle,
    config = {};
  try {
    handle = await fs.open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (handle)
    try {
      const before = await handle.stat();
      check(
        before.isFile() && before.nlink === 1 && before.size <= 512 * 1024,
        'Invalid mutable Carbon configuration',
      );
      const buffer = Buffer.alloc(Math.min(before.size + 1, 512 * 1024 + 1));
      let count = 0;
      while (count < buffer.length) {
        const read = await handle.read(
          buffer,
          count,
          buffer.length - count,
          null,
        );
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      const bytes = buffer.subarray(0, count),
        after = await handle.stat();
      check(
        bytes.length === before.size &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs &&
          after.nlink === 1,
        'Carbon configuration changed while reading',
      );
      config = JSON.parse(bytes);
    } finally {
      await handle.close();
    }
  check(
    config && typeof config === 'object' && !Array.isArray(config),
    'Invalid mutable Carbon configuration',
  );
  const updating = config.SelfUpdating || {};
  check(
    updating && typeof updating === 'object' && !Array.isArray(updating),
    'Invalid Carbon update settings',
  );
  config.SelfUpdating = {...updating, Enabled: false, HookUpdates: false};
  const temporary = target + '.' + randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify(config), {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, {force: true});
  }
  // Mono can report a dangling configuration link as existing, then fail its
  // first read. Initialize managed configuration targets as the game user without
  // replacing an existing configuration. Native profiler defaults remain owned
  // by Carbon's native initializer.
  for (const [name, initial] of [
    // Despite its suffix, Carbon Auto stores one console variable per line.
    ['config.auto.json', ''],
    ['config.webpanel.json', '{"Enabled":false}'],
    ['oxide.config.json', '{}'],
  ]) {
    const file = path.join(root, name);
    try {
      await fs.writeFile(file, initial, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(file);
      check(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1 &&
          stat.size <= 512 * 1024,
        'Invalid mutable Carbon configuration',
      );
    }
  }
}
