import { isRecord } from '../../shared/api.js';
export function parseSettings(value: unknown) {
    if (!isRecord(value))
        throw new Error('设置响应格式错误');
    function text(key: string): string {
        const item = value && isRecord(value) ? value[key] : undefined;
        if (item === undefined || item === null)
            return '';
        if (typeof item !== 'string')
            throw new Error('设置字段格式错误: ' + key);
        return item;
    }
    function number(key: string): number | undefined {
        const item = value && isRecord(value) ? value[key] : undefined;
        if (item === undefined || item === null)
            return undefined;
        if (typeof item !== 'number' || !Number.isFinite(item))
            throw new Error('设置字段格式错误: ' + key);
        return item;
    }
    function boolean(key: string): boolean {
        const item = value && isRecord(value) ? value[key] : undefined;
        if (item === undefined || item === null)
            return false;
        if (typeof item !== 'boolean')
            throw new Error('设置字段格式错误: ' + key);
        return item;
    }
    return {
        pollIntervalMinutes: number('pollIntervalMinutes'),
        perVideoDelaySeconds: number('perVideoDelaySeconds'),
        uploadLayout: text('uploadLayout'),
        alistUrl: text('alistUrl'),
        alistBrowserUrl: text('alistBrowserUrl'),
        alistUsername: text('alistUsername'),
        alistPassword: text('alistPassword'),
        alistDest: text('alistDest'),
        playbackDeliveryMode: text('playbackDeliveryMode'),
        bbdownEncoding: text('bbdownEncoding'),
        bbdownQuality: text('bbdownQuality'),
        maxRetries: number('maxRetries'),
        retryDelaySeconds: number('retryDelaySeconds'),
        concurrentDownloads: number('concurrentDownloads'),
        concurrentUploads: number('concurrentUploads'),
        uploadFileIntervalSeconds: number('uploadFileIntervalSeconds'),
        localCacheLimitGB: number('localCacheLimitGB'),
        onlineCoverCacheLimitMB: number('onlineCoverCacheLimitMB'),
        queuePrefetchLimit: number('queuePrefetchLimit'),
        remoteVerifyConcurrency: number('remoteVerifyConcurrency'),
        remoteVerifyRateLimitPerSecond: number('remoteVerifyRateLimitPerSecond'),
        remoteRequeueLimitPerCycle: number('remoteRequeueLimitPerCycle'),
        filenameTemplate: text('filenameTemplate'),
        renameScanMaxFiles: number('renameScanMaxFiles'),
        bbdownApiMode: text('bbdownApiMode'),
        bbdownHiRes: boolean('bbdownHiRes'),
        bbdownDolby: boolean('bbdownDolby'),
        bbdownEncodingPriority: value.bbdownEncodingPriority,
    };
}
