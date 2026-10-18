import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isCurrentDevBuild, publishDevPreview, type DevPreviewBuild } from '../scripts/publish-dev-preview.mjs';
import { buildDevPreviewNotes, buildImageNotes } from '../scripts/release-notes.mjs';
import { createTestDir, removeTestDir } from './helpers.js';

const revision = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const oldRevision = 'c'.repeat(40);
const build = {
  repository: 'owner/app', revision, ref: 'refs/heads/dev', image: 'docker.io/owner/app', digest,
  runId: '42', runAttempt: '2', updatedAt: '2026-10-18T16:00:00.000Z',
} satisfies DevPreviewBuild;
const developing = '# 更新日志\n## [Unreleased]\n### 发布摘要\n- 订阅功能\n### 新增\n- 完整实现细节\n### 升级提醒\n配置代理来源。\n## [2.6.5] - 2026-10-05\n- 旧内容';
const prepared = '## [Unreleased]\n## [2.7.0] - 2026-10-19\n### 发布摘要\n- 正式准备摘要\n### 修复\n- 完整细节\n### 升级与回滚\n- 保留备份';

interface Release {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  immutable: boolean;
  name: string;
  body: string;
}

interface Ref {
  ref: string;
  object: { type: string; sha: string };
}

function fakePublication(initial?: { release?: Partial<Release>; ref?: Ref }) {
  const calls: string[][] = [];
  const inspections: string[] = [];
  const releases: Release[] = initial?.release ? [{
    tag_name: 'dev-preview', prerelease: true, draft: false, immutable: false, name: 'old', body: 'old notes', ...initial.release,
  }] : [];
  const refs: Ref[] = initial?.ref ? [initial.ref] : [];
  const operations = {
    inspect(reference: string) {
      inspections.push(reference);
      return digest;
    },
    gh(args: string[]) {
      calls.push(args);
      const field = (flag: string) => {
        const index = args.indexOf(flag);
        assert.ok(index >= 0, `missing ${flag}`);
        return args[index + 1];
      };
      if (args[0] === 'release') {
        assert.equal(args[2], 'dev-preview');
        assert.equal(field('--repo'), build.repository);
        assert.ok(args.includes('--prerelease'));
        assert.ok(args.includes('--latest=false'));
        if (args[1] === 'create') {
          assert.equal(releases.length, 0);
          assert.ok(args.includes('--verify-tag'));
          releases.push({ tag_name: 'dev-preview', prerelease: true, draft: false, immutable: false, name: '', body: '' });
        } else assert.equal(args[1], 'edit');
        assert.equal(refs[0]?.object.sha, revision, 'tag must point at the passed build before publication');
        releases[0].name = field('--title');
        releases[0].body = fs.readFileSync(field('--notes-file'), 'utf8');
        return '';
      }
      assert.equal(args[0], 'api');
      if (args.includes('--method')) {
        const method = field('--method');
        const sha = args.find(arg => arg.startsWith('sha='))?.slice(4);
        assert.equal(sha, revision);
        if (method === 'POST') {
          assert.ok(args.includes('repos/owner/app/git/refs'));
          assert.ok(args.includes('ref=refs/tags/dev-preview'));
          assert.equal(refs.length, 0);
          refs.push({ ref: 'refs/tags/dev-preview', object: { type: 'commit', sha: revision } });
        } else {
          assert.equal(method, 'PATCH');
          assert.ok(args.includes('repos/owner/app/git/refs/tags/dev-preview'));
          assert.ok(args.includes('force=true'));
          refs[0].object.sha = revision;
        }
        return '{}';
      }
      switch (args[1]) {
        case 'repos/owner/app/releases?per_page=100':
          assert.ok(args.includes('--paginate') && args.includes('--slurp'));
          // Include an unrelated stable release on a separate page.
          return JSON.stringify([[{ tag_name: 'v2.6.5', prerelease: false }], releases]);
        case 'repos/owner/app/git/matching-refs/tags/dev-preview':
          return JSON.stringify([{ ref: 'refs/tags/dev-preview-other', object: { type: 'tag', sha: oldRevision } }, ...refs]);
        case 'repos/owner/app/releases/tags/dev-preview': return JSON.stringify(releases[0]);
        case 'repos/owner/app/git/ref/tags/dev-preview': return JSON.stringify(refs[0]);
        default: throw new Error(`Unexpected GitHub command: ${args.join(' ')}`);
      }
    },
  };
  return { calls, inspections, operations, refs, releases };
}

test('preview notes use the development summary and preserve upgrade cautions without advertising a stable image', () => {
  const notes = buildDevPreviewNotes(developing, '2.7.0-dev');
  assert.match(notes, /订阅功能/);
  assert.match(notes, /配置代理来源/);
  assert.doesNotMatch(notes, /完整实现细节|旧内容|bili-favorites-backup:v/);
  const legacy = developing.replace('### 发布摘要\n- 订阅功能\n', '');
  assert.match(buildDevPreviewNotes(legacy, '2.7.0-dev'), /完整实现细节/);
  for (const body of ['', '### 发布摘要\n暂无。\n### 新增\n- 暂无。']) {
    assert.equal(buildDevPreviewNotes(`## [Unreleased]\n${body}\n## [2.7.0] - today\n- Previous`, '2.7.1-dev'), '暂无未发布变更。');
  }
  const release = buildDevPreviewNotes(prepared, '2.7.0');
  assert.match(release, /正式发布准备构建/);
  assert.match(release, /正式准备摘要/);
  assert.match(release, /保留备份/);
  assert.doesNotMatch(release, /完整细节|bili-favorites-backup:v/);
});

test('invalid preview summaries fail the same pre-build validation used by CI', () => {
  for (const input of [
    developing.replace('- 订阅功能', '暂无。'),
    developing.replace('### 新增', '### 发布摘要'),
    developing.replace('配置代理来源。', ''),
  ]) {
    assert.throws(() => buildImageNotes(input, '2.7.0-dev', 'refs/heads/dev'));
    assert.throws(() => buildDevPreviewNotes(input, '2.7.0-dev'));
  }
  assert.throws(() => buildDevPreviewNotes(developing, '2.7.0-beta'));
  assert.throws(() => buildDevPreviewNotes(developing, '2.6.5-dev'));
});

test('the dev publication gate checks the real branch identity and rejects malformed evidence and other refs', () => {
  const gh = (sha: string) => (args: string[]) => {
    assert.deepEqual(args, ['api', 'repos/owner/app/git/ref/heads/dev']);
    return JSON.stringify({ ref: 'refs/heads/dev', object: { type: 'commit', sha } });
  };
  assert.equal(isCurrentDevBuild(build, gh(revision)), true);
  assert.equal(isCurrentDevBuild(build, gh(oldRevision)), false);
  for (const ref of ['refs/heads/main', 'refs/tags/v2.7.0', 'refs/tags/dev-preview', 'refs/heads/feature']) {
    assert.throws(() => isCurrentDevBuild({ ...build, ref }, () => { assert.fail('must not query another ref'); }));
  }
  for (const value of [{}, { ref: 'refs/heads/main', object: { type: 'commit', sha: revision } },
    { ref: 'refs/heads/dev', object: { type: 'tag', sha: revision } },
    { ref: 'refs/heads/dev', object: { type: 'commit', sha: 'bad' } }]) {
    assert.throws(() => isCurrentDevBuild(build, () => JSON.stringify(value)));
  }
  assert.throws(() => isCurrentDevBuild(build, () => { throw new Error('GitHub unavailable'); }), /GitHub unavailable/);
});

test('a first successful dev image creates one prerelease with exact revision, digest, notes and workflow attempt', async () => {
  const directory = await createTestDir('dev-preview');
  try {
    const fake = fakePublication();
    const file = path.join(directory, 'notes.md');
    assert.match(publishDevPreview(build, developing, '2.7.0-dev', file, fake.operations), /Verified development preview/);
    assert.deepEqual(fake.inspections, [`${build.image}:dev`, `${build.image}:revision-${revision}`]);
    assert.deepEqual(fake.calls.filter(call => call.includes('--method')).map(call => call[2]), ['POST']);
    assert.equal(fake.releases.length, 1);
    assert.equal(fake.releases[0].name, 'BFB 开发预览 · 2.7.0-dev');
    const notes = fs.readFileSync(file, 'utf8');
    assert.equal(fake.releases[0].body, notes);
    for (const value of [digest, revision, build.updatedAt, ':dev', '/actions/runs/42/attempts/2', `/blob/${revision}/CHANGELOG.md`, '配置代理来源']) {
      assert.ok(notes.includes(value), value);
    }
    assert.doesNotMatch(notes, /完整实现细节|旧内容|:v2\.7\.0/);
    // Rerunning updates the same page and does not recreate or move its tag.
    fake.calls.length = 0;
    publishDevPreview(build, developing, '2.7.0-dev', file, fake.operations);
    assert.ok(fake.calls.some(call => call[0] === 'release' && call[1] === 'edit'));
    assert.equal(fake.calls.filter(call => call.includes('--method')).length, 0);
    assert.equal(fake.releases.length, 1);
  } finally { await removeTestDir(directory); }
});

test('updating a preview moves only the rolling tag and repairs a failed release update on retry', async () => {
  const directory = await createTestDir('dev-preview-retry');
  try {
    const fake = fakePublication({ release: {}, ref: { ref: 'refs/tags/dev-preview', object: { type: 'commit', sha: oldRevision } } });
    const file = path.join(directory, 'notes.md');
    const broken = { ...fake.operations, gh(args: string[]) {
      if (args[0] === 'release') throw new Error('Release API timeout');
      return fake.operations.gh(args);
    } };
    assert.throws(() => publishDevPreview(build, developing, '2.7.0-dev', file, broken), /Release API timeout/);
    assert.equal(fake.refs[0].object.sha, revision);
    assert.equal(fake.releases[0].body, 'old notes');
    fake.calls.length = 0;
    publishDevPreview(build, developing, '2.7.0-dev', file, fake.operations);
    assert.equal(fake.calls.filter(call => call.includes('--method')).length, 0);
    assert.match(fake.releases[0].body, /订阅功能/);
    assert.ok(fake.calls.every(call => !call.some(arg => arg.includes('/git/refs/tags/v'))));
  } finally { await removeTestDir(directory); }
});

test('changed channels, missing revision images and registry failures never update the preview', async () => {
  const directory = await createTestDir('dev-preview-image');
  try {
    const file = path.join(directory, 'notes.md');
    const fake = fakePublication();
    assert.match(publishDevPreview(build, developing, '2.7.0-dev', file, { ...fake.operations, inspect: () => `sha256:${'c'.repeat(64)}` }), /Skipped/);
    assert.throws(() => publishDevPreview(build, developing, '2.7.0-dev', file, { ...fake.operations,
      inspect: reference => reference.endsWith(':dev') ? digest : `sha256:${'c'.repeat(64)}` }), /Revision image/);
    assert.throws(() => publishDevPreview(build, developing, '2.7.0-dev', file, { ...fake.operations, inspect: () => { throw new Error('Registry offline'); } }), /Registry offline/);
    assert.equal(fake.calls.length, 0);
    assert.equal(fs.existsSync(file), false);
  } finally { await removeTestDir(directory); }
});

test('formal, draft and immutable pages and annotated tags require review before any remote mutation', async () => {
  const directory = await createTestDir('dev-preview-protection');
  try {
    for (const release of [{ prerelease: false }, { draft: true }, { immutable: true }]) {
      const fake = fakePublication({ release });
      assert.throws(() => publishDevPreview(build, developing, '2.7.0-dev', path.join(directory, 'notes.md'), fake.operations), /review/);
      assert.equal(fake.calls.filter(call => call[0] === 'release' || call.includes('--method')).length, 0);
    }
    const fake = fakePublication({ ref: { ref: 'refs/tags/dev-preview', object: { type: 'tag', sha: oldRevision } } });
    assert.throws(() => publishDevPreview(build, developing, '2.7.0-dev', path.join(directory, 'notes.md'), fake.operations), /not a commit ref/);
    assert.equal(fake.calls.filter(call => call[0] === 'release' || call.includes('--method')).length, 0);
  } finally { await removeTestDir(directory); }
});

test('malformed publication metadata and failed notes writes cannot move a tag', async () => {
  const directory = await createTestDir('dev-preview-input');
  try {
    for (const change of [{ ref: 'refs/heads/main' }, { repository: '' }, { revision: 'bad' }, { image: 'evil/owner/app' },
      { digest: 'bad' }, { runId: '0' }, { runAttempt: 'x' }, { updatedAt: 'bad' }]) {
      const fake = fakePublication();
      assert.throws(() => publishDevPreview({ ...build, ...change }, developing, '2.7.0-dev', path.join(directory, 'notes.md'), fake.operations));
      assert.equal(fake.calls.length, 0);
    }
    const fake = fakePublication();
    assert.throws(() => publishDevPreview(build, developing, '2.7.0-dev', directory, fake.operations));
    assert.equal(fake.calls.filter(call => call[0] === 'release' || call.includes('--method')).length, 0);
  } finally { await removeTestDir(directory); }
});

test('GitHub errors and incorrect publication readback are reported as failures', async () => {
  const directory = await createTestDir('dev-preview-evidence');
  try {
    for (const stage of ['list', 'tag', 'verify']) {
      const fake = fakePublication();
      const operations = { ...fake.operations, gh(args: string[]) {
        if (stage === 'list' && args[1]?.endsWith('/releases?per_page=100')) throw new Error('GitHub unavailable');
        if (stage === 'tag' && args.includes('--method')) throw new Error('Tag update failed');
        const response = fake.operations.gh(args);
        if (stage === 'verify' && args[1]?.endsWith('/releases/tags/dev-preview')) return JSON.stringify({ ...fake.releases[0], body: 'outdated notes' });
        return response;
      } };
      assert.throws(() => publishDevPreview(build, developing, '2.7.0-dev', path.join(directory, 'notes.md'), operations),
        stage === 'list' ? /GitHub unavailable/ : stage === 'tag' ? /Tag update failed/ : /does not match this build/);
      if (stage !== 'verify') assert.equal(fake.releases.length, 0);
    }
  } finally { await removeTestDir(directory); }
});
