// Explicit build/acceptance tooling. Never targets the installation's containers,
// bind mounts, Compose project, data directory or Docker socket configuration.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

export const projectRoot = ['../../../..', '..']
  .map((relative) =>
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), relative),
  )
  .find((candidate) => existsSync(path.join(candidate, 'panel/package.json')));
const root = projectRoot;
if (!root) throw Error('Image tooling needs a complete source bundle.');
const {applicationImages, buildApplicationImage} = await import(
  pathToFileURL(path.join(root, 'panel/core/application-image-build.js'))
);
const {imageLabel} = await import(
  pathToFileURL(path.join(root, 'panel/branding.js'))
);
const {sourceFile} = await import(
  pathToFileURL(path.join(root, 'panel/source-layout.js'))
);
const {headlessSelection} = await import(
  pathToFileURL(
    path.join(root, 'panel/applications/factorio/runtime-update.js'),
  )
);
const {boundedJSON} = await import(
  pathToFileURL(path.join(root, 'panel/core/release-fetch.js'))
);
const {parseGameImage, gameSources} = await import(
  pathToFileURL(
    path.join(root, 'panel/applications/factorio/public/game-images.js'),
  )
);
const {
  compatibleGameImage,
  validateGameImage,
  inspectGameImage,
  gameImageProbe,
  reportsGameVersion,
} = await import(
  pathToFileURL(path.join(root, 'panel/applications/factorio/update-worker.js'))
);
const exec = promisify(execFile);
export async function imageDefinition(directory = root) {
  const definition = JSON.parse(
    await fs.readFile(
      await sourceFile(directory, 'factorio-image/image.json'),
      'utf8',
    ),
  );
  const image =
    definition.repository +
    ':' +
    definition.version +
    '-fc.' +
    definition.revision;
  assert.equal(definition.format, 1);
  assert.equal(definition.compatibility, 1);
  assert.equal(definition.platform, 'linux/amd64');
  assert.equal(definition.repository, gameSources.factory.repository);
  assert.equal(
    parseGameImage(image)?.source,
    'factory',
    'Unsupported image version or revision',
  );
  assert.match(
    definition.baseImage,
    /^debian:bookworm-slim@sha256:[a-f0-9]{64}$/,
  );
  assert.match(definition.headlessSha256, /^[a-f0-9]{64}$/);
  const dockerfile = await fs.readFile(
    await sourceFile(directory, 'factorio-image/Dockerfile'),
    'utf8',
  );
  for (const line of [
    'ARG BASE_IMAGE=' + definition.baseImage,
    'ARG FACTORIO_VERSION=' + definition.version,
    'ARG IMAGE_REVISION=' + definition.revision,
    'ARG HEADLESS_SHA256=' + definition.headlessSha256,
  ])
    assert.ok(
      dockerfile.split('\n').includes(line),
      'Dockerfile and image.json disagree: ' + line.split('=')[0],
    );
  return {...definition, image};
}
const docker = async (args) =>
  (
    await exec('docker', args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15 * 60000,
    })
  ).stdout;
export async function buildImage(_definition, run = docker) {
  const recipe = (await applicationImages(root)).find(
    (value) => value.key === 'factorio/server',
  );
  return buildApplicationImage(recipe, {run: (_program, args) => run(args)});
}
export async function testImage(definition, run = docker) {
  // Test input only, never a build/runtime dependency of our image.
  const legacy = 'factoriotools/factorio:' + definition.version;
  await run(['pull', '--platform', definition.platform, legacy]);
  const inspect = (image) => inspectGameImage(image, run);
  const base = await inspect(legacy),
    owned = await inspect(definition.image);
  assert.equal(owned.Architecture, 'amd64');
  assert.equal(owned.Os, 'linux');
  for (const key of [
    'Entrypoint',
    'Cmd',
    'User',
    'Volumes',
    'ExposedPorts',
    'WorkingDir',
  ])
    assert.deepEqual(
      owned.Config[key] || null,
      base.Config[key] || null,
      'Changed compatibility ' + key,
    );
  for (const key of [
    'SAVES',
    'CONFIG',
    'MODS',
    'SCENARIOS',
    'SCRIPTOUTPUT',
    'PUID',
    'PGID',
    'PORT',
    'RCON_PORT',
  ])
    assert.equal(
      owned.Config.Env.find((v) => v.startsWith(key + '=')),
      base.Config.Env.find((v) => v.startsWith(key + '=')),
      'Changed compatibility ' + key,
    );
  assert.equal(owned.Config.Labels['factorio.version'], definition.version);
  assert.equal(imageLabel(owned.Config.Labels, 'compatibility'), '1');
  assert.equal(
    imageLabel(owned.Config.Labels, 'image-revision'),
    String(definition.revision),
  );
  // Exercise the same disposable preflight the panel uses, including digest
  // references: platform-specific inspect IDs are not runnable on every engine.
  for (const [image, item] of [[definition.image, owned]]) {
    const parsed = parseGameImage(image),
      selection = {
        target: parsed.version,
        source: parsed.source,
        imageRevision: parsed.revision,
        targetImage: image,
      };
    validateGameImage(item, selection);
    // A just-built image has no registry digest in classic Docker stores.
    // Only this unpublished local build may use its immutable local image ID;
    // the panel always requires a registry digest before installing an image.
    const probeImage =
      parsed.source === 'factory' && !item.RepoDigests?.length
        ? item.Id
        : compatibleGameImage(item, selection);
    const output = await run(gameImageProbe(probeImage));
    assert.ok(
      reportsGameVersion(output, definition.version),
      'Panel image preflight did not report the expected version',
    );
  }
  const id = 'fc-image-test-' + crypto.randomUUID(),
    volume = id + '-data',
    name = id + '-server';
  const container = [
    '--platform',
    definition.platform,
    '--network',
    'none',
    '--mount',
    'type=volume,source=' + volume + ',target=/factorio',
  ];
  let created = false,
    started = false;
  try {
    await run(['volume', 'create', volume]);
    created = true;
    // Only a new disposable volume is used. Create the save with the old image.
    await run([
      'run',
      '--rm',
      ...container,
      '--entrypoint',
      '/bin/bash',
      legacy,
      '-ec',
      `mkdir -p /factorio/{config,saves,mods,script-output}; cp /opt/factorio/data/server-settings.example.json /factorio/config/server-settings.json; jq '.name="Compatibility fixture" | .description="Disposable image acceptance" | .visibility={public:false,lan:false} | .require_user_verification=false' /factorio/config/server-settings.json > /factorio/config/settings.tmp; mv /factorio/config/settings.tmp /factorio/config/server-settings.json; printf 'fixture-rcon-only' > /factorio/config/rconpw; printf 'keep-settings' > /factorio/config/compatibility-marker; printf 'keep-mods' > /factorio/mods/compatibility-marker; printf '{"mods":[{"name":"base","enabled":true},{"name":"space-age","enabled":false},{"name":"quality","enabled":false},{"name":"elevated-rails","enabled":false}]}' > /factorio/mods/mod-list.json; /opt/factorio/bin/x64/factorio --create /factorio/saves/Compatibility.zip --mod-directory /factorio/mods; sha256sum /factorio/config/server-settings.json /factorio/config/rconpw /factorio/mods/mod-list.json > /factorio/config/compatibility.sha256; chown -R 845:845 /factorio`,
    ]);
    // A killed first-world publication may leave quarantined scratch output.
    // Make it newer than the real save and verify load-latest still ignores it.
    await run([
      'run',
      '--rm',
      ...container,
      '--entrypoint',
      '/bin/bash',
      definition.image,
      '-ec',
      'mkdir -p /factorio/config/.lobby-goblin-generation; cp /factorio/saves/Compatibility.zip /factorio/config/.lobby-goblin-generation/Competing.tmp.zip; touch -d "next hour" /factorio/config/.lobby-goblin-generation/Competing.tmp.zip; cp /factorio/saves/Compatibility.zip /factorio/saves/.lobby-goblin-killed.pending; touch -d "next hour" /factorio/saves/.lobby-goblin-killed.pending',
    ]);
    await run([
      'create',
      '--name',
      name,
      ...container,
      '-e',
      'LOAD_LATEST_SAVE=true',
      '-e',
      'GENERATE_NEW_SAVE=false',
      '-e',
      'DLC_SPACE_AGE=false',
      '-e',
      'UPDATE_MODS_ON_START=false',
      definition.image,
    ]);
    started = true;
    await run(['start', name]);
    const deadline = Date.now() + 120000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const output = await run(['exec', name, 'rcon', '/version']);
        assert.equal(output.trim(), definition.version);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    assert.ok(
      ready,
      'Image did not load the existing fixture save and expose RCON',
    );
    const startupLog = await run(['logs', name]);
    assert.match(
      startupLog,
      /Loading map \/factorio\/saves\/Compatibility\.zip/,
      'Load-latest must choose the established world',
    );
    assert.doesNotMatch(
      startupLog,
      /Loading map[^\n]*\.lobby-goblin-generation/,
      'Quarantined generation output must never be selected',
    );
    assert.doesNotMatch(
      startupLog,
      /Loading map[^\n]*\.pending/,
      'Interrupted copy staging must never be selected',
    );
    const tickCommand = [
      'exec',
      name,
      'rcon',
      '/silent-command rcon.print(game.tick)',
    ];
    // New saves require the same Lua command twice to acknowledge achievements.
    // This acknowledgement affects only the disposable acceptance save.
    let check = await run(tickCommand);
    if (!check.trim()) check = await run(tickCommand);
    assert.match(check.trim(), /^\d+$/);
    await run(['exec', name, 'rcon', '/server-save Compatibility']);
    await run(['stop', '--time', '120', name]);
    const stopped = JSON.parse(await run(['inspect', name]))[0];
    assert.equal(stopped.State.ExitCode, 0, 'Graceful shutdown failed');
    const output = await run([
      'run',
      '--rm',
      ...container,
      '--entrypoint',
      '/bin/bash',
      definition.image,
      '-ec',
      `test -s /factorio/saves/Compatibility.zip; test "$(cat /factorio/config/compatibility-marker)" = keep-settings; test "$(cat /factorio/mods/compatibility-marker)" = keep-mods; python3 -c 'import json; assert json.load(open("/factorio/config/server-settings.json"))["name"] == "Compatibility fixture"'; test "$(cat /factorio/config/rconpw)" = fixture-rcon-only; test "$(stat -c %u /factorio/saves/Compatibility.zip)" = 845; sha256sum -c /factorio/config/compatibility.sha256; echo compatible`,
    ]);
    assert.match(output, /compatible/);
    // Reload the save written by our image with the original binary as well.
    await run([
      'run',
      '--rm',
      ...container,
      '--entrypoint',
      '/opt/factorio/bin/x64/factorio',
      legacy,
      '--benchmark',
      '/factorio/saves/Compatibility.zip',
      '--benchmark-ticks',
      '1',
      '--benchmark-runs',
      '1',
      '--mod-directory',
      '/factorio/mods',
    ]);
    // Exercise the panel's direct-entrypoint creation and preview interfaces.
    const worker = [
      'run',
      '--rm',
      ...container,
      '--user',
      '845:845',
      '--entrypoint',
      '/opt/factorio/bin/x64/factorio',
      definition.image,
    ];
    await run([
      ...worker,
      '--create',
      '/factorio/saves/Worker-created.zip',
      '--map-gen-settings',
      '/factorio/config/map-gen-settings.json',
      '--map-settings',
      '/factorio/config/map-settings.json',
      '--mod-directory',
      '/factorio/mods',
    ]);
    await run([
      ...worker,
      '--generate-map-preview',
      '/factorio/compatibility-preview.png',
      '--map-preview-size',
      '128',
      '--map-gen-settings',
      '/factorio/config/map-gen-settings.json',
      '--mod-directory',
      '/factorio/mods',
    ]);
    await run([
      'run',
      '--rm',
      ...container,
      '--user',
      '845:845',
      '--entrypoint',
      'python3',
      definition.image,
      '-c',
      `from pathlib import Path; import struct,zipfile; image=Path("/factorio/compatibility-preview.png").read_bytes(); assert image[:8] == bytes([137,80,78,71,13,10,26,10]), "Invalid PNG signature"; assert struct.unpack(">II",image[16:24]) == (128,128), "Unexpected preview size"; archive=zipfile.ZipFile("/factorio/saves/Worker-created.zip"); assert archive.testzip() is None, "Corrupt generated world ZIP"; assert any(name.endswith("/level.dat0") for name in archive.namelist()), archive.namelist(); print("Verified generated world ZIP and 128x128 PNG")`,
    ]);
  } finally {
    try {
      if (started) await run(['rm', '-f', name]);
    } finally {
      if (created) await run(['volume', 'rm', volume]);
    }
  }
}
export async function runtimeImageDefinition(directory = root) {
  const definition = JSON.parse(
    await fs.readFile(
      await sourceFile(directory, 'factorio-image/runtime/image.json'),
      'utf8',
    ),
  );
  assert.equal(definition.format, 1);
  assert.equal(definition.mode, 'runtime');
  assert.equal(definition.compatibility, 1);
  assert.equal(definition.platform, 'linux/amd64');
  assert.equal(definition.repository, gameSources.factory.repository);
  assert.ok(Number.isInteger(definition.revision) && definition.revision > 0);
  assert.match(
    definition.baseImage,
    /^debian:bookworm-slim@sha256:[a-f0-9]{64}$/,
  );
  const dockerfile = await fs.readFile(
    await sourceFile(directory, 'factorio-image/runtime/Dockerfile'),
    'utf8',
  );
  for (const line of [
    'ARG BASE_IMAGE=' + definition.baseImage,
    'ARG IMAGE_REVISION=' + definition.revision,
  ])
    assert.ok(dockerfile.split('\n').includes(line));
  assert.ok(
    !dockerfile.includes('get-download') &&
      !dockerfile.includes('FACTORIO_VERSION=2.'),
    'Runtime image must not bundle a game release',
  );
  return {
    ...definition,
    image: definition.repository + ':runtime-fc.' + definition.revision,
  };
}
export async function buildRuntimeImage(_definition, run = docker) {
  const recipe = (await applicationImages(root)).find(
    (value) => value.key === 'factorio/runtime',
  );
  return buildApplicationImage(recipe, {run: (_program, args) => run(args)});
}
export async function testRuntimeImage(definition, run = docker) {
  const id = 'fc-runtime-test-' + crypto.randomUUID(),
    volume = id + '-data',
    scratch = id + '-scratch',
    name = id + '-server';
  const common = [
    '--platform',
    definition.platform,
    '--memory',
    '1g',
    '--mount',
    'type=volume,source=' + volume + ',target=/factorio',
  ];
  const python = (code) =>
    run([
      'run',
      '--rm',
      ...common,
      '--network',
      'none',
      '--entrypoint',
      'python3',
      definition.image,
      '-c',
      code,
    ]);
  let created = false,
    started = false,
    scratchCreated = false,
    helperStarted = false;
  async function ready(version, ref = name) {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      try {
        const output = await run(['exec', ref, 'rcon', '/version']);
        assert.equal(output.trim(), version);
        return;
      } catch {
        const state = JSON.parse(await run(['inspect', ref]))[0].State;
        if (!state.Running)
          throw Error(
            'Disposable runtime stopped before readiness: ' +
              (await run(['logs', ref])),
          );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw Error('Disposable runtime did not start ' + version);
  }
  async function create(network) {
    await run([
      'create',
      '--name',
      name,
      ...common,
      '--network',
      network,
      '-e',
      'FACTORIO_VERSION=2.0.77',
      '-e',
      'DLC_SPACE_AGE=false',
      '-e',
      'UPDATE_MODS_ON_START=false',
      definition.image,
    ]);
    started = true;
    await run(['start', name]);
  }
  try {
    await run(['volume', 'create', volume]);
    created = true;
    await python(
      `import pathlib,json; p=pathlib.Path('/factorio/config'); p.mkdir(); (p/'server-settings.json').write_text(json.dumps({'name':'Disposable runtime acceptance','description':'Synthetic test only','visibility':{'public':False,'lan':False},'require_user_verification':False,'auto_pause':True})); (p/'sentinel').write_text('keep-existing-settings')`,
    );
    await create('bridge');
    await ready('2.0.77');
    await run(['stop', '--time', '120', name]);
    const receipt = JSON.parse(
      await python(`print(open('/factorio/runtime/installed.json').read())`),
    );
    assert.equal(receipt.softwareVersion, '2.0.77');
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    await python(
      `from pathlib import Path; import hashlib,json; root=Path('/factorio'); files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for d in ['saves','config','mods'] for p in (root/d).rglob('*') if p.is_file()}; (root/'runtime/acceptance-files.json').write_text(json.dumps(files))`,
    );
    await run(['rm', name]);
    started = false;
    // A recreated container with no network must reuse its exact installed release.
    await create('none');
    await ready('2.0.77');
    await run(['stop', '--time', '120', name]);
    await python(
      `from pathlib import Path; import json,hashlib; root=Path('/factorio'); files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for d in ['saves','config','mods'] for p in (root/d).rglob('*') if p.is_file()}; (root/'runtime/acceptance-files.json').write_text(json.dumps(files)); assert json.loads((root/'runtime/installed.json').read_text())['softwareVersion']=='2.0.77'; assert (root/'config/sentinel').read_text()=='keep-existing-settings'`,
    );
    await run(['volume', 'create', scratch]);
    scratchCreated = true;
    const release = receipt.softwareVersion + '-' + receipt.sha256;
    const helper = [
      'run',
      '--rm',
      '--platform',
      definition.platform,
      '--network',
      'none',
      '--memory',
      '1g',
      '--mount',
      'type=volume,source=' +
        volume +
        ',target=/opt/factorio,volume-subpath=runtime/releases/' +
        release +
        ',readonly',
      '--mount',
      'type=volume,source=' + scratch + ',target=/factorio',
    ];
    const version = await run([
      ...helper,
      '--entrypoint',
      '/opt/factorio/bin/x64/factorio',
      definition.image,
      '--version',
    ]);
    assert.ok(reportsGameVersion(version, '2.0.77'));
    await run([
      ...helper,
      '--entrypoint',
      '/opt/factorio/bin/x64/factorio',
      definition.image,
      '--generate-map-preview',
      '/factorio/preview.png',
      '--map-preview-size',
      '128',
      '--threads',
      '1',
    ]);
    await run([
      ...helper,
      '--entrypoint',
      'python3',
      definition.image,
      '-c',
      `from pathlib import Path; import struct; p=Path('/factorio/preview.png').read_bytes(); assert p[:8]==bytes([137,80,78,71,13,10,26,10]); assert struct.unpack('>II',p[16:24])==(128,128)`,
    ]);
    await run([
      ...helper,
      '--mount',
      'type=volume,source=' + volume + ',target=/source,readonly',
      '--entrypoint',
      'python3',
      definition.image,
      '-c',
      `from pathlib import Path; import shutil; root=Path('/factorio'); [(shutil.rmtree(root/d,ignore_errors=True),shutil.copytree(Path('/source')/d,root/d)) for d in ['saves','config','mods']]`,
    ]);
    const helperName = id + '-helper';
    await run([
      'create',
      '--name',
      helperName,
      ...helper.slice(2),
      '-e',
      'FACTORIO_RUNTIME_HELPER=true',
      '-e',
      'DLC_SPACE_AGE=false',
      '-e',
      'UPDATE_MODS_ON_START=false',
      definition.image,
    ]);
    helperStarted = true;
    await run(['start', helperName]);
    await ready('2.0.77', helperName);
    await run(['stop', '--time', '120', helperName]);
    await run(['rm', helperName]);
    helperStarted = false;
    await python(
      `from pathlib import Path; import shutil; root=Path('/factorio'); backup=root/'runtime/acceptance-backup'; backup.mkdir(); [(shutil.copytree(root/name,backup/name)) for name in ['saves','config','mods']]; shutil.copyfile(root/'runtime/installed.json',backup/'installed.json')`,
    );
    const latest = await boundedJSON(
        fetch,
        'https://factorio.com/api/latest-releases',
      ),
      wanted = await headlessSelection(latest.stable.headless);
    assert.notEqual(
      wanted.softwareVersion,
      '2.0.77',
      'Native upgrade fixture needs a newer stable release',
    );
    await python(
      `from pathlib import Path; import json; root=Path('/factorio/runtime'); old=json.loads((root/'installed.json').read_text()); wanted=json.loads(${JSON.stringify(JSON.stringify(wanted))}); wanted.update(operation='12345678-1234-1234-1234-123456789abc',previous=old['softwareVersion']+'-'+old['sha256']); (root/'request.json').write_text(json.dumps(wanted))`,
    );
    await run(['rm', name]);
    started = false;
    await create('bridge');
    await ready(wanted.softwareVersion);
    await run(['stop', '--time', '120', name]);
    await python(
      `from pathlib import Path; import json,hashlib; root=Path('/factorio'); old=json.loads((root/'runtime/acceptance-backup/installed.json').read_text()); assert (root/'runtime/releases'/(old['softwareVersion']+'-'+old['sha256'])).is_dir(); files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for d in ['saves','config','mods'] for p in (root/d).rglob('*') if p.is_file()}; (root/'runtime/acceptance-files.json').write_text(json.dumps(files))`,
    );
    // The live server is stopped. Exercise a checksum-failed update, preserving
    // all world/config/mod bytes and the old receipt for explicit recovery.
    await python(
      `from pathlib import Path; import json; root=Path('/factorio/runtime'); old=json.loads((root/'installed.json').read_text()); (root/'request.json').write_text(json.dumps({'version':1,'provider':'factorio-headless','softwareVersion':'2.0.77','sha256':'a'*64,'operation':'12345678-1234-1234-1234-123456789abc','previous':old['softwareVersion']+'-'+old['sha256']}))`,
    );
    await run(['rm', name]);
    started = false;
    await create('bridge');
    const failed = JSON.parse(await run(['wait', name]));
    assert.notEqual(failed, 0, 'Checksum failure must refuse startup');
    await python(
      `from pathlib import Path; import hashlib,json,shutil; root=Path('/factorio'); old=json.loads((root/'runtime/acceptance-files.json').read_text()); assert all(hashlib.sha256((root/name).read_bytes()).hexdigest()==value for name,value in old.items()); assert json.loads((root/'runtime/installed.json').read_text())['softwareVersion']==${JSON.stringify(wanted.softwareVersion)}; (root/'runtime/request.json').unlink(); backup=root/'runtime/acceptance-backup'; [(shutil.rmtree(root/name),shutil.copytree(backup/name,root/name)) for name in ['saves','config','mods']]; shutil.copyfile(backup/'installed.json',root/'runtime/installed.json')`,
    );
    await run(['rm', name]);
    started = false;
    await create('none');
    await ready('2.0.77');
    await run(['stop', '--time', '120', name]);
  } finally {
    try {
      if (helperStarted) await run(['rm', '-f', id + '-helper']);
    } finally {
      try {
        if (started) await run(['rm', '-f', name]);
      } finally {
        try {
          if (scratchCreated) await run(['volume', 'rm', scratch]);
        } finally {
          if (created) await run(['volume', 'rm', volume]);
        }
      }
    }
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2]?.startsWith('runtime-')) {
    const definition = await runtimeImageDefinition(),
      action = process.argv[2];
    if (action === 'runtime-describe')
      console.log(JSON.stringify(definition, null, 2));
    else if (action === 'runtime-build') await buildRuntimeImage(definition);
    else if (action === 'runtime-test') await testRuntimeImage(definition);
    else
      throw new Error('Use runtime-describe, runtime-build or runtime-test.');
  } else {
    const definition = await imageDefinition(),
      action = process.argv[2];
    if (action === 'describe') console.log(JSON.stringify(definition, null, 2));
    else if (action === 'build') await buildImage(definition);
    else if (action === 'test') await testImage(definition);
    else
      throw new Error(
        'Use describe, build or test. These tools do not deploy or publish images.',
      );
  }
}
