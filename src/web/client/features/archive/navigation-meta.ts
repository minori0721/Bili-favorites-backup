export function archiveIndexUpdateLabel(value: string, now = new Date()): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const time = date.toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit', hour12:false});
  if (sameDay) return `更新于今天 ${time}`;
  const day = date.toLocaleDateString('zh-CN', {
    ...(date.getFullYear() === now.getFullYear() ? {} : {year:'numeric' as const}), month:'numeric', day:'numeric',
  });
  return `更新于 ${day} ${time}`;
}
