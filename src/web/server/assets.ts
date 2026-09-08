import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';

const directory = fileURLToPath(new URL('../../../dist/web/assets/', import.meta.url));
type AssetEntry = {file: string; sha256: string};
export type AssetManifest = {version: 1; script: AssetEntry; style: AssetEntry};
export function createAppAssetService(directory: string) {
let cached: {stamp: number; size: number; manifest: AssetManifest} | undefined;
function readAssetManifest(): AssetManifest {
  const file = path.join(directory, 'manifest.json');
  const stat = fs.statSync(file);
  if (cached?.stamp === stat.mtimeMs && cached.size === stat.size) return cached.manifest;
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) throw new Error('Invalid browser asset manifest');
  for (const kind of ['script','style'] as const) {
    const entry: unknown = Reflect.get(value, kind);
    if (!entry || typeof entry !== 'object') throw new Error('Missing browser asset');
    const file: unknown = Reflect.get(entry, 'file');
    const hash: unknown = Reflect.get(entry, 'sha256');
    const extension = kind === 'script' ? 'js' : 'css';
    if (typeof file !== 'string' || !new RegExp('^app-[A-Z0-9]+\\.' + extension + '$').test(file)
      || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid browser asset entry');
    const actual = createHash('sha256').update(fs.readFileSync(path.join(directory,file))).digest('hex');
    if (actual !== hash) throw new Error('Browser asset integrity mismatch');
  }
  const manifest = value as AssetManifest;
  cached = {stamp:stat.mtimeMs,size:stat.size,manifest};
  return manifest;
}

function renderAppAssets() {
  const manifest = readAssetManifest();
  const error = "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',()=>document.getElementById('appAssetError').hidden=false,{once:true})}else{document.getElementById('appAssetError').hidden=false}";
  return `<link rel="stylesheet" href="/assets/app/${manifest.style.file}" onerror="${error}">\n<script defer src="/assets/app/${manifest.script.file}" onerror="${error}"></script>`;
}

const serveAppAsset: RequestHandler = (req, res, next) => {
  try {
    const name = req.params.name;
    if (typeof name !== 'string' || !/^app-[A-Z0-9]+\.(js|css)$/.test(name)) { res.sendStatus(404); return; }
    res.sendFile(path.join(directory, name), {headers:{'Cache-Control':'private, max-age=31536000, immutable'}}, error => {
      if (error && !res.headersSent) {
        if ('status' in error && error.status === 404) { res.sendStatus(404); return; }
        next(error);
      }
    });
  } catch (error) { next(error); }
};
return {readAssetManifest, renderAppAssets, serveAppAsset};
}

export const {readAssetManifest, renderAppAssets, serveAppAsset} = createAppAssetService(directory);
