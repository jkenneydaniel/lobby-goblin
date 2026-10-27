import {assert, sleep} from '../../common.js';

function validationPlugin(framework, id) {
  assert(
    ['carbon', 'oxide'].includes(framework) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id),
    'Invalid framework validation identity.',
  );
  const token = id.replaceAll('-', ''),
    name = 'LobbyGoblinValidation' + token,
    file = name + '.cs';
  const source = Buffer.from(
    'using Oxide.Core; namespace Oxide.Plugins { [Info("' +
      name +
      '", "Lobby Goblin", "1.0.0")] public class ' +
      name +
      ' : RustPlugin { [ConsoleCommand("lg.validation.' +
      token +
      '")] void Probe(ConsoleSystem.Arg arg) { arg.ReplyWith("LG_VALIDATED:' +
      token +
      '"); } } }',
  );
  return {token, name, file, source};
}

// The caller holds the owned stopped barrier. The image's existing ownership
// handoff assigns this new source to the game before Carbon opens it read/write.
export async function prepareRustFrameworkValidation({framework, id, store}) {
  if (framework === 'none') return;
  const {file, source} = validationPlugin(framework, id);
  assert(
    !(await store.read(file)),
    'Validation plugin already exists. Use paired recovery.',
    409,
  );
  await store.write(file, source);
}

export async function validateRustFramework({
  framework,
  id,
  store,
  command,
  running,
  timeout = 300000,
  interval = 2000,
  progress = async () => {},
}) {
  if (framework === 'none') return;
  const {token, name, file, source} = validationPlugin(framework, id),
    prepared = await store.read(file);
  assert(
    prepared?.data.equals(source),
    'Prepared validation source changed before game startup.',
    409,
  );
  // A watcher may still be initializing, and a load may finish after its RCON
  // response times out. Request loading once; retry only the read-only probe.
  const prefix = framework === 'carbon' ? 'c.' : 'oxide.';
  await progress(
    'Loading the prepared validation plugin…',
    'framework-loading',
  );
  try {
    await command(prefix + 'load ' + name);
  } catch {
    assert(await running(), 'Rust stopped during framework loading.', 409);
  }
  const deadline = Date.now() + timeout;
  await progress(
    'Waiting for the compiled validation response…',
    'framework-probing',
  );
  let compiled = false;
  do {
    assert(
      await running(),
      'Rust stopped or restarted during framework validation.',
      409,
    );
    try {
      if (
        String(await command('lg.validation.' + token)).includes(
          'LG_VALIDATED:' + token,
        )
      ) {
        compiled = true;
        break;
      }
    } catch {
      assert(await running(), 'Rust stopped during framework validation.', 409);
    }
    await sleep(interval);
  } while (Date.now() < deadline);
  assert(
    compiled,
    'The framework did not compile and load its validation plugin. Recover the previous software and world before retrying.',
    409,
  );
  await store.write(file, null);
  await progress(
    'Removing the temporary validation plugin…',
    'framework-cleanup',
  );
  await command(prefix + 'unload ' + name);
}
