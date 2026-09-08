import { isRecord } from './value.js';
function record(value: unknown) { if (!isRecord(value)) throw new Error('恢复问题格式错误'); return value; }
function text(value: unknown, required = false) {
  if (value == null && !required) return undefined;
  if (typeof value !== 'string' || (required && !value)) throw new Error('恢复问题文字格式错误');
  return value;
}
function number(value: unknown) {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('恢复问题数值格式错误');
  return value;
}
function flag(value: unknown) {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') throw new Error('恢复问题状态格式错误');
  return value;
}
function texts(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('恢复问题列表格式错误');
  return value.map(item => text(item, true)!);
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  if (value == null) return undefined;
  for (const item of choices) if (value === item) return item;
  throw new Error('恢复问题枚举格式错误');
}
export function parseRecoveryAction(value: unknown) {
  const data = record(value);
  const id = choice(data.id, ['recheck','reupload','create_candidate','redownload','redownload_with_encoding','redownload_with_quality','retry_download','retry_download_with_account','defer_download','keep_existing','use_candidate','retry_quality','retry_quality_with_encoding','retry_quality_with_quality','abandon_attempt','open_settings']);
  if (!id) throw new Error('恢复动作缺少标识');
  const profile = data.mediaProfile == null ? undefined : record(data.mediaProfile);
  if (data.choices != null && !Array.isArray(data.choices)) throw new Error('恢复动作选项格式错误');
  return { id, label: text(data.label, true)!, description: text(data.description) ?? '', danger: flag(data.danger),
    mediaProfile: profile ? { quality: flag(profile.quality), encoding: flag(profile.encoding) } : undefined,
    choices: (Array.isArray(data.choices) ? data.choices : []).map(value => { const item=record(value);return {value:text(item.value,true)!,label:text(item.label,true)!}; }),
  };
}
export function parseRecoveryIssue(value: unknown) {
  const data=record(value);
  if (data.availableActions != null && !Array.isArray(data.availableActions)) throw new Error('恢复动作列表格式错误');
  return {
    id: text(data.id, true)!,
    kind: text(data.kind),
    title: text(data.title),
    summary: text(data.summary),
    bvid: text(data.bvid),
    videoTitle: text(data.videoTitle),
    upperName: text(data.upperName),
    userId: text(data.userId),
    folderTitle: text(data.folderTitle),
    fileName: text(data.fileName),
    requestedEncoding: text(data.requestedEncoding),
    requestedQuality: text(data.requestedQuality),
    lifecycleState: text(data.lifecycleState),
    attemptKey: text(data.attemptKey),
    safeDiagnostic: text(data.safeDiagnostic),
    mediaId: number(data.mediaId),
    expectedSize: number(data.expectedSize),
    observedSize: number(data.observedSize),
    verifiedPages: number(data.verifiedPages),
    totalPages: number(data.totalPages),
    occurredAt: number(data.occurredAt),
    checkedAt: number(data.checkedAt),
    nextAutomaticCheckAt: number(data.nextAutomaticCheckAt),
    encodingMismatch: flag(data.encodingMismatch),
    qualityMismatch: flag(data.qualityMismatch),
    busy: flag(data.busy),
    severity: choice(data.severity, ['info','warning','danger']),
    disposition: choice(data.disposition, ['background','action_required','intentional_confirmation']),
    protectedFacts: texts(data.protectedFacts), actualEncodings: texts(data.actualEncodings), actualQualities: texts(data.actualQualities),
    availableActions: (Array.isArray(data.availableActions) ? data.availableActions : []).map(parseRecoveryAction),
    recommendedAction: data.recommendedAction == null ? undefined : parseRecoveryAction(data.recommendedAction),
  };
}
export type RecoveryIssue = ReturnType<typeof parseRecoveryIssue>;
export type RecoveryAction = ReturnType<typeof parseRecoveryAction>;
export function parseRecoverySummary(value: unknown) {
  const data=record(value);
  return { total:number(data.total) ?? 0, danger:number(data.danger) ?? 0, warning:number(data.warning) ?? 0,
    info:number(data.info) ?? 0, actionRequired:number(data.actionRequired) ?? 0, intentional:number(data.intentional) ?? 0 };
}
