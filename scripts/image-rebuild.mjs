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
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Summary guide / 摘要阅读说明

The build and security tools keep their original reports below. Field meanings / 下方保留构建与安全工具的原始报告，字段含义如下：

| Field / 字段 | Meaning / 含义 |
| --- | --- |
| linux/amd64 | Intel / AMD 64-bit Linux server / 普通 Intel / AMD 64 位 Linux 服务器 |
| Duration | Build time / 本次构建耗时 |
| Cache | Reused build steps; server download reuse is measured separately / 构建时复用了哪些步骤，与服务器拉取时的缓存分别计算 |
| Inputs, tags, labels | Build settings, image names and descriptive metadata / 构建参数、镜像标签及说明信息 |
| Digest, sha256 | Content fingerprint identifying this exact image / 精确辨认这一份镜像的内容指纹 |
| Size | Full image size, not the update download size / 完整镜像大小，更新时的下载量另行计算 |
| Packages | Software components detected in the image / 在镜像中识别到的软件组件数量 |
| C / H / M / L | Critical / High / Medium / Low vulnerability severity / 严重、高危、中危、低危漏洞等级 |
| Artifacts, .dockerbuild | Downloadable security and build records for troubleshooting / 可下载的安全报告和构建排障记录 |

The full vulnerability report includes all known findings. The release gate checks only fixable Critical/High findings; passing it does not mean the full report has no findings.

完整漏洞报告列出所有已知告警；发布门槛只检查已有修复版本的严重、高危漏洞。门槛检查通过时，完整报告中仍可能有其他告警。

`);
  } else if (command === 'check-current' && process.argv.length === 3) {
    const current = isCurrentImageRebuild(process.env);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`);
    const message = current ? 'Current branch rebuild may promote its verified image.' : 'Skipped outdated image rebuild: deployment tags remain unchanged.';
    const translation = current ? '本次仍是当前分支的最新代码，允许发布已验证的重建镜像。'
      : '这次重建对应的代码已过时，跳过发布，部署用的镜像标签保持不变。';
    console.log(message);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n${translation}\n`);
  } else if (command === 'verify-node' && process.argv.length === 4) {
    console.log(`Verified candidate Node runtime: ${verifyNodeRuntime(version)}`);
  } else throw new Error('Usage: node scripts/image-rebuild.mjs configure | check-current | verify-node <version>');
}
