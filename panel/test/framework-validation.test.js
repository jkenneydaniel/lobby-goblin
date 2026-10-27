import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRustFramework} from '../applications/rust/framework-validation.js';

const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const token = id.replaceAll('-', '');
for (const framework of ['carbon', 'oxide']) {
  test(
    framework +
      ' explicitly loads once and retries only its read-only compilation probe',
    async () => {
      const files = new Map(),
        calls = [];
      let probes = 0;
      await validateRustFramework({
        framework,
        id,
        store: {
          read: async (name) => files.get(name),
          write: async (name, data) => {
            if (data === null) files.delete(name);
            else files.set(name, data);
          },
        },
        running: async () => true,
        timeout: 1000,
        interval: 1,
        command: async (command) => {
          calls.push(command);
          if (command.includes('load ') && !command.includes('unload '))
            throw Error('load response lost');
          if (command.startsWith('lg.validation.')) {
            if (++probes < 3) throw Error('unknown command has no reply yet');
            return 'LG_VALIDATED:' + token;
          }
          return 'unloaded';
        },
      });
      assert.equal(probes, 3);
      assert.equal(
        calls.filter((command) => /^(?:c|oxide)\.load /.test(command)).length,
        1,
      );
      assert.equal(files.size, 0);
      assert.match(calls.at(-1), /\.unload LobbyGoblinValidation_/);
    },
  );
}
test('failed framework validation retains its source as recovery evidence and refuses a stopped server', async () => {
  const files = new Map();
  await assert.rejects(
    validateRustFramework({
      framework: 'carbon',
      id,
      store: {
        read: async (name) => files.get(name),
        write: async (name, data) => files.set(name, data),
      },
      running: async () => false,
      command: async () => 'queued',
      timeout: 1000,
      interval: 1,
    }),
    /stopped or restarted/,
  );
  assert.equal(files.size, 1);
});
