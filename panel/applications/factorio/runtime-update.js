import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assert,
  HttpError,
  readJSON,
  writeJSON,
  existingFile,
  inside,
} from '../../common.js';
import {zipEntries} from '../../core/archive.js';
import {validateBackup} from './backup.js';
import {readScopedJSON} from '../../core/helper-workspace.js';
import {headlessChecksums, headlessVersion} from './headless-releases.js';
import {
  installedRuntime,
  runtimeDirectory,
  runtimeRequest,
  runtimeReceipt,
  releaseKey,
} from './runtime.js';

export async function restoreRuntimeBackup({
  data,
  backups,
  backupDir,
  name,
  previous,
}) {
  const buffer = await fs.readFile(await existingFile(backupDir, name));
  validateBackup(buffer);
  const entries = zipEntries(buffer)
    .filter((entry) => !entry.name.endsWith('/'))
    .map((entry) => ({name: entry.name, data: entry.read()}));
  const manifest = JSON.parse(
    entries.find((entry) => entry.name === 'panel-manifest.json').data,
  );
  assert(
    manifest.software && releaseKey(manifest.software) === releaseKey(previous),
    'Recovery backup does not match the previous Factorio release.',
    409,
  );
  const directories = ['saves', 'config', 'mods'];
  for (const name of directories) {
    const stat = await fs.lstat(path.join(data, name)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    assert(
      !stat || (stat.isDirectory() && !stat.isSymbolicLink()),
      'Recovery directories must be ordinary directories.',
      409,
    );
  }
  const archive = path.join(
    backups,
    'before-software-recovery-' + crypto.randomUUID(),
  );
  await fs.mkdir(archive);
  for (const name of directories) {
    // A killed earlier recovery may have moved a directory but not recreated
    // it. Preserve every remaining directory, then restore the complete backup.
    await fs
      .rename(path.join(data, name), path.join(archive, name))
      .catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await fs.mkdir(path.join(data, name));
  }
  for (const entry of entries)
    if (entry.name !== 'panel-manifest.json') {
      const destination = inside(data, entry.name);
      await fs.mkdir(path.dirname(destination), {recursive: true});
      await fs.writeFile(destination, entry.data, {flag: 'wx'});
    }
  if (manifest.activeSave)
    await fs.utimes(
      inside(path.join(data, 'saves'), manifest.activeSave),
      new Date(),
      new Date(),
    );
}

export async function headlessSelection(version, fetcher = fetch) {
  assert(
    headlessVersion(version),
    'Choose an exact Factorio 2.x release.',
  );
  const releases = await headlessChecksums(fetcher);
  assert(
    releases.has(version),
    'This release has no official Linux headless checksum.',
    409,
  );
  return {
    version: 1,
    provider: 'factorio-headless',
    softwareVersion: version,
    sha256: releases.get(version),
  };
}

// A durable journal is written before stopping or selecting software. Startup
// never replays this workflow. Recovery restores both data and binary identity.
export class RuntimeUpdates {
  constructor({
    data,
    state,
    info,
    control,
    ready,
    backup,
    restore,
    stage,
    select = headlessSelection,
  }) {
    Object.assign(this, {
      data,
      state,
      info,
      control,
      ready,
      backup,
      restore,
      stage,
      select,
    });
    this.file = path.join(state, 'factorio-runtime-update.json');
  }
  async journal() {
    return readJSON(this.file, null);
  }
  async pending() {
    const value = await this.journal();
    return value && !['complete', 'recovered'].includes(value.phase)
      ? value
      : null;
  }
  async guard(action) {
    const pending = await this.pending();
    assert(
      !pending || ['stop', 'software-recover'].includes(action),
      'A Factorio software update needs recovery. Restore its recorded backup and previous release using Recover software update.',
      409,
    );
  }
  async stop() {
    const before = await this.info();
    if (before.State.Running) await this.control('stop');
    const server = await this.info();
    assert(
      !server.State.Running &&
        server.State.ExitCode === 0 &&
        !server.State.OOMKilled,
      'Factorio did not stop cleanly. Its software selection was preserved.',
      409,
    );
  }
  async update({version, confirm}, job) {
    assert(
      confirm === true,
      'Confirm stopping the server and changing its Factorio version.',
    );
    await this.guard('software-update');
    const server = await this.info(),
      previous = await installedRuntime(this.data, server);
    assert(
      previous,
      'Software updates require the opt-in Factorio runtime image.',
      409,
    );
    const wanted = runtimeReceipt(await this.select(version));
    assert(
      wanted.softwareVersion === version &&
        releaseKey(previous) !== releaseKey(wanted),
      'The selected release is already installed or changed after review.',
      409,
    );
    const record = {
      version: 1,
      operation: job.id,
      phase: 'prepared',
      previous,
      wanted,
      wasRunning: server.State.Running,
      backup: null,
    };
    await writeJSON(this.file, record);
    try {
      await this.stage(
        job,
        'Saving and stopping Factorio before the software change…',
        'software-stopping',
      );
      await this.stop();
      record.backup = await this.backup('before-software-update', {
        save: false,
      });
      record.phase = 'backed-up';
      await writeJSON(this.file, record);
      await this.stage(
        job,
        'Installing the selected verified Factorio release…',
        'software-installing',
        {version, backup: record.backup},
      );
      // Persist installation intent before a request can reach the entrypoint.
      record.phase = 'installing';
      await writeJSON(this.file, record);
      await runtimeRequest(this.data, {
        ...wanted,
        operation: job.id,
        previous: releaseKey(previous),
      });
      await this.control('start');
      await this.ready(version);
      assert(
        releaseKey(await installedRuntime(this.data, await this.info())) ===
          releaseKey(wanted),
        'Factorio started with a different release.',
        409,
      );
      if (!record.wasRunning) await this.stop();
      record.phase = 'complete';
      await writeJSON(this.file, record);
      return (
        'Factorio ' +
        version +
        ' installed. Pre-update backup: ' +
        record.backup +
        '.'
      );
    } catch (error) {
      // Do not select older software against a world the new binary may have saved.
      // A recovery action restores the paired backup before starting the old binary.
      await this.control('stop').catch(() => {});
      record.phase = 'recovery-required';
      await writeJSON(this.file, record);
      throw Object.assign(new HttpError(409,
        'Factorio software update needs recovery. The server was left stopped; its previous release and backup were retained.'), {cause:error});
    }
  }
  async recover({confirm}, job) {
    assert(
      confirm === true,
      'Confirm restoring the pre-update world, settings, mods and software.',
    );
    const record = await this.pending();
    assert(record, 'There is no software update to recover.', 409);
    await this.stage(
      job,
      'Restoring the previous Factorio release and matching server data…',
      'software-recovery',
    );
    const server = await this.info();
    if (server.State.Running) await this.control('stop');
    assert(
      !(await this.info()).State.Running,
      'Stop Factorio before recovering its software.',
      409,
    );
    const root = await runtimeDirectory(this.data);
    const request = await readScopedJSON(
      this.data,
      'runtime/request.json',
      null,
    );
    assert(
      !request || request.operation === record.operation,
      'Another software request needs operator review.',
      409,
    );
    if (record.backup) await this.restore(record.backup, record.previous);
    else
      assert(
        releaseKey(await installedRuntime(this.data, server)) ===
          releaseKey(record.previous),
        'Software changed without a recorded backup. Operator recovery is required.',
        409,
      );
    await fs.rm(path.join(root, 'request.json'), {force: true});
    // The previous receipt carries its verified inventory. The entrypoint checks
    // every byte before executing it, including during offline recovery.
    await writeJSON(path.join(root, 'installed.json'), record.previous);
    if (record.wasRunning) {
      await this.control('start');
      await this.ready(record.previous.softwareVersion);
    }
    record.phase = 'recovered';
    await writeJSON(this.file, record);
    return 'Previous Factorio release and matching pre-update data restored.';
  }
}
