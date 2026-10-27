import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { verifySecurityDependencyVersions } from '../scripts/image-security-inventory.mjs';

const require = createRequire(import.meta.url);
const patched = {'body-parser': '1.20.9', 'follow-redirects': '1.16.1', 'markdown-it': '15.0.3', qs: '6.16.1'};

test('the shipped runtime dependency checker accepts the installed application dependencies', () => {
  const installed = Object.fromEntries(Object.keys(patched).map(name => [name, require(`${name}/package.json`).version]));
  verifySecurityDependencyVersions(installed);
});

test('the image gate rejects each vulnerable dependency and missing or unreviewed versions', () => {
  for (const [name, version] of Object.entries({'body-parser': '1.20.6', 'follow-redirects': '1.16.0', 'markdown-it': '15.0.1', qs: '6.16.0'})) {
    assert.throws(() => verifySecurityDependencyVersions({...patched, [name]: version}), new RegExp(name));
  }
  for (const version of [undefined, '1.20.9-rc.1', 'broken', '2.4.0', '0.20.99', '1.19.99']) {
    assert.throws(() => verifySecurityDependencyVersions({...patched, 'body-parser': version}), /body-parser/);
  }
  verifySecurityDependencyVersions({...patched, 'body-parser': '1.20.10', 'markdown-it': '15.1.0'});
});
