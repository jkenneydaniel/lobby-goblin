import {spawn} from 'node:child_process';
import {assert, HttpError} from '../../common.js';

// Reviewed callers construct arguments through metadata.js. No shell, inherited
// account tokens, game loader variables or arbitrary process environment.
export async function runSteamCommand(
  args,
  {
    program = '/opt/steamcmd/steamcmd.sh',
    timeout = 1800000,
    signal,
    onProgress = async () => {},
  } = {},
) {
  assert(
    Array.isArray(args) &&
      args.every(
        (value) => typeof value === 'string' && !/[\x00\r\n]/.test(value),
      ) &&
      Number.isInteger(timeout) &&
      timeout > 0 &&
      timeout <= 5400000,
    'Invalid Steam execution request.',
  );
  if (signal?.aborted)
    throw new HttpError(409, 'Steam operation was cancelled before starting.');
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      detached: process.platform !== 'win32',
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME || '/home/node',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      tail = '',
      stopped = false,
      cause = null,
      pending = Promise.resolve(),
      latestProgress = null,
      reporting = false;
    const limit = 8 * 1024 ** 2;
    function kill(signal) {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    function stop(error) {
      if (stopped) return;
      // Steam workers only touch private staging. Kill the entire worker group
      // before releasing its lease; game processes are never supervised here.
      stopped = true;
      cause = error;
      kill('SIGKILL');
    }
    function observe(chunk) {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-limit);
      const lines = (tail + text).split(/[\r\n]/);
      tail = lines.pop().slice(-8192);
      for (const line of lines) {
        const match = line.match(
          /Update state .*progress:\s*[\d.]+\s*\((\d+)\s*\/\s*(\d+)\)/,
        );
        if (!match) continue;
        const receivedBytes = Number(match[1]),
          totalBytes = Number(match[2]);
        if (
          !Number.isSafeInteger(receivedBytes) ||
          !Number.isSafeInteger(totalBytes) ||
          receivedBytes < 0 ||
          totalBytes < receivedBytes ||
          totalBytes > 1024 ** 4
        )
          continue;
        latestProgress = {receivedBytes, totalBytes};
        if (!reporting) {
          reporting = true;
          pending = (async () => {
            try {
              while (latestProgress && !cause) {
                const current = latestProgress;
                latestProgress = null;
                await onProgress(current);
              }
            } catch (error) {
              stop(error);
            } finally {
              reporting = false;
            }
          })();
        }
      }
    }
    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    const cancel = () =>
      stop(new HttpError(409, 'Steam operation was cancelled.'));
    signal?.addEventListener('abort', cancel, {once: true});
    const timer = setTimeout(
      () => stop(new HttpError(504, 'Steam operation timed out.')),
      timeout,
    );
    timer.unref();
    child.once('error', (error) => {
      cause = error;
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      await pending;
      if (cause || code !== 0) {
        const error = new HttpError(
          cause?.status || 503,
          cause?.status
            ? cause.message
            : 'Steam command failed. Review the installation before retrying.',
        );
        error.diagnostic = output;
        reject(error);
      } else resolve(output);
    });
  });
}
