import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReleaseNotes } from '../src/release-notes.js';
import { buildReleaseNotes } from '../scripts/release-notes.mjs';
import { shouldMakeLatest, publishRelease } from '../scripts/publish-release.mjs';

test('release markdown formats content but forbids raw HTML, images and unsafe links', () => {
  const html = renderReleaseNotes('# 标题\n\n- **修复**\n- `代码`\n\n[安全](https://example.com)\n\n' +
    '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n![远端图片](https://example.com/image.png)\n\n' +
    '[危险](javascript:alert(1)) [data](data:text/html,bad) [邮件](mailto:a@b.com) [凭据](https://name:secret@example.com)\n\n```html\n<img src=x>\n```');
  assert.match(html, /<h3>标题<\/h3>/);
  assert.match(html, /<strong>修复<\/strong>/);
  assert.match(html, /<code>代码<\/code>/);
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|data|mailto):|href="https:\/\/name:/i);
  assert.match(html, /&lt;script&gt;/);
});

test('release note extraction uses exactly the version section and rejects mismatches', () => {
  const input = '# 更新日志\r\n## [未发布]\r\nsecret dev work\r\n## [2.5.4] - 2026-09-06\r\n### 修复\r\n- 完成\r\n## [2.5.3] - 2026-08-28\r\nold work';
  const notes = buildReleaseNotes(input, 'v2.5.4', '2.5.4');
  assert.match(notes, /### 修复\n- 完成/);
  assert.match(notes, /bili-favorites-backup:v2.5.4/);
  assert.doesNotMatch(notes, /secret dev|old work/);
  assert.throws(() => buildReleaseNotes(input, 'ffmpeg-1.0.0', '1.0.0'));
  assert.throws(() => buildReleaseNotes(input, 'v2.5.3', '2.5.4'));
  assert.throws(() => buildReleaseNotes('## [2.5.4] - today\n暂无。', 'v2.5.4', '2.5.4'));
  assert.throws(() => buildReleaseNotes(input + '\n## [2.5.4] - again\nwrong', 'v2.5.4', '2.5.4'));
});

test('publishing is idempotent and rerunning an old tag cannot downgrade Latest', () => {
  assert.equal(shouldMakeLatest('v2.9.0', [{ tag_name: 'v2.10.0' }]), false);
  assert.equal(shouldMakeLatest('v2.10.0', [{ tag_name: 'ffmpeg-9.0.0' }, { tag_name: 'v3.0.0', prerelease: true }]), true);
  const calls: string[][] = [];
  publishRelease('v2.9.0', 'notes.md', (args: string[]) => { calls.push(args); return JSON.stringify([[{ tag_name: 'v2.10.0' }]]); });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('--latest=false'));
  assert.ok(calls[1].includes('--verify-tag'));
  const existing: string[][] = [];
  publishRelease('v2.9.0', 'notes.md', (args: string[]) => { existing.push(args); return JSON.stringify([[{ tag_name: 'v2.9.0' }]]); });
  assert.equal(existing.length, 1);
  assert.throws(() => publishRelease('v2.9.0', 'notes.md', () => { throw new Error('network'); }));
});
