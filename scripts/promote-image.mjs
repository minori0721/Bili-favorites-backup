import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const imageNamePattern = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const tagPattern = /^[\w][\w.-]{0,127}$/;

export function promotionTags(image, rawTags) {
  if (typeof rawTags !== 'string') throw new Error('Missing image tags');
  const tags = rawTags.split(/\r?\n/).map(tag => tag.trim()).filter(Boolean);
  if (tags.length === 0 || new Set(tags).size !== tags.length) throw new Error('Missing or duplicate image tags');
  for (const tag of tags) {
    if (!tag.startsWith(`${image}:`) || !tagPattern.test(tag.slice(image.length + 1))) {
      throw new Error(`Unexpected image tag: ${tag}`);
    }
  }
  // Publish aliases first, then release versions, then the mutable deployment channels.
  const rank = tag => /:(?:dev|latest)$/.test(tag) ? 2 : /:v\d+\.\d+\.\d+$/.test(tag) ? 1 : 0;
  return tags.sort((left, right) => rank(left) - rank(right));
}

function docker(args) {
  return execFileSync('docker', ['buildx', 'imagetools', ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 5 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function registryDigest(reference) {
  const manifest = JSON.parse(docker(['inspect', '--format', '{{json .Manifest}}', reference]));
  if (!digestPattern.test(manifest?.digest ?? '')) throw new Error(`Invalid registry digest for ${reference}`);
  return manifest.digest;
}

export async function promoteImage(image, digest, tags, operations = {
  create: (tag, source) => { docker(['create', '--prefer-index=false', '--tag', tag, source]); },
  inspect: registryDigest,
  wait: milliseconds => setTimeout(milliseconds),
}) {
  if (!digestPattern.test(digest ?? '')) throw new Error('Invalid image digest');
  const source = `${image}@${digest}`;
  if (operations.inspect(source) !== digest) throw new Error('Candidate image digest is unavailable');
  for (const tag of tags) {
    let createError;
    try {
      operations.create(tag, source);
    } catch (error) {
      // A registry can accept the tag and still lose the client's response.
      createError = error;
    }
    let published = false;
    let inspectError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (operations.inspect(tag) === digest) { published = true; break; }
        inspectError = undefined;
      } catch (error) {
        inspectError = error;
      }
      if (attempt < 4) await operations.wait(1_000);
    }
    if (!published) throw createError ?? inspectError ?? new Error(`Published tag has a different digest: ${tag}`);
    console.log(`Verified ${tag} -> ${digest}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.env.IMAGE_NAME;
  if (!imageNamePattern.test(name ?? '')) throw new Error('Invalid IMAGE_NAME');
  const image = `docker.io/${name}`;
  await promoteImage(image, process.env.IMAGE_DIGEST, promotionTags(image, process.env.IMAGE_TAGS));
}
