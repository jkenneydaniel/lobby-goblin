import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {docker} from '../core/docker.js';
import {brokerClient} from '../core/broker-client.js';
import {HttpError} from '../common.js';
import {DockerTransportError} from '../core/docker-transport-error.js';
import {publicTransportMessage} from '../core/operation-errors.js';
import {managementFailure} from '../core/management-errors.js';
import {retainOperationDiagnostic} from '../core/operation-diagnostics.js';
import {runPanelUpdate} from '../management-panel-worker.js';

// Broker IPC runs inside Linux containers; native Windows uses named pipes
// only for the direct Docker adapter. Keep both contracts explicit.
for (const brokered of [false, true])
  test(
    `${brokered ? 'broker' : 'direct Docker'} 404 details stay private across panel diagnostic publication`,
    {skip: brokered && process.platform === 'win32'},
    async (t) => {
      const root = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), 'lgb-transport-')),
        ),
        tag = crypto.randomBytes(5).toString('hex');
      const socket =
        process.platform === 'win32'
          ? '\\\\.\\pipe\\lgb-transport-' + tag
          : '/tmp/lgb-transport-' + tag + '.sock';
      const privateMessage =
        'private-registry.example/internal-management-image:private-tag';
      const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(404, {'content-type': 'application/json'});
        res.end(
          JSON.stringify({message: privateMessage, error: privateMessage}),
        );
      });
      await new Promise((resolve) => server.listen(socket, resolve));
      t.after(async () => {
        await new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        });
        await fs.rm(root, {recursive: true, force: true});
      });
      const tokenFile = path.join(root, 'token');
      await fs.writeFile(tokenFile, 'a'.repeat(43), {mode: 0o600});
      const request = brokered
        ? brokerClient({socketPath: socket, tokenFile}).docker
        : (method, route) =>
            docker(method, route, undefined, {socketPath: socket});
      let failure;
      try {
        await request('GET', '/images/synthetic-missing/json');
        assert.fail('Expected a transport rejection');
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof DockerTransportError);
      assert.equal(failure.status, 404);
      assert.equal(failure.message, privateMessage);
      assert.equal(managementFailure(failure).code, 'docker-request-failed');
      const forwarded = new HttpError(404, publicTransportMessage(failure));
      assert.doesNotMatch(
        managementFailure(forwarded).message,
        /private-registry|private-tag/,
      );
      assert.doesNotMatch(
        JSON.stringify(managementFailure(failure)),
        /private-registry|private-tag/,
      );
      const saved = [],
        id = 'a'.repeat(32);
      await runPanelUpdate({
        input: {id, action: 'plan', targetVersion: '99.0.0-alpha'},
        resolveImage: async () => {
          throw failure;
        },
        workflow: {
          status: async () => {
            throw Error('absent');
          },
          failure: (error, id, phase) =>
            retainOperationDiagnostic(root, error, {
              id,
              source: 'management-updates',
              phase,
              fallback: 'management-update-failed',
            }),
        },
        save: async (value) => saved.push(value),
      });
      assert.equal(saved.at(-1).diagnostic.code, 'docker-request-failed');
      assert.doesNotMatch(
        JSON.stringify(saved),
        /private-registry|private-tag/,
      );
      if (process.platform !== 'win32') {
        assert.equal(saved.at(-1).diagnostic.retained, true);
        const privateRecord = JSON.parse(
          await fs.readFile(
            path.join(
              root,
              'operation-diagnostics',
              'management-updates-' + id + '.json',
            ),
            'utf8',
          ),
        );
        assert.equal(privateRecord.events[0].causes[0].message, privateMessage);
      }
    },
  );
test('intentional local client rejections remain readable while transport metadata is never coerced into public text', () => {
  assert.equal(
    managementFailure(new HttpError(409, 'Owned resource changed.')).message,
    'Owned resource changed.',
  );
  assert.doesNotThrow(() => new DockerTransportError(404, {toString: 0}));
});
