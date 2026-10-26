"""Compare ordinary/background saving through both images' normal entrypoints.

Only uses locally cached amd64 images and newly generated data. Never uses
Compose, installation data, existing worlds, published ports or external networks.
"""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
import signal
import subprocess
import uuid

REPO = Path(__file__).resolve().parents[2]
PARSER = argparse.ArgumentParser(description=__doc__)
PARSER.add_argument('--repeats', type=int, default=3)
PARSER.add_argument('--output', type=Path, default=REPO / 'output/implementation/server-performance')
OPTIONS = PARSER.parse_args()
if not 1 <= OPTIONS.repeats <= 5:
    PARSER.error('--repeats must be between 1 and 5')
RUN_ID = 'fc-save-compare-' + str(uuid.uuid4())
EVIDENCE = OPTIONS.output.resolve() / RUN_ID
EVIDENCE.mkdir(parents=True, exist_ok=False)
CONTAINERS, VOLUMES = [], []
RESULT = {'id': RUN_ID, 'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'method': 'Normal image entrypoints, stdin/TTY enabled, generated 10,000-furnace fixture; '
                    'three saves per trial plus /time probes every 20 ms; no external network or ports.',
          'trials': []}


def docker(args, timeout=240):
    value = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if value.returncode:
        raise RuntimeError(str(args[:3]) + ': ' + value.stderr + value.stdout[-2000:])
    return value.stdout


def save():
    (EVIDENCE / 'results.json').write_text(json.dumps(RESULT, indent=2) + '\n')


def volume(suffix):
    name = RUN_ID + '-' + suffix
    docker(['volume', 'create', '--label', 'fc.save-comparison=' + RUN_ID, name])
    labels = json.loads(docker(['volume', 'inspect', name]))[0].get('Labels') or {}
    if labels.get('fc.save-comparison') != RUN_ID:
        raise ValueError('Refusing a volume not owned by this run')
    VOLUMES.append(name)
    return name


def create(image, suffix, args):
    identifier = docker(['create', '--name', RUN_ID + '-' + suffix, '--pull', 'never',
                         '--platform', 'linux/amd64', '--memory', '2g', '--cpuset-cpus', '0,1',
                         *args, image]).strip()
    CONTAINERS.append(identifier)
    return identifier


def one_shot(image, suffix, args, script):
    encoded = base64.b64encode(script.encode()).decode()
    entry = "exec(compile(__import__('base64').b64decode(" + repr(encoded) + "),'comparison.py','exec'))"
    identifier = docker(['create', '--name', RUN_ID + '-' + suffix, '--pull', 'never',
                         '--platform', 'linux/amd64', '--memory', '2g', '--cpuset-cpus', '0,1',
                         *args, '--entrypoint', 'python3', image, '-u', '-c', entry]).strip()
    CONTAINERS.append(identifier)
    docker(['start', identifier])
    code = docker(['wait', identifier]).strip()
    logs = docker(['logs', identifier])
    if code != '0':
        raise RuntimeError('Disposable helper failed: ' + logs[-4000:])
    return logs


def remove(identifier):
    docker(['rm', '-f', identifier])
    CONTAINERS.remove(identifier)


def interrupted(signum, frame):
    raise KeyboardInterrupt('Comparison interrupted')


signal.signal(signal.SIGTERM, interrupted)
try:
    refs = {'factory': 'ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.1',
            'factorio_tools': 'factoriotools/factorio:2.0.77'}
    images = {}
    for label, reference in refs.items():
        item = json.loads(docker(['image', 'inspect', '--platform', 'linux/amd64', reference]))[0]
        assert item['Os'] == 'linux' and item['Architecture'] == 'amd64'
        images[label] = {'tag': reference, 'id': item['Id'], 'reference': item['RepoDigests'][0],
                         'entrypoint': item['Config']['Entrypoint']}
    RESULT['images'] = images
    RESULT['host'] = json.loads(docker(['info', '--format',
        '{"cpus":{{json .NCPU}},"architecture":{{json .Architecture}},"engine":{{json .OperatingSystem}}}']))
    assert RESULT['host']['cpus'] >= 2
    own = images['factory']['reference']
    client_source = Path(__file__).with_name('saving-client.py').read_text()
    rcon_source = (REPO / 'panel/applications/factorio/images/rcon.py').read_text()
    fixture_source = Path(__file__).with_name('worker.py').read_text()
    RESULT['sources_sha256'] = {label: hashlib.sha256(source.encode()).hexdigest() for label, source in
                                [('client', client_source), ('rcon', rcon_source), ('fixture', fixture_source)]}
    fixture = volume('fixture')
    print('Generating a private fixture; no existing worlds are used', flush=True)
    output = one_shot(own, 'generate', ['--network', 'none', '--mount', 'type=volume,source=' + fixture + ',target=/factorio'],
                      "__name__='comparison_fixture'\n" + fixture_source + '\nfixture()\n')
    RESULT['fixture'] = json.loads(output.strip().splitlines()[-1])
    save()
    for repeat in range(OPTIONS.repeats):
        order = ['factory', 'factorio_tools'] if repeat % 2 == 0 else ['factorio_tools', 'factory']
        for mode in [False, True]:
            for label in order:
                suffix = str(repeat) + '-' + label + '-' + str(mode).lower()
                print('Normal startup: ' + suffix, flush=True)
                trial = {'image': label, 'non_blocking_saving': mode, 'repeat': repeat + 1}
                RESULT['trials'].append(trial)
                data = volume(suffix)
                prep = 'import pathlib,shutil,json,os\n'
                prep += '[shutil.copytree(pathlib.Path("/fixture")/n,pathlib.Path("/factorio")/n,dirs_exist_ok=True) for n in ["saves","config","mods"]]\n'
                prep += 'p=pathlib.Path("/factorio/config/server-settings.json");s=json.loads(p.read_text());s["non_blocking_saving"]=' + repr(mode) + ';p.write_text(json.dumps(s))\n'
                prep += '[os.chown(p,845,845) for p in [pathlib.Path("/factorio"),*pathlib.Path("/factorio").rglob("*")]]\n'
                prep += 'print(json.dumps({"save_sha256":__import__("hashlib").sha256(pathlib.Path("/factorio/saves/Benchmark.zip").read_bytes()).hexdigest(),"settings":s}))\n'
                trial['input'] = json.loads(one_shot(own, suffix + '-prepare', ['--network', 'none',
                    '--mount', 'type=volume,source=' + fixture + ',target=/fixture,readonly',
                    '--mount', 'type=volume,source=' + data + ',target=/factorio'], prep).strip())
                server = create(images[label]['reference'], suffix + '-server', ['--network', 'none',
                    '--interactive', '--tty', '--mount', 'type=volume,source=' + data + ',target=/factorio',
                    '-e', 'LOAD_LATEST_SAVE=true', '-e', 'GENERATE_NEW_SAVE=false',
                    '-e', 'DLC_SPACE_AGE=false', '-e', 'UPDATE_MODS_ON_START=false'])
                docker(['start', server])
                try:
                    script = 'rcon_source=' + repr(rcon_source) + '\n' + client_source
                    trial['workload'] = json.loads(one_shot(own, suffix + '-client', ['--network', 'container:' + server,
                        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                        '--tmpfs', '/factorio', '--mount', 'type=volume,source=' + data + ',target=/subject,readonly'], script).strip())
                    state = json.loads(docker(['inspect', server]))[0]['State']
                    trial['before_stop'] = {k: state.get(k) for k in ['Running', 'ExitCode', 'OOMKilled', 'Error']}
                    if state['Running']:
                        trial['process'] = docker(['exec', server, '/bin/sh', '-c',
                            'cat /proc/1/comm; grep -E "^(Name|Pid|PPid|Uid|Gid):" /proc/1/status; sha256sum /opt/factorio/bin/x64/factorio'])
                        docker(['stop', '--time', '45', server], timeout=65)
                    final = json.loads(docker(['inspect', server]))[0]['State']
                    trial['after_stop'] = {k: final.get(k) for k in ['Running', 'ExitCode', 'OOMKilled', 'Error']}
                    log = docker(['logs', server])
                    (EVIDENCE / (suffix + '.log')).write_text(log)
                    trial['log'] = suffix + '.log'
                finally:
                    remove(server)
                save()
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
    for name in VOLUMES:
        try:
            docker(['volume', 'rm', name])
        except Exception as error:
            errors.append(str(error))
    RESULT['cleaned'] = not errors
    RESULT['cleanup_errors'] = errors
    save()
    print(str(EVIDENCE / 'results.json'), flush=True)
    if errors:
        raise RuntimeError('Disposable resource cleanup failed: ' + '; '.join(errors))
