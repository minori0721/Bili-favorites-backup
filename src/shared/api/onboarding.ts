import { isRecord, ResponseFormatError } from './value.js';

export const ONBOARDING_MARKER = 'first_run_onboarding_v1';

export function parseOnboardingStatus(value: unknown): { autoStart: boolean } {
  if (!isRecord(value) || typeof value.autoStart !== 'boolean') throw new ResponseFormatError('使用引导状态格式错误');
  return { autoStart: value.autoStart };
}
