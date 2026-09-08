import { isRecord } from '../../shared/api.js';

export interface MigrationState {
  id:string;
  status:string;
  sourceRoot:string;
  destinationRoot:string;
  lastError:string;
  entryCount:number;
  verifiedCount:number;
  fileCount:number;
  directoryCount:number;
  totalBytes:number;
  reusableCount:number;
  conflictCount:number;
  extraCount:number;
  failedCount:number;
  progress:{completed:number};
}

function number(value: unknown):number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('迁移响应数值格式错误');
  return value;
}
function text(value: unknown):string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('迁移响应文本格式错误');
  return value;
}
export function parseState(value:unknown):MigrationState | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.status !== 'string') throw new Error('迁移响应格式错误');
  return {id:value.id,status:value.status,sourceRoot:text(value.sourceRoot),destinationRoot:text(value.destinationRoot),lastError:text(value.lastError),
    entryCount:number(value.entryCount),verifiedCount:number(value.verifiedCount),fileCount:number(value.fileCount),directoryCount:number(value.directoryCount),
    totalBytes:number(value.totalBytes),reusableCount:number(value.reusableCount),conflictCount:number(value.conflictCount),extraCount:number(value.extraCount),failedCount:number(value.failedCount),
    progress:{completed:isRecord(value.progress) ? number(value.progress.completed) : 0}};
}

export function parseItems(value:unknown) {
  if (!Array.isArray(value)) throw new Error('迁移项目响应格式错误');
  return value.map((row:unknown) => {
    if (!isRecord(row) || typeof row.migrationId !== 'string' || typeof row.status !== 'string') throw new Error('迁移项目响应格式错误');
    return {migrationId:row.migrationId,status:row.status,relativePath:text(row.relativePath),lastError:text(row.lastError),itemType:text(row.itemType),
      expectedSize:row.expectedSize == null ? undefined : number(row.expectedSize)};
  });
}
