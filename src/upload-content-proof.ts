import type { TransferSessionFileRecord, TransferSessionRecord } from './repositories/transfer-sessions.js';
import { PersistedDomainDecodeError } from './repositories/domain-decoders.js';
import { isRecord } from './shared/api/value.js';

export interface UploadFileContent {
  relativePath: string;
  finalPath: string;
  size: number;
  md5: string;
}
export interface UploadContentProof {
  sessionId: string;
  generation: number;
  files: UploadFileContent[];
}
export interface UploadFileContentRead extends UploadFileContent {
  sessionId: string;
  generation: number;
}

/** Missing historical fingerprints are allowed; malformed supplied evidence is not. */
export function decodeUploadContentProof(value: unknown): UploadContentProof | undefined {
  if (value === undefined) return undefined;
  const invalid = (field: string): never => { throw new PersistedDomainDecodeError('uploadContentProof', field); };
  if (!isRecord(value)) return invalid('expected an object');
  if (typeof value.sessionId !== 'string' || !value.sessionId) return invalid('sessionId');
  if (typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 1) return invalid('generation');
  if (!Array.isArray(value.files) || value.files.length === 0) return invalid('files');
  const seen = new Set<string>();
  const files = value.files.map((entry: unknown, index): UploadFileContent => {
    if (!isRecord(entry)) return invalid(`files[${index}]`);
    const relative = entry.relativePath;
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/')
      || relative.includes('\0') || relative.split('/').some(part => !part || part === '.' || part === '..') || seen.has(relative)) return invalid(`files[${index}].relativePath`);
    seen.add(relative);
    if (typeof entry.finalPath !== 'string' || !entry.finalPath.startsWith('/') || entry.finalPath.includes('\0')
      || entry.finalPath.includes('\\') || entry.finalPath.split('/').some(part => part === '.' || part === '..')) return invalid(`files[${index}].finalPath`);
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size <= 0) return invalid(`files[${index}].size`);
    if (typeof entry.md5 !== 'string' || !/^[a-f0-9]{32}$/i.test(entry.md5)) return invalid(`files[${index}].md5`);
    return { relativePath: relative, finalPath: entry.finalPath, size: entry.size, md5: entry.md5.toLowerCase() };
  });
  return { sessionId: value.sessionId, generation: value.generation, files };
}

export function contentProofForFile(proof: UploadContentProof | undefined,
  session: Pick<TransferSessionRecord, 'id' | 'generation'>,
  file: Pick<TransferSessionFileRecord, 'relativePath' | 'finalPath' | 'expectedSize'>) {
  if (proof?.sessionId !== session.id || proof.generation !== session.generation) return undefined;
  return proof.files.find(entry => entry.relativePath === file.relativePath
    && entry.finalPath === file.finalPath && entry.size === file.expectedSize);
}

export function hasUploadConfirmation(proof: UploadContentProof | undefined, session: Pick<TransferSessionRecord, 'id' | 'generation'>,
  file: TransferSessionFileRecord, confirmedContent: readonly UploadFileContent[] = []) {
  if (file.putAcceptedAt) return true;
  const expected = contentProofForFile(proof, session, file);
  return Boolean(expected && confirmedContent.some(item => item.relativePath === expected.relativePath
    && item.finalPath === expected.finalPath && item.size === expected.size && item.md5 === expected.md5));
}
