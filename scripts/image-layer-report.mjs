import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

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
  const image = imageName();
  const digest = process.env.IMAGE_DIGEST;
  if (!digestPattern.test(digest ?? '')) throw new Error('Invalid IMAGE_DIGEST');
  const current = readLayers(`${image}@${digest}`, image);
  if (current === null) throw new Error('Published image is missing');
  const previous = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const lines = ['### Image layer reuse', `Published linux/amd64 image: ${current.length} filesystem layers.`];
  if (previous.branchLayers) {
    const comparison = compareLayers(previous.branchLayers, current);
    lines.push(`Compared with previous ${previous.branchTag}: ${comparison.reused}/${comparison.total} layers reused; ${
      (comparison.downloadBytes / 1024 / 1024).toFixed(2)
    } MiB of new compressed layers. Changed layer positions: ${comparison.changedPositions.join(', ') || 'none'}.`);
  } else {
    lines.push('Previous branch image unavailable; no download estimate.');
  }
  let mismatch = false;
  if (previous.sameCommitLayers) {
    mismatch = !compareLayers(previous.sameCommitLayers, current).identical;
    lines.push(mismatch
      ? 'FAIL: An earlier image for the same Git commit has different filesystem layers.'
      : 'PASS: Earlier image for the same Git commit has identical filesystem layers.');
  } else {
    lines.push('No earlier image for this Git commit; cross-ref comparison will run on a later build.');
  }
  const summary = `${lines.join('\n\n')}\n`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (mismatch) throw new Error('Same-commit image layer digests changed; investigate before release.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, snapshotPath] = process.argv.slice(2);
  if (!snapshotPath || !['prepare', 'report'].includes(command)) throw new Error('Usage: image-layer-report.mjs prepare|report SNAPSHOT_PATH');
  if (command === 'prepare') prepare(snapshotPath);
  else report(snapshotPath);
}
