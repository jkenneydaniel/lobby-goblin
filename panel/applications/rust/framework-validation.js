import {assert, sleep} from '../../common.js';

export async function validateRustFramework({
  framework,
  id,
  store,
  command,
  running,
  timeout = 300000,
  interval = 2000,
}) {
  if (framework === 'none') return;
  assert(
    ['carbon', 'oxide'].includes(framework) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id),
    'Invalid framework validation identity.',
  );
  const token = id.replaceAll('-', ''),
    name = 'LobbyGoblinValidation_' + token,
    file = name + '.cs';
  assert(
    !(await store.read(file)),
    'Validation plugin already exists. Use paired recovery.',
    409,
  );
  await store.write(
    file,
    Buffer.from(
      'using Oxide.Core; namespace Oxide.Plugins { [Info("' +
        name +
        '", "Lobby Goblin", "1.0.0")] public class ' +
        name +
        ' : RustPlugin { [ConsoleCommand("lg.validation.' +
        token +
        '")] void Probe(ConsoleSystem.Arg arg) { arg.ReplyWith("LG_VALIDATED:' +
        token +
        '"); } } }',
    ),
  );
  // A watcher may still be initializing, and a load may finish after its RCON
  // response times out. Request loading once; retry only the read-only probe.
  const prefix = framework === 'carbon' ? 'c.' : 'oxide.';
  try {
    await command(prefix + 'load ' + name);
  } catch {
    assert(await running(), 'Rust stopped during framework loading.', 409);
  }
  const deadline = Date.now() + timeout;
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
  await command(prefix + 'unload ' + name);
}
