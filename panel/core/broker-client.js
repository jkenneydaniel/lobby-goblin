import fs from 'node:fs/promises';
import http from 'node:http';
import {assert, HttpError} from '../common.js';

export const BROKER_PROTOCOL = 1;
export const brokerSocket = '/broker/socket/docker.sock';
export const brokerToken = '/broker/credential/token';

// Explicit configuration never falls back to the host socket on any failure.
export function brokerClient({socketPath, tokenFile}) {
  assert(
    typeof socketPath === 'string' &&
      socketPath.startsWith('/') &&
      typeof tokenFile === 'string' &&
      tokenFile.startsWith('/'),
    'Configure both broker socket and credential paths.',
  );
  async function call(endpoint, input, {raw = false, timeout = 150000} = {}) {
    const token = (await fs.readFile(tokenFile, 'utf8')).trim();
    assert(
      /^[A-Za-z0-9_-]{43}$/.test(token),
      'The Docker broker credential is invalid.',
      503,
    );
    const body = Buffer.from(JSON.stringify(input));
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: endpoint,
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + token,
            'content-type': 'application/json',
            'content-length': body.length,
          },
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > 32 * 1024 ** 2)
              req.destroy(Error('The broker response exceeded its limit.'));
            else chunks.push(chunk);
          });
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (res.statusCode >= 400) {
              let message;
              try {
                message = JSON.parse(buffer).error;
              } catch {}
              reject(
                new HttpError(
                  res.statusCode,
                  message || 'The Docker broker refused this request.',
                ),
              );
              return;
            }
            if (raw) return resolve(buffer);
            try {
              resolve(buffer.length ? JSON.parse(buffer) : null);
            } catch {
              reject(Error('Invalid Docker broker response.'));
            }
          });
          res.on('error', reject);
          res.on('aborted', () =>
            reject(Error('The Docker broker response was interrupted.')),
          );
        },
      );
      req.setTimeout(timeout + 5000, () =>
        req.destroy(Error('The Docker broker did not respond.')),
      );
      req.on('error', reject);
      req.end(body);
    });
  }
  const docker = (method, route, data, options = {}) =>
    call(
      '/v1/docker',
      {
        method,
        route,
        ...(data !== undefined && {data}),
        raw: options.raw === true,
        timeout: options.timeout ?? 150000,
      },
      options,
    );
  return {
    docker,
    managementUpdate: (input) => call('/v1/management-update', input),
    grant: (input) => call('/v1/grants', input),
    revoke: (id) => call('/v1/revoke', {id}),
  };
}

export function dockerTransport(env, fallback) {
  const configured =
    env.DOCKER_BROKER_SOCKET !== undefined ||
    env.DOCKER_BROKER_TOKEN_FILE !== undefined;
  return configured
    ? {
        ...brokerClient({
          socketPath: env.DOCKER_BROKER_SOCKET,
          tokenFile: env.DOCKER_BROKER_TOKEN_FILE,
        }),
        brokered: true,
      }
    : {docker: fallback, brokered: false};
}
