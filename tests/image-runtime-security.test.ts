import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestDir, removeTestDir } from './helpers.js';

const script = fs.readFileSync(new URL('../scripts/check-image-runtime.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const linuxOnly = { skip: process.platform !== 'linux' ? 'requires Linux sh and Debian dpkg' : false };
// Execute the shipped verifier with isolated tool/filesystem observations;
// version ordering still uses the real Debian comparator.
const mocks = String.raw`
test() {
  if [ "$1" = -x ]; then
    [ "$2" != "$MOCK_MISSING_EXECUTABLE" ]
  elif [ "$1" = -e ] && [ "$2" = /usr/local/lib/node_modules/npm ]; then
    [ "$MOCK_NPM_DIRECTORY" = true ]
  else
    /usr/bin/test "$@"
  fi
}
command() {
  [ "$1" = -v ] && [ "$2" = "$MOCK_BUILD_TOOL" ]
}
aria2c() { [ "$MOCK_FAILED_TOOL" != aria2c ]; }
ffmpeg() { [ "$MOCK_FAILED_TOOL" != ffmpeg ]; }
ffprobe() { [ "$MOCK_FAILED_TOOL" != ffprobe ]; }
BBDown() { [ "$MOCK_FAILED_TOOL" != BBDown ]; }
node() { printf '%s\n' 'node component versions'; }
`;
const packageQuery = String.raw`#!/bin/sh
[ "$3" != "$MOCK_MISSING_PACKAGE" ] || exit 1
case "$3" in
  libssl3) printf '%s' "$MOCK_LIBSSL3_VERSION" ;;
  openssl) printf '%s' "$MOCK_OPENSSL_VERSION" ;;
  *) exit 1 ;;
esac
`;

async function verifyRuntime(overrides: Record<string, string> = {}) {
  const dir = await createTestDir('image security ');
  try {
    const scriptFile = path.join(dir, 'verify.sh');
    const mocksFile = path.join(dir, 'mocks.sh');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(scriptFile, script);
    fs.writeFileSync(mocksFile, mocks);
    fs.writeFileSync(path.join(bin, 'dpkg-query'), packageQuery, { mode: 0o755 });
    const result = spawnSync('/bin/sh', ['-ec', '. "$1"; . "$2"', 'verify', mocksFile, scriptFile], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_BUILD_TOOL: '', MOCK_NPM_DIRECTORY: 'false', MOCK_FAILED_TOOL: '',
        MOCK_MISSING_EXECUTABLE: '', MOCK_MISSING_PACKAGE: '',
        MOCK_LIBSSL3_VERSION: '3.0.22-1~deb12u2', MOCK_OPENSSL_VERSION: '3.0.22-1~deb12u2', ...overrides },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  } finally { await removeTestDir(dir); }
}

test('patched and newer Debian OpenSSL packages pass without requiring an exact pin', linuxOnly, async () => {
  for (const version of ['3.0.22-1~deb12u2', '3.0.22-1~deb12u3', '3.0.23-1~deb12u1']) {
    const result = await verifyRuntime({ MOCK_LIBSSL3_VERSION: version, MOCK_OPENSSL_VERSION: version });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified libssl3:/);
    assert.match(result.stdout, /Verified openssl:/);
    assert.match(result.stdout, /node component versions/);
  }
});

test('an old or missing OpenSSL package prevents image acceptance', linuxOnly, async () => {
  const cases: Record<string, string>[] = [
    { MOCK_LIBSSL3_VERSION: '3.0.22-1~deb12u1' },
    { MOCK_OPENSSL_VERSION: '3.0.22-1~deb12u1' },
    { MOCK_LIBSSL3_VERSION: '3.0.20-1~deb12u2' },
    { MOCK_MISSING_PACKAGE: 'libssl3' }, { MOCK_MISSING_PACKAGE: 'openssl' },
  ];
  for (const override of cases) {
    const result = await verifyRuntime(override);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /node component versions/);
  }
});

test('remaining npm or npx, leftover npm modules and missing runtime tools prevent acceptance', linuxOnly, async () => {
  const cases: Record<string, string>[] = [
    { MOCK_BUILD_TOOL: 'npm' }, { MOCK_BUILD_TOOL: 'npx' }, { MOCK_NPM_DIRECTORY: 'true' },
    ...['node', 'ffmpeg', 'ffprobe', 'BBDown'].map(tool => ({ MOCK_MISSING_EXECUTABLE: `/usr/local/bin/${tool}` })),
    { MOCK_MISSING_EXECUTABLE: '/usr/bin/aria2c' },
  ];
  for (const override of cases) {
    const result = await verifyRuntime(override);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Verified libssl3:|node component versions/);
  }
});

test('a runtime executable that cannot start prevents acceptance even when its file exists', linuxOnly, async () => {
  for (const tool of ['aria2c', 'ffmpeg', 'ffprobe', 'BBDown']) {
    const result = await verifyRuntime({ MOCK_FAILED_TOOL: tool });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /node component versions/);
  }
});
