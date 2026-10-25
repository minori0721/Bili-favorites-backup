export function archiveDeletionImpactText(preview: {
  fileCount: number; sharedCount: number; deleteCount?: number; reclaimableBytes?: number;
},formatBytes: (bytes: number) => string) {
  const deleting = preview.deleteCount === undefined ? '实际删除量将在执行前重新核对' : `预计实际删除 ${preview.deleteCount} 个文件`;
  const space = preview.reclaimableBytes === undefined ? '' : `，预计释放 ${formatBytes(preview.reclaimableBytes)}`;
  return `涉及 ${preview.fileCount} 个已追踪文件；共享保留 ${preview.sharedCount} 个。${deleting}${space}。其他来源仍引用的文件不会删除，执行前会再次核验。`;
}
