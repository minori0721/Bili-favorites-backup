import type { AppConfig } from '../config.js';
import { normalizeEncodingPriority, normalizeQualityPriority } from '../downloader.js';
import { relationKey, type RemoteFileRecord, type StateManager } from '../state.js';
import { downloadCredentialsForUser, type UserStore } from '../users.js';
import { QualityUpgradeTask } from '../tasks.js';
import { resolveQualityUpgradeRemoteTarget } from '../quality-upgrade-target.js';
import { SkippedPreviewCollector } from '../preview-summary.js';
export interface QualityUpgradeRequest {
    key?: string;
    userId?: string;
    mediaId?: number;
    bvid?: string;
    forceUnknown?: boolean;
}
function describeUpgradeReason(config: AppConfig) {
    const parts: string[] = [];
    if (config.bbdownQuality)
        parts.push(`目标清晰度 ${config.bbdownQuality}`);
    if (config.bbdownEncoding)
        parts.push(`编码优先 ${config.bbdownEncoding}`);
    if (config.bbdownHiRes)
        parts.push("Hi-Res 音频");
    if (config.bbdownDolby)
        parts.push("杜比音效");
    return parts.length ? parts.join(" / ") : "按当前 BBDown 画质设置重新下载";
}
function getQualityProfile(config: AppConfig) {
    return {
        quality: String(config.bbdownQuality || ""),
        encoding: String(config.bbdownEncoding || ""),
        hiRes: Boolean(config.bbdownHiRes),
        dolby: Boolean(config.bbdownDolby),
    };
}
function isMediaRemoteFile(file: RemoteFileRecord) {
    return /\.(mp4|mkv|flv|mov|m4v)$/i.test(file.name);
}
function qualityProfilesMatch(files: RemoteFileRecord[], config: AppConfig) {
    const mediaFiles = files.filter(isMediaRemoteFile);
    if (mediaFiles.length === 0 || mediaFiles.some((file) => !file.qualityProfile)) {
        return "unknown" as const;
    }
    const target = getQualityProfile(config);
    return mediaFiles.every((file) => file.qualityProfile?.quality === target.quality &&
        file.qualityProfile?.encoding === target.encoding &&
        file.qualityProfile?.hiRes === target.hiRes &&
        file.qualityProfile?.dolby === target.dolby) ? "same" as const : "different" as const;
}
function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildTemplateMetadataRegex(template: string, bvid: string) {
    const tokenPattern = /<videoTitle>|<ownerName>|<bvid>|<publishDate>|<videoDate>|<dfn>|<videoCodecs>/g;
    let output = "^";
    let lastIndex = 0;
    let hasQuality = false;
    let hasEncoding = false;
    for (const match of template.matchAll(tokenPattern)) {
        output += escapeRegExp(template.slice(lastIndex, match.index));
        switch (match[0]) {
            case "<bvid>":
                output += escapeRegExp(bvid);
                break;
            case "<dfn>":
                output += "(?<dfn>[^\\/\\.]+?)";
                hasQuality = true;
                break;
            case "<videoCodecs>":
                output += "(?<videoCodecs>[^\\/\\.]+?)";
                hasEncoding = true;
                break;
            default:
                output += ".+?";
                break;
        }
        lastIndex = (match.index || 0) + match[0].length;
    }
    output += escapeRegExp(template.slice(lastIndex));
    output += "(?:_P\\d+)?$";
    if (!hasQuality && !hasEncoding) {
        return null;
    }
    return { regex: new RegExp(output, "i"), hasQuality, hasEncoding };
}
function textMatchesQuality(value: string, target: string) {
    return value.trim().toLowerCase() === normalizeQualityPriority(target).toLowerCase();
}
function textMatchesEncoding(value: string, target: string) {
    return value.trim().toLowerCase() === normalizeEncodingPriority(target).toLowerCase();
}
function qualityFilenameMatchStatus(files: RemoteFileRecord[], bvid: string, config: AppConfig) {
    const needsQuality = Boolean(config.bbdownQuality);
    const needsEncoding = Boolean(config.bbdownEncoding);
    if (!needsQuality && !needsEncoding) {
        return "unknown" as const;
    }
    const mediaFiles = files.filter(isMediaRemoteFile);
    if (mediaFiles.length === 0) {
        return "unknown" as const;
    }
    const templateRegex = buildTemplateMetadataRegex(config.filenameTemplate || "<videoTitle>-<bvid>", bvid);
    if (!templateRegex) {
        return "unknown" as const;
    }
    if ((needsQuality && !templateRegex.hasQuality) || (needsEncoding && !templateRegex.hasEncoding)) {
        return "unknown" as const;
    }
    let matched = false;
    for (const file of mediaFiles) {
        const parsed = templateRegex.regex.exec(file.name.replace(/\.[^.]+$/, ""));
        if (!parsed?.groups) {
            return "unknown" as const;
        }
        if (needsQuality && !textMatchesQuality(parsed.groups.dfn || "", config.bbdownQuality)) {
            return "different" as const;
        }
        if (needsEncoding && !textMatchesEncoding(parsed.groups.videoCodecs || "", config.bbdownEncoding)) {
            return "different" as const;
        }
        matched = true;
    }
    return matched ? "same" as const : "unknown" as const;
}
export function getQualityUpgradeMatchStatus(files: RemoteFileRecord[], bvid: string, config: AppConfig) {
    const profileStatus = qualityProfilesMatch(files, config);
    if (profileStatus !== "unknown") {
        return profileStatus;
    }
    if (config.bbdownHiRes || config.bbdownDolby) {
        return "unknown" as const;
    }
    return qualityFilenameMatchStatus(files, bvid, config);
}
export function createQualityMaintenance(dependencies: {
    config(): AppConfig;
    records: StateManager['getRemoteFilePreviewRecords'];
    targetKeys(): ReadonlySet<string>;
    users: Pick<UserStore, 'getById'>;
    enqueue(task: QualityUpgradeTask): boolean;
}) {
    function preview(detailLimit?: number) {
        const config = dependencies.config();
        const reason = describeUpgradeReason(config);
        const records = dependencies.records();
        const qualityTargetKeys = dependencies.targetKeys();
        const candidates: Array<{
            key: string;
            bvid: string;
            title: string;
            ownerName: string;
            userId: string;
            mediaId: number;
            folderTitle: string;
            remotePath: string;
            oldFiles: RemoteFileRecord[];
            reason: string;
            matchStatus: "different";
        }> = [];
        const uncertain: Array<{
            key: string;
            bvid: string;
            title: string;
            ownerName: string;
            userId: string;
            mediaId: number;
            folderTitle: string;
            remotePath: string;
            oldFiles: RemoteFileRecord[];
            reason: string;
            matchStatus: "unknown";
        }> = [];
        const skipped = new SkippedPreviewCollector<{
            bvid?: string;
            title?: string;
            folderTitle?: string;
            reason: string;
        }>(detailLimit);
        const remoteRoot = config.alistDest || "/bili-backup/videos";
        for (const record of records) {
            for (const relation of record.relations) {
                if (relation.hasInterruptedQualityUpgrade) {
                    skipped.add({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: "上一次画质重调正在恢复中" });
                    continue;
                }
                if (relation.backupStatus !== "verified" && relation.backupStatus !== "partial_verified") {
                    skipped.add({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: relation.backupStatus === "uploaded" ? "远端文件仍在确认中" : "只有最终确认的视频才能重调画质" });
                    continue;
                }
                const remoteTarget = resolveQualityUpgradeRemoteTarget(remoteRoot, relation);
                if (!remoteTarget.ok) {
                    skipped.add({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: remoteTarget.reason });
                    continue;
                }
                const { oldFiles, remotePath } = remoteTarget;
                const key = relationKey(relation.userId, relation.mediaId, record.bvid);
                if (qualityTargetKeys.has(`${relation.userId}:${relation.mediaId}:${record.bvid}`)) {
                    skipped.add({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: "已在画质重调队列中" });
                    continue;
                }
                const matchStatus = getQualityUpgradeMatchStatus(oldFiles, record.bvid, config);
                if (matchStatus === "same") {
                    skipped.add({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: "远端文件已符合当前画质设置" });
                    continue;
                }
                const previewItem = {
                    key,
                    bvid: record.bvid,
                    title: record.title,
                    ownerName: record.upperName,
                    userId: relation.userId,
                    mediaId: relation.mediaId,
                    folderTitle: relation.folderTitle,
                    remotePath,
                    oldFiles,
                    reason: matchStatus === "unknown" ? "旧文件缺少可确认的画质档案，需要人工确认" : reason,
                };
                if (matchStatus === "unknown")
                    uncertain.push({ ...previewItem, matchStatus: "unknown" });
                else
                    candidates.push({ ...previewItem, matchStatus: "different" });
            }
        }
        return { candidates, uncertain, ...skipped.snapshot(), target: {
                quality: config.bbdownQuality,
                encoding: config.bbdownEncoding,
                hiRes: config.bbdownHiRes,
                dolby: config.bbdownDolby,
            } };
    }
    function submit(items: QualityUpgradeRequest[]) {
        const snapshot = preview();
        const candidates = new Map(snapshot.candidates.map((item) => [item.key, item]));
        const uncertain = new Map(snapshot.uncertain.map((item) => [item.key, item]));
        const config = dependencies.config();
        const queued: Array<{
            key: string;
            bvid: string;
            title: string;
            artifactKey: string;
        }> = [];
        const skipped: Array<{
            key: string;
            reason: string;
        }> = [];
        const requestedKeys = new Set<string>();
        const downloadGroups = new Set<string>();
        for (const item of items) {
            const key = item.key || (item.userId && item.mediaId && item.bvid ? relationKey(item.userId, Number(item.mediaId), item.bvid) : "");
            if (!key || requestedKeys.has(key)) {
                skipped.push({ key, reason: key ? "重复提交" : "缺少任务标识" });
                continue;
            }
            requestedKeys.add(key);
            const candidate = candidates.get(key) || (item.forceUnknown ? uncertain.get(key) : undefined);
            if (!candidate) {
                skipped.push({ key, reason: uncertain.has(key) ? "无法判断旧文件画质，必须明确确认后提交" : "预览候选不存在或已在队列中" });
                continue;
            }
            const user = dependencies.users.getById(candidate.userId);
            if (!user || !user.enabled) {
                skipped.push({ key, reason: "账号不存在或未启用" });
                continue;
            }
            const task = new QualityUpgradeTask(candidate.bvid, downloadCredentialsForUser(user), config, {
                userId: candidate.userId,
                mediaId: candidate.mediaId,
                folderTitle: candidate.folderTitle,
                remotePath: candidate.remotePath,
                oldFiles: candidate.oldFiles,
            });
            task.videoTitle = candidate.title;
            task.folderTitle = candidate.folderTitle;
            task.downloadUserId = user.id;
            task.userId = candidate.userId;
            task.mediaId = candidate.mediaId;
            if (!dependencies.enqueue(task)) {
                skipped.push({ key, reason: "该任务已在持久化队列中" });
                continue;
            }
            queued.push({ key, bvid: candidate.bvid, title: candidate.title, artifactKey: task.artifactKey });
            downloadGroups.add(task.artifactKey);
        }
        return { queued, skipped, downloadGroups: downloadGroups.size };
    }
    return { preview, submit };
}
