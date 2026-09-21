import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { publishAsset } from './publish-asset.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const assetDirectory = path.join(root, 'dist/web/assets');

export async function buildWeb({ watch = false } = {}) {
  const options = {
    absWorkingDir: root,
    entryPoints: ['src/web/client/bootstrap.ts'],
    outdir: assetDirectory,
    entryNames: 'app-[hash]',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    charset: 'utf8',
    write: false,
    minify: false,
    plugins: [{
      name: 'publish-complete-assets',
      setup(build) {
        build.onEnd(async result => {
          if (result.errors.length) return;
          await fs.mkdir(assetDirectory, {recursive:true});
          const entries = {};
          for (const output of result.outputFiles) {
            const name = path.basename(output.path);
            await publishAsset(output.path, output.contents);
            const kind = name.endsWith('.js') ? 'script' : name.endsWith('.css') ? 'style' : null;
            if (kind) entries[kind] = {file:name, sha256:createHash('sha256').update(output.contents).digest('hex')};
          }
          if (!entries.script || !entries.style) throw new Error('Incomplete browser build');
          // Publish only after both content-addressed resources exist.
          await publishAsset(path.join(assetDirectory, 'manifest.json'), JSON.stringify({version:1,...entries}, null, 2));
        });
      },
    }],
  };
  if (watch) {
    const context = await esbuild.context(options);
    try {
      await context.rebuild();
      await context.watch();
      return context;
    } catch (error) {
      await context.dispose();
      throw error;
    }
  }
  await esbuild.build(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildWeb();
