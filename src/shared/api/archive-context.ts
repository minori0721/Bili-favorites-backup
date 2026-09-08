export interface ArchiveContext {
  scope: string; userId: string | null; mediaId: number | null; title: string;
  query: string; searchScope: string; filter: string; sort: string;
}
