export interface ArchiveVideoSource {
  userId: string;
  mediaId: number;
  title: string;
  accountName: string;
  sourceKind: 'favorite' | 'up' | 'manual';
  sourceId: string;
  excluded: boolean;
}
export interface ArchiveVideoActionContext {
  bvid: string;
  title: string;
  current: ArchiveVideoSource;
  sources: ArchiveVideoSource[];
  globalExcluded: boolean;
  cleanup?: {id:string;status:string;fileCount:number;completedCount:number;retainedCount:number;lastError?:string};
}
export interface ArchiveVideoActionPreview {
  previewId: string;
  bvid: string;
  scope: 'source' | 'selected' | 'global';
  effect: 'retain' | 'delete';
  sources: ArchiveVideoSource[];
  retainedSources: ArchiveVideoSource[];
  fileCount: number;
  sharedCount: number;
  totalBytes: number;
  deleteCount: number;
  reclaimableBytes: number;
  confirmation: string;
}
