/** Public subscription DTOs. Credentials and database objects never cross this boundary. */
export type UpSubscriptionMode = 'all' | 'from_now' | 'from_date' | 'from_video' | 'selected';
export type UpVideoDecision = 'inherit' | 'include' | 'exclude';
export interface UpIdentity { uid: number; name: string; avatar: string; signature: string; followed?: boolean; }
export interface UpDiscoveryPage { items: UpIdentity[]; page: number; pageSize: number; total: number; hasMore: boolean; }
export interface UpSubmission {
  bvid: string; title: string; cover: string; publishedAt: number; ownerUid: number; ownerName: string;
  duration: number | null; joint: boolean;
}
export interface UpSubscription {
  id: string; uid: number; name: string; avatar: string; userId: string; enabled: boolean; removed: boolean;
  mode: UpSubscriptionMode; since: number | null; anchorBvid: string | null; revision: number;
  nextPage: number; historyComplete: boolean; watermark: number; pendingWatermark: number;
  nextScanAt: number; lastScanAt: number | null; lastError: string | null;
  discoveredCount: number; selectedCount: number; excludedCount: number; archivedCount: number;
  accountAvailable?: boolean;
}
export interface UpCatalogItem extends UpSubmission {
  decision: UpVideoDecision; globalExcluded: boolean; selected: boolean;
  archiveStatus: string | null; playable: boolean; otherArchiveAvailable: boolean;
}
export interface UpCatalogPage { items: UpCatalogItem[]; nextCursor: string | null; total: number; }
export interface UpSubscriptionInput {
  uid: number; userId: string; mode: UpSubscriptionMode; since?: number; anchorBvid?: string;
}
export interface UpVideoActionInput {
  scope: 'source' | 'global'; effect: 'retain' | 'delete'; revision: number;
}
export interface UpVideoActionPreview {
  previewId: string; sourceId: string; bvid: string; scope: 'source' | 'global'; effect: 'retain' | 'delete';
  sources: Array<{ userId: string; mediaId: number; title: string }>;
  fileCount: number; sharedCount: number; totalBytes: number; confirmation: string;
}
export interface UpRemovalPreview {
  previewId: string; sourceId: string; revision: number; videoCount: number;
  fileCount: number; sharedCount: number; totalBytes: number; reclaimableBytes: number;
  activeTasks: number; confirmation: string;
}
export interface UpRemovalOperation {
  id: string; sourceId: string; sourceName: string;
  status: 'pending' | 'running' | 'retry_wait' | 'failed' | 'completed';
  fileCount: number; completedCount: number; retainedCount: number; lastError: string | null;
}
