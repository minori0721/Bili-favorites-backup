import { ByteRateLimiter } from './byte-rate-limiter.js';
import { ManagedAria2 } from './managed-aria2.js';
import type { AppConfig } from './config.js';

// Runtime infrastructure is shared across ordinary, manual, quality and recovery transfers.
const engine = new ManagedAria2();
const uploadLimiter = new ByteRateLimiter();
export const downloadTransport: Pick<ManagedAria2, 'acquire'> = engine;
export const uploadBandwidth: Pick<ByteRateLimiter, 'wrap'> = uploadLimiter;
export const shutdownDownloadTransport = (timeoutMs: number) => engine.close(timeoutMs);

export function configureTransferBandwidth(config: Pick<AppConfig, 'downloadLimitMBps' | 'uploadLimitMBps'>) {
  const bytes = (value: number) => value === 0 ? 0 : Math.max(1, Math.floor(value * 1_000_000));
  engine.setBytesPerSecond(bytes(config.downloadLimitMBps));
  uploadLimiter.setBytesPerSecond(bytes(config.uploadLimitMBps));
}
