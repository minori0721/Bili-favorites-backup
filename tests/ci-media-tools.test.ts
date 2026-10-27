import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestDir, removeTestDir } from './helpers.js';

const workflow = fs.readFileSync(new URL('../.github/workflows/docker-publish.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const step = workflow.split('      - name: Check media and resume tools\n')[1]?.split('\n      - name: ')[0];
assert.ok(step, 'test the actual media tool installation step');
const run = step.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');

// Only the external tools are replaced. Bash executes the real workflow body,
// including errexit, the timeout process group, source selection and cleanup.
const mocks = String.raw`
command() {
  if [[ "$1" == -v ]]; then
    case "$2" in
      ffmpeg|ffprobe) [[ -f "$MOCK_ROOT/$2-installed" ]] || return 1 ;;
    esac
  fi
  builtin command "$@"
}
sudo() { "$@"; }
timeout() {
  printf '%s\n' "$*" >> "$MOCK_ROOT/timeouts"
  shift 2
  /usr/bin/timeout --kill-after=0.2s 2s "$@"
}
apt-get() {
  local sources mirror phase arg
  for arg in "$@"; do
    case "$arg" in Dir::Etc::sourcelist=*) sources=$(printf '%s' "$arg" | sed 's/^[^=]*=//') ;; esac
  done
  mirror=$(sed -n 's/^URIs: //p' "$sources")
  cp "$sources" "$MOCK_ROOT/source-used"
  if [[ " $* " == *' update '* ]]; then phase=update
  elif [[ " $* " == *' --download-only '* ]]; then phase=download
  elif [[ " $* " == *' --no-download '* ]]; then phase=install
  else return 99
  fi
  printf '%s|%s|%s\n' "$mirror" "$phase" "$*" >> "$MOCK_ROOT/calls"
  case "$MOCK_FAILURE:$mirror:$phase" in
    primary-update:https://archive.ubuntu.com/ubuntu/:update) return 100 ;;
    primary-download:https://archive.ubuntu.com/ubuntu/:download) return 100 ;;
    primary-timeout:https://archive.ubuntu.com/ubuntu/:download) sleep 5 ;;
    both:*:download|install:*:install) return 100 ;;
  esac
  if [[ "$phase" == install ]]; then
    touch "$MOCK_ROOT/ffmpeg-installed" "$MOCK_ROOT/ffprobe-installed"
  fi
}
ffmpeg() { echo 'ffmpeg mock'; }
ffprobe() { echo 'ffprobe mock'; }
aria2c() { echo 'aria2 mock'; }
`;

async function checkTools(failure = '', installed: string[] = []) {
  const dir = await createTestDir('ci-media-tools ');
  const script = path.join(dir, 'step.sh');
  const bashEnv = path.join(dir, 'mocks.sh');
  try {
    fs.writeFileSync(script, run);
    fs.writeFileSync(bashEnv, mocks);
    for (const tool of installed) fs.writeFileSync(path.join(dir, `${tool}-installed`), '');
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      env: { ...process.env, BASH_ENV: bashEnv, RUNNER_TEMP: dir, MOCK_ROOT: dir, MOCK_FAILURE: failure },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    const read = (file: string) => fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : '';
    return { ...result, calls: read('calls').trim().split('\n').filter(Boolean), timeouts: read('timeouts'), source: read('source-used'), remaining: fs.readdirSync(dir) };
  } finally { await removeTestDir(dir); }
}

const linuxOnly = { skip: process.platform !== 'linux' ? 'requires Linux Bash and GNU timeout' : false };
const primary = 'https://archive.ubuntu.com/ubuntu/';
const fallback = 'https://mirrors.edge.kernel.org/ubuntu/';
const phases = (calls: string[]) => calls.map(call => call.split('|').slice(0, 2).join('|'));

test('media tools download from the official mirror and install offline after download succeeds', linuxOnly, async () => {
  const result = await checkTools();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(phases(result.calls), [`${primary}|update`, `${primary}|download`, `${primary}|install`]);
  assert.match(result.source, /Suites: noble noble-updates noble-backports noble-security/);
  assert.match(result.source, /Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring.gpg/);
  assert.ok(result.calls.every(call => call.includes('Dir::Etc::sourceparts=-')));
  assert.ok(result.calls.filter(call => !call.includes('|update|')).every(call => call.includes('--no-install-recommends')));
  assert.match(result.timeouts, /^--kill-after=15s 180s /);
  assert.ok(!result.remaining.some(file => file.endsWith('.sources')), 'temporary sources must be removed');
});

test('failed metadata or package downloads switch to the backup mirror exactly once', linuxOnly, async () => {
  for (const failure of ['primary-update', 'primary-download', 'primary-timeout']) {
    const result = await checkTools(failure);
    assert.equal(result.status, 0, `${failure}: ${result.stderr}`);
    assert.deepEqual(phases(result.calls), [
      `${primary}|update`, ...(failure === 'primary-update' ? [] : [`${primary}|download`]),
      `${fallback}|update`, `${fallback}|download`, `${fallback}|install`,
    ]);
    assert.equal(result.timeouts.split('--kill-after=15s 180s').length - 1, 2);
    if (failure === 'primary-timeout') assert.match(result.stdout, /exit 124/);
  }
});

test('two failed mirrors stop the step without installing or reporting tool success', linuxOnly, async () => {
  const result = await checkTools('both');
  assert.equal(result.status, 100, result.stderr);
  assert.deepEqual(phases(result.calls), [`${primary}|update`, `${primary}|download`, `${fallback}|update`, `${fallback}|download`]);
  assert.match(result.stdout, /Both Ubuntu mirrors failed/);
  assert.doesNotMatch(result.stdout, /ffmpeg mock|ffprobe mock/);
  assert.ok(!result.remaining.some(file => file.endsWith('.sources')));
});

test('an offline installation failure propagates without retrying or interrupting dpkg', linuxOnly, async () => {
  const result = await checkTools('install');
  assert.equal(result.status, 100, result.stderr);
  assert.deepEqual(phases(result.calls), [`${primary}|update`, `${primary}|download`, `${primary}|install`]);
  assert.equal(result.timeouts.split('--kill-after=15s 180s').length - 1, 1);
  assert.doesNotMatch(result.stdout, /ffmpeg mock|ffprobe mock/);
});

test('existing tools skip APT; a missing ffprobe still requires installation', linuxOnly, async () => {
  const installed = await checkTools('', ['ffmpeg', 'ffprobe']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(installed.calls, []);
  assert.equal(installed.timeouts, '');
  assert.match(installed.stdout, /ffmpeg mock/);
  const incomplete = await checkTools('', ['ffmpeg']);
  assert.equal(incomplete.status, 0, incomplete.stderr);
  assert.deepEqual(phases(incomplete.calls), [`${primary}|update`, `${primary}|download`, `${primary}|install`]);
});
