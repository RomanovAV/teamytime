"""Exercise the real Zsh scripts with a local stand-in, without calling a model."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest


REPO = Path(__file__).resolve().parents[1]
FAKE_CLI = r'''
import json
import os
from pathlib import Path
import sys
import time

args = sys.argv[1:]
root = Path(os.environ['TT_TEST_ROOT'])
mode = os.environ.get('TT_TEST_MODE', '')

def trace(event):
    value = {'event': event, 'pid': os.getpid(), 'time': time.monotonic(),
             'args': args, 'cwd': os.getcwd()}
    with (root / 'trace.ndjson').open('a') as stream:
        stream.write(json.dumps(value) + '\n')

def option(name, default=''):
    return args[args.index(name) + 1] if name in args else default

trace('start')
if '--version' in args:
    print('fake-gigacode 1.0')
elif '--help' in args:
    print('--chat-recording --approval-mode --output-format --session-id --resume '
          '--append-system-prompt --max-session-turns --include-partial-messages '
          '--allowed-tools --model --acp')
elif '--acp' in args:
    request = json.loads(sys.stdin.readline())
    (root / 'acp-request.json').write_text(json.dumps(request))
    if mode == 'acp-error':
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'],
                          'error': {'code': -32601, 'message': 'Not implemented'}}), flush=True)
    else:
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'],
                          'result': {'protocolVersion': 1,
                                     'agentCapabilities': {'loadSession': True}}}), flush=True)
    sys.stdin.read()
else:
    prompt = args[-1]
    if '--session-id' in args and 'CEDAR_4826' in prompt:
        if mode == 'fail-b':
            print('session creation rejected', file=sys.stderr)
            sys.exit(7)
        if mode == 'timeout-b':
            time.sleep(30)
    if '--session-id' in args and 'ORBIT_7319' in prompt and mode == 'interrupt':
        time.sleep(30)
    session = option('--session-id', option('--resume', 'fresh'))
    state = root / (session + '.state')
    if '--session-id' in args:
        state.write_text('ORBIT_7319' if 'ORBIT_7319' in prompt else 'CEDAR_4826')
    output = state.read_text() if state.exists() else 'probe output'
    if '--resume' in args and '--append-system-prompt' in args:
        time.sleep(0.3)
    if '-p' in args:
        Path('teamytime-probe.txt').write_text('TEAMYTIME_TOOL_OK\n')
        output = 'TEAMYTIME_TOOL_OK'
    print(json.dumps({'type': 'system', 'session_id': session,
                      'model': option('--model', 'default')}))
    print(json.dumps({'type': 'result', 'session_id': session, 'result': output}))
trace('end')
'''


class ProbeScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='teamytime zsh test ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cli = self.root / 'fake gigacode'
        self.cli.write_text('#!' + sys.executable + '\n' + FAKE_CLI)
        self.cli.chmod(0o755)
        self.env = {**os.environ, 'TMPDIR': str(self.root), 'TT_TEST_ROOT': str(self.root)}

    def command(self, *args, acp=False):
        filename = 'check-gigacode-acp.zsh' if acp else 'check-gigacode.zsh'
        return [str(REPO / 'scripts' / filename), '--gigacode', str(self.cli), *args]

    def run_probe(self, *args, acp=False, mode=''):
        return subprocess.run(self.command(*args, acp=acp), cwd=self.root,
                              env={**self.env, 'TT_TEST_MODE': mode},
                              capture_output=True, text=True, timeout=20)

    def archive(self, result):
        archives = [line.removeprefix('Archive: ') for line in result.stdout.splitlines()
                    if line.startswith('Archive: ')]
        self.assertEqual(len(archives), 1, result.stdout + result.stderr)
        with tarfile.open(archives[0]) as archive:
            return {member.name: archive.extractfile(member).read().decode()
                    for member in archive.getmembers() if member.isfile()}

    def trace(self):
        return [json.loads(line) for line in (self.root / 'trace.ndjson').read_text().splitlines()]

    def test_core_arguments_parallelism_and_archive(self):
        model_a = 'model A $(not-a-command)'
        result = self.run_probe('--model-a', model_a, '--model-b', 'model B')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stderr, '')
        files = self.archive(result)
        self.assertEqual(files['results/07-created-file.txt'], 'TEAMYTIME_TOOL_OK\n')
        self.assertIn('ORBIT_7319', files['results/04-resume-a.stdout.log'])
        self.assertIn('CEDAR_4826', files['results/05-parallel-b.stdout.log'])
        argv = files['results/03-create-a.argv.txt'].splitlines()
        self.assertEqual(argv[argv.index('--model') + 1], model_a)
        parallel = [row for row in self.trace()
                    if '--resume' in row['args'] and '--append-system-prompt' in row['args']]
        self.assertEqual(len(parallel), 4)
        self.assertLess(max(row['time'] for row in parallel if row['event'] == 'start'),
                        min(row['time'] for row in parallel if row['event'] == 'end'))
        self.assertEqual(len({row['cwd'] for row in self.trace()}), 1)

    def test_cli_failure_skips_dependent_work_but_archives(self):
        result = self.run_probe(mode='fail-b')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        files = self.archive(result)
        self.assertEqual(files['results/03-create-b.exit.txt'], '7\n')
        self.assertIn('results/05-parallel.skipped.txt', files)
        self.assertIn('results/06-partials.stdout.log', files)
        self.assertNotIn('--model', files['results/03-create-a.argv.txt'].splitlines())

    def test_timeout_stops_process_and_saves_marker(self):
        result = self.run_probe('--timeout', '2', mode='timeout-b')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        files = self.archive(result)
        self.assertIn('results/03-create-b.timeout.txt', files)
        self.assertIn('results/05-parallel.skipped.txt', files)
        hung = next(row for row in self.trace() if '--session-id' in row['args']
                    and 'CEDAR_4826' in row['args'][-1])
        with self.assertRaises(ProcessLookupError):
            os.kill(hung['pid'], 0)

    def test_acp_wrapper_sends_request_and_preserves_reply(self):
        result = self.run_probe(acp=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        files = self.archive(result)
        request = json.loads((self.root / 'acp-request.json').read_text())
        self.assertEqual(request['method'], 'initialize')
        self.assertEqual(request['params']['clientCapabilities'], {})
        reply = json.loads(files['results/08-acp.stdout.log'])
        self.assertTrue(reply['result']['agentCapabilities']['loadSession'])
        self.assertIn('results/08-acp.stopped-by-probe.txt', files)

    def test_acp_error_is_retained_for_review(self):
        result = self.run_probe(acp=True, mode='acp-error')
        files = self.archive(result)
        self.assertIn('error', json.loads(files['results/08-acp.stdout.log']))
        self.assertIn('result versus error', files['results/08-acp.observation.txt'])

    def test_interrupt_stops_child_and_archives_partial_results(self):
        proc = subprocess.Popen(self.command(), cwd=self.root,
                                env={**self.env, 'TT_TEST_MODE': 'interrupt'},
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            child = None
            while time.monotonic() < deadline:
                trace = self.root / 'trace.ndjson'
                if trace.exists():
                    child = next((row for row in self.trace()
                                  if '--session-id' in row['args']), None)
                    if child:
                        break
                time.sleep(0.05)
            self.assertIsNotNone(child)
            proc.send_signal(signal.SIGINT)
            stdout, stderr = proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 130, stdout + stderr)
            result = subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)
            self.assertIn('results/interrupted.txt', self.archive(result))
            with self.assertRaises(ProcessLookupError):
                os.kill(child['pid'], 0)
        finally:
            if proc.poll() is None:
                proc.terminate()
            proc.communicate(timeout=10)


if __name__ == '__main__':
    unittest.main()
