"""Benchmark the owned amd64 image using generated data and private resources.

Never uses Compose, installed containers, existing worlds, credentials or ports.
Requires a locally available image; --pull never prevents implicit downloads.
"""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
PARSER = argparse.ArgumentParser(description=__doc__)
PARSER.add_argument('--image', default='ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.1')
PARSER.add_argument('--output', type=Path, default=REPO / 'output/implementation/server-performance')
OPTIONS = PARSER.parse_args()
RUN_ID = 'fc-perf-' + str(uuid.uuid4())
VOLUME = RUN_ID + '-data'
ROOT = Path(tempfile.mkdtemp(prefix=RUN_ID + '-'))
EVIDENCE = OPTIONS.output.resolve() / RUN_ID
EVIDENCE.mkdir(parents=True, exist_ok=False)
CONTAINERS = []
RESULT = {'id': RUN_ID, 'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'method': 'Existing amd64 binary on current host; no ARM comparisons. '
                    '1200 update ticks; game and helper share CPU 0 only for the contention experiment.'}


def docker(arguments, timeout=240):
    process = subprocess.run(['docker', *arguments], capture_output=True, text=True, timeout=timeout)
    if process.returncode:
        raise RuntimeError(str(arguments[:4]) + '\n' + process.stderr + '\n' + process.stdout[-3000:])
    return process.stdout


def save():
    (EVIDENCE / 'results.json').write_text(json.dumps(RESULT, indent=2) + '\n')


def worker(mode, extra=(), background=False, fixture_volume=False):
    name = RUN_ID + '-' + mode + '-' + str(uuid.uuid4())[:8]
    mounts = ['--mount', 'type=bind,source=' + str(ROOT) + ',target=/bench,readonly',
              '--tmpfs', '/tmp:rw,nosuid,size=64m']
    if fixture_volume:
        mounts += ['--mount', 'type=volume,source=' + VOLUME + ',target=/factorio']
    else:
        mounts += ['--tmpfs', '/factorio:rw,nosuid,size=512m,uid=845,gid=845',
                   '--mount', 'type=volume,source=' + VOLUME + ',target=/fixture,readonly']
    payload = base64.b64encode(WORKER_SOURCE).decode()
    # Pass Python source directly: this also avoids host-share cache effects when
    # the benchmark source was just edited. No installed configuration is read.
    script = 'candidate_source=' + repr(CANDIDATE_SOURCE.decode()) + '; '
    script += "exec(compile(__import__('base64').b64decode(" + repr(payload) + "),'/bench/worker.py','exec'))"
    if not fixture_volume:
        script = ('import pathlib,shutil; '
                  '[shutil.copytree(pathlib.Path("/fixture")/n,pathlib.Path("/factorio")/n,dirs_exist_ok=True) '
                  'for n in ["saves","config","mods"]]; ' + script)
    # Record the immutable ID only after successful creation. A name collision
    # must never cause cleanup to remove someone else's container.
    identifier = docker(['create', '--name', name, '--pull', 'never', '--platform', 'linux/amd64',
                         '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                         '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges:true',
                         '--memory', '2g', '--cpuset-cpus', '0,1', *extra, *mounts,
                         '--entrypoint', 'python3', IMAGE, '-u', '-c', script, mode]).strip()
    CONTAINERS.append(identifier)
    docker(['start', identifier])
    if background:
        for _ in range(600):
            logs = docker(['logs', identifier])
            if '"ready": true' in logs:
                return identifier
            if docker(['inspect', '--format', '{{.State.Running}}', identifier]).strip() != 'true':
                raise RuntimeError(logs)
            time.sleep(.1)
        raise RuntimeError('Disposable helper readiness timed out')
    exit_code = docker(['wait', identifier]).strip()
    logs = docker(['logs', identifier])
    if exit_code != '0':
        raise RuntimeError(mode + ' failed: ' + logs[-4000:])
    return json.loads(logs.strip().splitlines()[-1])


def remove(identifier):
    docker(['rm', '-f', identifier])
    CONTAINERS.remove(identifier)


def interrupted(signum, frame):
    raise KeyboardInterrupt('Benchmark interrupted')


signal.signal(signal.SIGTERM, interrupted)
created_volume = False
try:
    WORKER_SOURCE = Path(__file__).with_name('worker.py').read_bytes()
    CANDIDATE_SOURCE = (REPO / 'panel/applications/factorio/images/entrypoint.py').read_bytes()
    RESULT['sources_sha256'] = {name: hashlib.sha256(source).hexdigest() for name, source in
                                [('worker', WORKER_SOURCE), ('entrypoint', CANDIDATE_SOURCE)]}
    metadata = json.loads(docker(['image', 'inspect', OPTIONS.image]))[0]
    if metadata['Architecture'] != 'amd64' or metadata['Os'] != 'linux':
        raise ValueError('This experiment requires the existing Linux amd64 image')
    IMAGE = metadata['Id']
    RESULT['image'] = IMAGE
    RESULT['host'] = json.loads(docker(['info', '--format',
        '{"cpus":{{json .NCPU}},"memory":{{json .MemTotal}},"architecture":{{json .Architecture}},"engine":{{json .OperatingSystem}}}']))
    if RESULT['host']['cpus'] < 2:
        raise ValueError('Two available Docker CPUs are required for the fixture setup')
    for name in ['map-init.lua', 'map-batch.lua']:
        shutil.copyfile(REPO / 'panel' / name, ROOT / name)
    (ROOT / 'bind').mkdir()
    docker(['volume', 'create', '--label', 'fc.benchmark=' + RUN_ID, VOLUME])
    labels = json.loads(docker(['volume', 'inspect', VOLUME]))[0].get('Labels') or {}
    if labels.get('fc.benchmark') != RUN_ID:
        raise ValueError('Refusing to use a volume not owned by this run')
    created_volume = True
    print('Generating a private 10,000-furnace factory', flush=True)
    RESULT['fixture'] = worker('fixture', fixture_volume=True)
    save()
    print('Comparing ownership scans and disposable storage', flush=True)
    RESULT['storage'] = worker('storage', extra=['--mount', 'type=bind,source=' + str(ROOT / 'bind') + ',target=/bind'], fixture_volume=True)
    save()
    print('Comparing four status commands against two with cached metadata', flush=True)
    server = worker('server', background=True)
    cycles = {'four_commands': [], 'cached_two_commands': []}
    for order in [('four_commands', 'cached_two_commands'), ('cached_two_commands', 'four_commands')] * 3:
        for kind in order:
            start = time.perf_counter()
            commands = ['/players online', '/time', '/seed', '/version'] if kind == 'four_commands' else ['/players online', '/time']
            for command in commands:
                docker(['exec', server, 'rcon', command])
            cycles[kind].append(time.perf_counter() - start)
    RESULT['rcon'] = cycles
    remove(server)
    save()
    print('Testing ordinary and non-blocking saving in separate fixture processes', flush=True)
    RESULT['saving'] = worker('savebench')
    save()
    print('Comparing game update times during background export work', flush=True)
    RESULT['contention'] = {'alone': [], 'default_helper': [], 'weighted_helper': [], 'helpers': []}
    for _ in range(3):
        RESULT['contention']['alone'].append(worker('benchmark', extra=['--cpuset-cpus', '0']))
    # Counterbalance default/weighted order; restart helpers for each sample.
    for order in [('default_helper', 'weighted_helper'), ('weighted_helper', 'default_helper'), ('default_helper', 'weighted_helper')]:
        for kind in order:
            extra = ['--cpu-shares', '128'] if kind == 'weighted_helper' else []
            helper = worker('export', extra=['--cpuset-cpus', '0', *extra], background=True)
            try:
                RESULT['contention'][kind].append(worker('benchmark', extra=['--cpuset-cpus', '0']))
                if docker(['inspect', '--format', '{{.State.Running}}', helper]).strip() != 'true':
                    raise RuntimeError('Background export failed during comparison: ' + docker(['logs', helper])[-2000:])
                RESULT['contention']['helpers'].append({'kind': kind, 'log': docker(['logs', helper])[-2000:]})
                save()
            finally:
                remove(helper)
except (Exception, KeyboardInterrupt) as error:
    RESULT['error'] = str(error)
    raise
finally:
    errors = []
    for identifier in list(CONTAINERS):
        try:
            remove(identifier)
        except Exception as error:
            errors.append(str(error))
    if created_volume:
        try:
            docker(['volume', 'rm', VOLUME])
        except Exception as error:
            errors.append(str(error))
    RESULT['cleaned'] = not errors
    RESULT['cleanup_errors'] = errors
    save()
    shutil.rmtree(ROOT)
    print(str(EVIDENCE / 'results.json'), flush=True)
    if errors:
        raise RuntimeError('Disposable resource cleanup failed: ' + '; '.join(errors))
