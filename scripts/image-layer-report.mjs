import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { imageRebuildPlan } from './image-rebuild.mjs';

const digestPattern = /^sha256:[0-9a-f]{64}$/;

function inspect(reference) {
  try {
    return JSON.parse(execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 5 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    const stderr = String(error?.stderr ?? '');
    if (/manifest unknown|not found|no such manifest/i.test(stderr)) return null;
    throw new Error(`Unable to inspect image manifest for ${reference}`, { cause: error });
  }
}

export function platformLayers(manifest, image, inspectManifest) {
  if (Array.isArray(manifest?.manifests)) {
    const candidates = manifest.manifests.filter(entry => entry?.platform?.os === 'linux' && entry.platform.architecture === 'amd64');
    if (candidates.length !== 1 || !digestPattern.test(candidates[0].digest)) throw new Error('Expected one linux/amd64 image manifest');
    manifest = inspectManifest(`${image}@${candidates[0].digest}`);
  }
  if (!Array.isArray(manifest?.layers) || manifest.layers.length === 0) throw new Error('Image has no filesystem layers');
  return manifest.layers.map((layer, index) => {
    if (!digestPattern.test(layer?.digest) || !Number.isSafeInteger(layer.size) || layer.size < 0) {
      throw new Error(`Invalid filesystem layer ${index + 1}`);
    }
    return { digest: layer.digest, size: layer.size };
  });
}

export function compareLayers(previous, current) {
  const known = new Set(previous.map(layer => layer.digest));
  const newDigests = new Set();
  const missing = current.filter(layer => {
    if (known.has(layer.digest) || newDigests.has(layer.digest)) return false;
    newDigests.add(layer.digest);
    return true;
  });
  return {
    reused: current.filter(layer => known.has(layer.digest)).length,
    total: current.length,
    downloadBytes: missing.reduce((sum, layer) => sum + layer.size, 0),
    changedPositions: current.flatMap((layer, index) => previous[index]?.digest === layer.digest ? [] : [index + 1]),
    identical: previous.length === current.length && current.every((layer, index) => previous[index].digest === layer.digest),
  };
}

export function cacheDestinations(ref, image) {
  const branch = ref === 'refs/heads/dev' ? 'dev' : ref === 'refs/heads/main' ? 'main' : null;
  return ['type=gha,mode=max', ...(branch ? [`type=registry,ref=${image}:buildcache-${branch},mode=max`] : [])];
}

export function sameCommitLayerCheck(previous, current, rebuildOnly) {
  if (previous === null) return { failed: false, message: 'No earlier image for this Git commit; cross-ref comparison will run on a later build.',
    translation: '未找到同一提交的旧镜像可比较；以后在其他分支或标签构建同一份代码时再核对一致性。' };
  if (compareLayers(previous, current).identical) return { failed: false, message: 'PASS: Earlier image for the same Git commit has identical filesystem layers.',
    translation: '通过：与同一份代码之前构建的镜像相比，全部文件层一致。' };
  if (rebuildOnly) return { failed: false, message: 'ALLOWED: Explicit manual image-only rebuild changed filesystem layers; original revision and version image tags remain unchanged.',
    translation: '允许：本次明确执行了仅重建镜像，基础环境更新可以改变文件层；原有提交标签和版本标签保持不变。' };
  return { failed: true, message: 'FAIL: An earlier image for the same Git commit has different filesystem layers.',
    translation: '失败：同一份代码前后构建出的文件层不一致，需要检查原因，本次停止发布。' };
}

function readLayers(reference, image) {
  const manifest = inspect(reference);
  if (manifest === null) return null;
  return platformLayers(manifest, image, reference => {
    const child = inspect(reference);
    if (child === null) throw new Error(`Referenced platform manifest is missing: ${reference}`);
    return child;
  });
}

function imageName() {
  const name = process.env.IMAGE_NAME;
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(name ?? '')) throw new Error('Invalid IMAGE_NAME');
  return `docker.io/${name}`;
}

function prepare(output) {
  imageRebuildPlan(); // Reject an invalid rebuild request before querying the registry.
  const image = imageName();
  const ref = process.env.GITHUB_REF;
  const sha = process.env.GITHUB_SHA;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('Invalid GITHUB_SHA');
  const branch = ref === 'refs/heads/dev' ? 'dev' : ref === 'refs/heads/main' ? 'main' : null;
  const branchTag = branch === 'main' ? 'latest' : branch;
  const snapshot = {
    branchTag,
    branchLayers: branchTag ? readLayers(`${image}:${branchTag}`, image) : null,
    sameCommitLayers: readLayers(`${image}:revision-${sha}`, image),
  };
  fs.writeFileSync(output, JSON.stringify(snapshot));
  const cacheTo = cacheDestinations(ref, image);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `cache_to<<BFB_CACHE_END\n${cacheTo.join('\n')}\nBFB_CACHE_END\n`);
  console.log(`Captured ${branchTag ?? 'no branch'} baseline; same-commit image ${snapshot.sameCommitLayers ? 'found' : 'not found'}.`);
}

function report(snapshotPath) {
  const plan = imageRebuildPlan();
  const image = imageName();
  const digest = process.env.IMAGE_DIGEST;
  if (!digestPattern.test(digest ?? '')) throw new Error('Invalid IMAGE_DIGEST');
  const current = readLayers(`${image}@${digest}`, image);
  if (current === null) throw new Error('Published image is missing');
  const previous = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const lines = ['### Image layer reuse', '镜像层复用情况',
    `Published linux/amd64 image: ${current.length} filesystem layers.`,
    `本次 linux/amd64 镜像由 ${current.length} 个文件层组成，适用于普通 Intel / AMD 64 位 Linux 服务器。`];
  if (previous.branchLayers) {
    const comparison = compareLayers(previous.branchLayers, current);
    lines.push(`Compared with previous ${previous.branchTag}: ${comparison.reused}/${comparison.total} layers reused; ${
      (comparison.downloadBytes / 1024 / 1024).toFixed(2)
    } MiB of new compressed layers. Changed layer positions: ${comparison.changedPositions.join(', ') || 'none'}.`);
    lines.push(`与 Docker Hub 上之前的 ${previous.branchTag} 镜像相比，${comparison.reused}/${comparison.total} 层内容相同；新增压缩层共 ${
      (comparison.downloadBytes / 1024 / 1024).toFixed(2)
    } MiB。发生变化的层序号：${comparison.changedPositions.join(', ') || '无'}。`);
    lines.push('Note: This compares registry layer contents. Actual download size also depends on the installed version, local cache and Docker storage backend.',
      '说明：这里比较的是仓库镜像的层内容；服务器实际下载量还取决于已安装版本、本地缓存和 Docker 的存储方式。');
  } else {
    lines.push('Previous branch image unavailable; no download estimate.');
    lines.push('暂时无法取得之前的分支镜像，本次不估算新增层大小。');
  }
  const check = sameCommitLayerCheck(previous.sameCommitLayers, current, plan.rebuildOnly);
  lines.push(check.message, check.translation);
  const summary = `${lines.join('\n\n')}\n`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (check.failed) throw new Error('Same-commit image layer digests changed; investigate before release.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, snapshotPath] = process.argv.slice(2);
  if (!snapshotPath || !['prepare', 'report'].includes(command)) throw new Error('Usage: image-layer-report.mjs prepare|report SNAPSHOT_PATH');
  if (command === 'prepare') prepare(snapshotPath);
  else report(snapshotPath);
}
