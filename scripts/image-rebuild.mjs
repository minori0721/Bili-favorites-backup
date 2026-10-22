import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Node 24's October 2026 security release. Keep the runtime floor in one place.
export const minimumNodeVersion = '24.22.1';

function rebuildBranch(ref) {
  if (ref === 'refs/heads/dev') return 'dev';
  if (ref === 'refs/heads/main') return 'main';
  throw new Error('Image-only rebuilds must select the dev or main branch');
}

export function imageRebuildPlan(env = process.env) {
  const input = env.INPUT_REBUILD_ONLY;
  if (input === undefined || input === '' || input === 'false') return { rebuildOnly: false, tags: [] };
  if (input !== 'true') throw new Error('Invalid image-only rebuild input');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Image-only rebuilds require a manual workflow run');
  const branch = rebuildBranch(env.GITHUB_REF);
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('Invalid rebuild revision');
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(env.IMAGE_NAME ?? '')) throw new Error('Invalid rebuild image name');
  if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new Error('Invalid rebuild run identity');
  }
  const fixedTag = `rebuild-${env.GITHUB_SHA}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  if (fixedTag.length > 128) throw new Error('Rebuild image tag is too long');
  const image = `docker.io/${env.IMAGE_NAME}`;
  return { rebuildOnly: true, tags: [`${image}:${fixedTag}`, `${image}:${branch === 'main' ? 'latest' : 'dev'}`] };
}

export function verifyNodeRuntime(version) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? '');
  const minimum = minimumNodeVersion.split('.').map(Number);
  if (!match || Number(match[1]) !== minimum[0]
    || Number(match[2]) < minimum[1]
    || (Number(match[2]) === minimum[1] && Number(match[3]) < minimum[2])) {
    throw new Error(`Candidate image must use Node ${minimumNodeVersion} or newer within Node ${minimum[0]}; received ${version}`);
  }
  return version;
}

function github(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] });
}

export function isCurrentImageRebuild(env, gh = github) {
  if (!imageRebuildPlan(env).rebuildOnly) throw new Error('Current-branch check requires an image-only rebuild');
  const branch = rebuildBranch(env.GITHUB_REF);
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) throw new Error('Invalid repository');
  const result = JSON.parse(gh(['api', `repos/${env.GITHUB_REPOSITORY}/git/ref/heads/${branch}`]));
  if (result?.ref !== env.GITHUB_REF || result.object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(result.object.sha ?? '')) {
    throw new Error('GitHub returned an invalid rebuild branch ref');
  }
  return result.object.sha === env.GITHUB_SHA;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, version] = process.argv.slice(2);
  if (command === 'configure' && process.argv.length === 3) {
    const plan = imageRebuildPlan();
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `rebuild_only=${plan.rebuildOnly}\ntags<<BFB_REBUILD_TAGS\n${plan.tags.join('\n')}\nBFB_REBUILD_TAGS\n`);
    console.log(plan.rebuildOnly
      ? 'Image-only rebuild: refresh base images, run validation, update only the selected deployment channel and a unique rebuild tag; leave GitHub releases and original image tags unchanged.'
      : 'Regular image publication: existing release and layer consistency rules apply.');
  } else if (command === 'check-current' && process.argv.length === 3) {
    const current = isCurrentImageRebuild(process.env);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`);
    const message = current ? 'Current branch rebuild may promote its verified image.' : 'Skipped outdated image rebuild: deployment tags remain unchanged.';
    console.log(message);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  } else if (command === 'verify-node' && process.argv.length === 4) {
    console.log(`Verified candidate Node runtime: ${verifyNodeRuntime(version)}`);
  } else throw new Error('Usage: node scripts/image-rebuild.mjs configure | check-current | verify-node <version>');
}
