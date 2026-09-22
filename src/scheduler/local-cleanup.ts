import type { createLocalCleanupStorage } from './local-cleanup-storage.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { StateManager, LocalCleanupPlan, RemoteFileRecord } from '../state.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { inspectRemoteFileSize } from '../uploader.js';
import { cleanupUploadedSessionFiles, readDownloadSession, type DownloadCleanupAuthorization, type DownloadCleanupOptions } from '../download-session.js';
import { logManager } from '../logger.js';
import { safeErrorSummary } from '../diagnostics.js';
import { computeLocalCleanupRetryDelayMs } from './retry-policy.js';
import { isRecord } from '../shared/api/value.js';
import type { ScheduleTimer } from '../ports/timer.js';

function readCleanupManifest(localDir: string) {
    const session = readDownloadSession(localDir);
    if (session.kind === 'invalid') {
        console.warn(`[Cleanup] corrupt download manifest retained dir=${localDir} reason=${session.reason}${session.field ? ` field=${session.field}` : ''}`);
        return null;
    }
    return session.kind === 'valid' ? session.manifest : null;
}

interface LocalCleanupDependencies {
    schedule?: ScheduleTimer;
    canRun(): boolean;
    generation(): number;
    now(): number;
    config: {
        get(): AppConfig;
    };
    state: Pick<StateManager, 'getLocalCleanupPlans' | 'listVerifiedLocalCleanupPage' | 'listRelationsForBvid' | 'getVideoMeta' | 'reconcileLocalCleanupPlans' | 'markLocalUploadGroupComplete'>;
    storage: ReturnType<typeof createLocalCleanupStorage>;
    jobs: Pick<JobRepository, 'hasActiveJobsForBvid'>;
    transfers: Pick<TransferSessionRepository, 'get' | 'hasActiveForBvid'>;
    tempRoot: string;
    inspectRemote: typeof inspectRemoteFileSize;
    safeCandidate(path: string): boolean;
    refreshCapacity(force: boolean): void;
}
/** Owns cleanup work, retry scheduling and authorization checks. Stores are rebound by the maintenance barrier. */
export function createLocalCleanup(deps: LocalCleanupDependencies) {
    let localCleanupRetryTimer: (() => void) | null = null;
    let localCleanupSweepPromise: Promise<void> | null = null;
    const localCleanupInFlight = new Map<string, Promise<void>>();
    const localCleanupRetries = new Map<string, {
        attempts: number;
        nextAt: number;
        localDir: string;
    }>();
    function scheduleLocalCleanupRetryTimer() {
        if (localCleanupRetryTimer) {
            localCleanupRetryTimer();
            localCleanupRetryTimer = null;
        }
        if (!deps.canRun() || localCleanupRetries.size === 0)
            return;
        const next = [...localCleanupRetries.values()]
            .map((item) => item.nextAt)
            .reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
        if (!Number.isFinite(next))
            return;
        const schedule = deps.schedule || ((callback: () => void, delayMs: number, _recurring: boolean) => {
            const timer = setTimeout(callback, delayMs);
            timer.unref?.();
            return () => clearTimeout(timer);
        });
        localCleanupRetryTimer = schedule(() => {
            localCleanupRetryTimer = null;
            const now = deps.now();
            for (const [bvid, item] of localCleanupRetries) {
                if (item.nextAt <= now)
                    requestLocalCleanup(bvid, item.localDir);
            }
            scheduleLocalCleanupRetryTimer();
        }, Math.max(1000, next - deps.now()), false);
    }
    function scheduleLocalCleanupRetry(bvid: string, localDir: string) {
        const previous = localCleanupRetries.get(bvid);
        const attempts = (previous?.attempts || 0) + 1;
        localCleanupRetries.set(bvid, {
            attempts,
            nextAt: deps.now() + computeLocalCleanupRetryDelayMs(attempts - 1),
            localDir,
        });
        scheduleLocalCleanupRetryTimer();
        logManager.push({
            timestamp: new Date(deps.now()).toISOString(),
            type: "system",
            level: "warn",
            summary: `已验证归档暂未完成本地清理，将在稍后自动重试 ${bvid}`,
            raw: `[DownloadRecovery] remote proof was not ready for local cleanup; attempt=${attempts}`,
            bvid,
            simpleVisible: true,
            debugVisible: true,
        });
    }
    function startLocalCleanupSweep() {
        if (localCleanupSweepPromise || !deps.canRun() || !deps.canRun())
            return;
        localCleanupSweepPromise = (async () => {
            let cursor: import("../database.js").VerifiedLocalCleanupCursor | null = null;
            while (deps.canRun()) {
                const page = deps.state.listVerifiedLocalCleanupPage(cursor, 25);
                if (page.items.length === 0)
                    break;
                for (const video of page.items) {
                    if (!deps.canRun())
                        break;
                    const directories = new Set(deps.state.getLocalCleanupPlans(video.bvid).map((plan) => plan.localDir));
                    for (const localDir of directories) {
                        const work = requestLocalCleanup(video.bvid, localDir);
                        if (work)
                            await work;
                    }
                }
                if (!page.nextCursor)
                    break;
                cursor = page.nextCursor;
            }
        })().catch((error) => {
            console.warn(`[Scheduler] Verified local cleanup sweep stopped: ${safeErrorSummary(error)}`);
        }).finally(() => {
            localCleanupSweepPromise = null;
        });
    }
    function localCleanupRetryableError() {
        return Object.assign(new Error("Remote archive proof is not ready for local cleanup"), { localCleanupRetryable: true });
    }
    async function inspectCleanupRemoteFile(config: AppConfig, file: RemoteFileRecord) {
        if (!file.path || !Number.isFinite(Number(file.size)))
            return "structural" as const;
        try {
            const result = await deps.inspectRemote(config, file.path, Number(file.size));
            return result.status === "verified" ? "verified" as const : "remote_retry" as const;
        }
        catch {
            return "remote_retry" as const;
        }
    }
    function cleanupGenerationIsCurrent(plan: LocalCleanupPlan) {
        if (!plan.transferSessionId)
            return plan.reason === "quality_upgrade";
        const session = deps.transfers.get(plan.transferSessionId);
        return Boolean(session && session.generation === plan.transferGeneration && session.phase === "completed");
    }
    async function performVerifiedLocalCleanup(bvid: string, localDir: string) {
        const generation = deps.generation();
        if (!deps.canRun() || !localDir)
            return;
        if (deps.jobs.hasActiveJobsForBvid(bvid) || deps.transfers.hasActiveForBvid(bvid))
            return;
        const cleanupPlans = deps.state.getLocalCleanupPlans(bvid, localDir);
        if (cleanupPlans.length === 0)
            return;
        if (path.basename(path.resolve(localDir)) !== bvid) {
            return performPlannedLocalCleanup(bvid, localDir, cleanupPlans);
        }
        const video = deps.storage.video(bvid);
        if (!video)
            return;
        video.localDir = localDir;
        if (!["verified", "partial_verified"].includes(video.backupStatus || ""))
            return;
        const relations = deps.state.listRelationsForBvid(bvid);
        if (relations.length === 0 || relations.some((relation) => !["verified", "partial_verified"].includes(relation.backupStatus || "")))
            return;
        const tempRoot = path.resolve(deps.tempRoot);
        const candidateDir = path.resolve(localDir);
        if (candidateDir === tempRoot || !candidateDir.startsWith(`${tempRoot}${path.sep}`) || path.basename(candidateDir) !== bvid)
            return;
        let localStat: fs.Stats;
        try {
            localStat = await fs.promises.lstat(candidateDir);
            if (!localStat.isDirectory() || localStat.isSymbolicLink())
                return;
            const [realRoot, realCandidate] = await Promise.all([
                fs.promises.realpath(tempRoot),
                fs.promises.realpath(candidateDir),
            ]);
            if (realCandidate === realRoot || !realCandidate.startsWith(`${realRoot}${path.sep}`))
                return;
        }
        catch {
            return;
        }
        const manifest = readCleanupManifest(localDir);
        if (!manifest || manifest.bvid !== bvid || !["complete", "partial"].includes(manifest.status))
            return;
        const normalizeRelative = (value: string) => value.replace(/\\/g, "/");
        const localFileIsValid = async (relativePath: string, expectedSize: number) => {
            const normalized = normalizeRelative(relativePath);
            const localFile = path.resolve(localDir, normalized);
            const localRoot = path.resolve(localDir);
            if (localFile === localRoot || !localFile.startsWith(`${localRoot}${path.sep}`))
                return false;
            try {
                const stat = await fs.promises.lstat(localFile);
                return stat.isFile() && !stat.isSymbolicLink() && stat.size === expectedSize ? stat : false;
            }
            catch (error) {
                return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" as const : false;
            }
        };
        const proofByRelativePath = new Map<string, RemoteFileRecord[]>();
        const addProof = (file: RemoteFileRecord) => {
            if (["awaiting_verification", "failed"].includes(file.verificationStatus || ""))
                return;
            const relative = file.localRelativePath ? normalizeRelative(file.localRelativePath) : "";
            if (!relative || !Number.isFinite(Number(file.size)) || !file.path)
                return;
            const list = proofByRelativePath.get(relative) || [];
            if (!list.some((candidate) => candidate.path === file.path && candidate.size === file.size))
                list.push(file);
            proofByRelativePath.set(relative, list);
        };
        for (const file of video.remoteFiles || [])
            addProof(file);
        for (const relation of relations) {
            for (const file of relation.remoteFiles || [])
                addProof(file);
        }
        const manifestFiles = [...manifest.outputs, ...(manifest.history || [])];
        const authorizedFiles: DownloadCleanupAuthorization[] = [];
        for (const plan of cleanupPlans) {
            if (plan.manifestSessionId !== manifest.sessionId || !cleanupGenerationIsCurrent(plan))
                return;
            for (const planned of plan.files) {
                const relativePath = normalizeRelative(planned.relativePath);
                const output = manifestFiles.find((file) => normalizeRelative(file.relativePath) === relativePath);
                if (!output)
                    continue;
                if (Number(output.size) !== Number(planned.expectedSize))
                    return;
                const localIdentity = await localFileIsValid(relativePath, Number(planned.expectedSize));
                if (!localIdentity)
                    return;
                const proofs = (proofByRelativePath.get(relativePath) || [])
                    .filter((file) => Number(file.size) === Number(planned.expectedSize) && planned.remotePaths.includes(file.path));
                if (proofs.length === 0)
                    return;
                let verified = false;
                for (const proof of proofs) {
                    if (await inspectCleanupRemoteFile(deps.config.get(), proof) === "verified") {
                        verified = true;
                        break;
                    }
                }
                if (!verified)
                    throw localCleanupRetryableError();
                authorizedFiles.push({
                    relativePath,
                    expectedSize: Number(planned.expectedSize),
                    manifestSessionId: manifest.sessionId,
                    expectedIdentity: planned.expectedIdentity,
                });
            }
        }
        const authorizedPaths = new Set(authorizedFiles.map((file) => normalizeRelative(file.relativePath)));
        if (authorizedPaths.size === 0 && manifestFiles.length > 0)
            return;
        if (!deps.canRun() || generation !== deps.generation())
            return;
        const cleanupOptions: DownloadCleanupOptions = {
            authorizedFiles,
            canDelete: () => deps.canRun() && cleanupPlans.every((plan) => cleanupGenerationIsCurrent(plan))
                && !deps.jobs.hasActiveJobsForBvid(bvid) && !deps.transfers.hasActiveForBvid(bvid),
            preserveManifest: manifestFiles.some((file) => !authorizedPaths.has(normalizeRelative(file.relativePath))),
        };
        await cleanupSharedUploadDir(localDir, new Set([bvid]), cleanupOptions);
    }
    async function performPlannedLocalCleanup(bvid: string, localDir: string, cleanupPlans = deps.state.getLocalCleanupPlans(bvid, localDir)) {
        const generation = deps.generation();
        if (!deps.canRun() || !localDir || cleanupPlans.length === 0)
            return;
        if (deps.jobs.hasActiveJobsForBvid(bvid) || deps.transfers.hasActiveForBvid(bvid))
            return;
        if (!deps.safeCandidate(localDir))
            return;
        const manifest = readCleanupManifest(localDir);
        if (!manifest || manifest.bvid !== bvid || !["complete", "partial"].includes(manifest.status))
            return;
        const manifestFiles = [...manifest.outputs, ...(manifest.history || [])];
        const proofByRelativePath = new Map<string, RemoteFileRecord[]>();
        const addProof = (file: RemoteFileRecord) => {
            const relativePath = String(file.localRelativePath || "").replace(/\\/g, "/");
            if (!relativePath || !file.path || !Number.isFinite(Number(file.size)) || ["awaiting_verification", "failed"].includes(file.verificationStatus || ""))
                return;
            const list = proofByRelativePath.get(relativePath) || [];
            if (!list.some((candidate) => candidate.path === file.path && Number(candidate.size) === Number(file.size)))
                list.push(file);
            proofByRelativePath.set(relativePath, list);
        };
        const video = deps.storage.video(bvid);
        for (const file of video?.remoteFiles || [])
            addProof(file);
        for (const relation of deps.state.listRelationsForBvid(bvid)) {
            for (const file of relation.remoteFiles || [])
                addProof(file);
        }
        const authorizedFiles: DownloadCleanupAuthorization[] = [];
        for (const plan of cleanupPlans) {
            if (plan.manifestSessionId !== manifest.sessionId || !cleanupGenerationIsCurrent(plan))
                return;
            for (const planned of plan.files) {
                const relativePath = String(planned.relativePath || "").replace(/\\/g, "/");
                const manifestFile = manifestFiles.find((file) => file.relativePath.replace(/\\/g, "/") === relativePath);
                if (!manifestFile)
                    continue;
                if (Number(manifestFile.size) !== Number(planned.expectedSize))
                    return;
                const localFile = path.resolve(localDir, relativePath);
                const localRoot = path.resolve(localDir);
                if (localFile === localRoot || !localFile.startsWith(`${localRoot}${path.sep}`))
                    return;
                try {
                    const localIdentity = await fs.promises.lstat(localFile);
                    if (!localIdentity.isFile() || localIdentity.isSymbolicLink() || localIdentity.size !== Number(planned.expectedSize))
                        return;
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                        return;
                }
                const proofs = (proofByRelativePath.get(relativePath) || [])
                    .filter((file) => Number(file.size) === Number(planned.expectedSize) && planned.remotePaths.includes(file.path));
                if (proofs.length === 0)
                    return;
                let verified = false;
                for (const proof of proofs) {
                    if (await inspectCleanupRemoteFile(deps.config.get(), proof) === "verified") {
                        verified = true;
                        break;
                    }
                }
                if (!verified)
                    throw localCleanupRetryableError();
                authorizedFiles.push({ relativePath, expectedSize: Number(planned.expectedSize), manifestSessionId: manifest.sessionId,
                    expectedIdentity: planned.expectedIdentity });
            }
        }
        const authorizedPaths = new Set(authorizedFiles.map((file) => file.relativePath));
        if (authorizedPaths.size === 0 && manifestFiles.length > 0)
            return;
        if (!deps.canRun() || generation !== deps.generation())
            return;
        await cleanupSharedUploadDir(localDir, new Set([bvid]), {
            authorizedFiles,
            canDelete: () => deps.canRun() && cleanupPlans.every((plan) => cleanupGenerationIsCurrent(plan))
                && !deps.jobs.hasActiveJobsForBvid(bvid) && !deps.transfers.hasActiveForBvid(bvid),
            preserveManifest: manifestFiles.some((file) => !authorizedPaths.has(file.relativePath.replace(/\\/g, "/"))),
        });
    }
    function localArchiveReleaseCandidates(bvid: string) {
        const groups = new Map<string, LocalCleanupPlan[]>();
        for (const plan of deps.state.getLocalCleanupPlans(bvid)) {
            const key = `${plan.localDir}\u0000${plan.manifestSessionId}`;
            const list = groups.get(key) || [];
            list.push(plan);
            groups.set(key, list);
        }
        const candidates: Array<{
            releaseId: string;
            localDir: string;
            manifestSessionId: string;
            fileCount: number;
            totalBytes: number;
            manualFiles?: DownloadCleanupAuthorization[];
            sessionStamp?: string;
            hasVerifiedArchive?: boolean;
        }> = [];
        for (const plans of groups.values()) {
            if (plans.length === 0 || !plans.every((plan) => cleanupGenerationIsCurrent(plan)))
                continue;
            const localDir = plans[0].localDir;
            const manifest = readCleanupManifest(localDir);
            if (!manifest || manifest.bvid !== bvid || manifest.sessionId !== plans[0].manifestSessionId)
                continue;
            const manifestFiles = new Map([...manifest.outputs, ...(manifest.history || [])]
                .map((file) => [String(file.relativePath).replace(/\\/g, "/"), file] as const));
            const files = new Map<string, LocalCleanupPlan["files"][number]>();
            let stale = false;
            for (const plan of plans) {
                if (plan.localDir !== localDir || plan.manifestSessionId !== manifest.sessionId) {
                    stale = true;
                    break;
                }
                for (const file of plan.files) {
                    const relativePath = String(file.relativePath).replace(/\\/g, "/");
                    const manifestFile = manifestFiles.get(relativePath);
                    if (!manifestFile || Number(manifestFile.size) !== Number(file.expectedSize)) {
                        stale = true;
                        break;
                    }
                    const target = path.resolve(localDir, relativePath);
                    const root = path.resolve(localDir);
                    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
                        stale = true;
                        break;
                    }
                    try {
                        const stat = fs.lstatSync(target);
                        const identity = file.expectedIdentity;
                        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(file.expectedSize)
                            || stat.dev !== identity.dev || stat.ino !== identity.ino
                            || stat.mtimeMs !== identity.mtimeMs || stat.ctimeMs !== identity.ctimeMs) {
                            stale = true;
                            break;
                        }
                        const previous = files.get(relativePath);
                        if (previous && (previous.expectedSize !== file.expectedSize
                            || JSON.stringify(previous.expectedIdentity) !== JSON.stringify(file.expectedIdentity))) {
                            stale = true;
                            break;
                        }
                        files.set(relativePath, file);
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT")
                            continue;
                        stale = true;
                        break;
                    }
                }
                if (stale)
                    break;
            }
            if (stale || files.size === 0)
                continue;
            const orderedFiles = [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
            const releaseId = crypto.createHash("sha256").update(JSON.stringify({
                bvid,
                localDir,
                manifestSessionId: manifest.sessionId,
                planIds: plans.map((plan) => plan.id).sort(),
                files: orderedFiles.map((file) => ({
                    relativePath: file.relativePath,
                    expectedSize: file.expectedSize,
                    expectedIdentity: file.expectedIdentity,
                })),
            })).digest("hex").slice(0, 32);
            candidates.push({
                releaseId,
                localDir,
                manifestSessionId: manifest.sessionId,
                fileCount: orderedFiles.length,
                totalBytes: orderedFiles.reduce((sum, file) => sum + Number(file.expectedSize || 0), 0),
            });
        }
        // Failed/stopped attempts have no success cleanup plan. User authorization
        // is resolved separately from automatic cleanup, using only tracked files.
        const directories = deps.storage.trackedDirectories(bvid);
        for (const localDir of directories) {
            if (!localDir || candidates.some((item) => path.resolve(item.localDir) === path.resolve(localDir)))
                continue;
            try {
                const root = fs.realpathSync(deps.tempRoot);
                const realDir = fs.realpathSync(localDir);
                if (!realDir.startsWith(`${root}${path.sep}`) || fs.lstatSync(localDir).isSymbolicLink())
                    continue;
                const manifest = readCleanupManifest(localDir);
                if (!manifest || manifest.bvid !== bvid)
                    continue;
                const files = new Map<string, DownloadCleanupAuthorization>();
                for (const file of [...manifest.outputs, ...(manifest.history || [])]) {
                    const target = path.resolve(localDir, file.relativePath);
                    if (!target.startsWith(`${path.resolve(localDir)}${path.sep}`))
                        continue;
                    try {
                        if (!fs.realpathSync(target).startsWith(`${realDir}${path.sep}`))
                            continue;
                        const stat = fs.lstatSync(target);
                        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size)
                            continue;
                        files.set(file.relativePath, { relativePath: file.relativePath, expectedSize: stat.size,
                            manifestSessionId: manifest.sessionId,
                            expectedIdentity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } });
                    }
                    catch (error) { console.debug('[LocalCleanup] skipped a missing or changed release candidate', error); }
                }
                if (!files.size)
                    continue;
                const manualFiles = [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
                const sessionStamp = localReleaseSessionStamp(bvid);
                const hasVerifiedArchive = deps.state.listRelationsForBvid(bvid).some((relation) => relation.remoteFiles?.some((file) => file.verificationStatus === "verified"));
                const releaseId = crypto.createHash("sha256").update(JSON.stringify({ bvid, localDir, manifest, manualFiles, sessionStamp })).digest("hex").slice(0, 32);
                candidates.push({ releaseId, localDir, manifestSessionId: manifest.sessionId,
                    fileCount: manualFiles.length, totalBytes: manualFiles.reduce((sum, file) => sum + file.expectedSize, 0),
                    manualFiles, sessionStamp, hasVerifiedArchive });
            }
            catch (error) { console.debug('[LocalCleanup] skipped a directory that no longer qualifies for release', error); }
        }
        return candidates;
    }
    function localReleaseSessionStamp(bvid: string) {
        return deps.storage.sessionStamp(bvid);
    }
    function previewLocalArchiveRelease(bvidValue: string) {
        const bvid = String(bvidValue || "").trim();
        if (!bvid || !deps.state.getVideoMeta(bvid)) {
            return { ok: false as const, status: 404 as const, message: "本地没有该视频记录" };
        }
        const candidates = localArchiveReleaseCandidates(bvid);
        return {
            ok: true as const,
            bvid,
            fileCount: candidates.reduce((sum, item) => sum + item.fileCount, 0),
            totalBytes: candidates.reduce((sum, item) => sum + item.totalBytes, 0),
            candidates: candidates.map(({ localDir: _localDir, manualFiles, sessionStamp: _stamp, ...item }) => ({
                ...item, requiresExplicitDeletion: Boolean(manualFiles),
            })),
        };
    }
    function requestLocalArchiveRelease(bvidValue: string, releaseIdValue: string, confirmation: string) {
        const bvid = String(bvidValue || "").trim();
        const releaseId = String(releaseIdValue || "").trim();
        if (confirmation !== "DELETE LOCAL") {
            return { ok: false as const, status: 400 as const, message: "请输入 DELETE LOCAL 确认释放本地文件" };
        }
        const candidate = localArchiveReleaseCandidates(bvid).find((item) => item.releaseId === releaseId);
        if (!candidate) {
            return { ok: false as const, status: 409 as const, message: "本地文件或归档授权已变化，请重新预览后再操作" };
        }
        if (deps.jobs.hasActiveJobsForBvid(bvid) || deps.transfers.hasActiveForBvid(bvid)) {
            return { ok: false as const, status: 409 as const, message: "该视频仍有传输任务，请先停止本次尝试，再删除本地文件" };
        }
        if (candidate.manualFiles) {
            if (!deps.canRun() || localCleanupInFlight.has(bvid)) {
                return { ok: false as const, status: 409 as const, message: "本地清理正在进行，请稍后重试" };
            }
            const work = cleanupSharedUploadDir(candidate.localDir, new Set([bvid]), {
                authorizedFiles: candidate.manualFiles,
                canDelete: () => deps.canRun() && localReleaseSessionStamp(bvid) === candidate.sessionStamp
                    && !deps.jobs.hasActiveJobsForBvid(bvid) && !deps.transfers.hasActiveForBvid(bvid),
            }).finally(() => localCleanupInFlight.delete(bvid));
            localCleanupInFlight.set(bvid, work);
            return { ok: true as const, status: 202 as const, bvid, releaseId, fileCount: candidate.fileCount, totalBytes: candidate.totalBytes };
        }
        const work = requestLocalCleanup(bvid, candidate.localDir);
        if (!work) {
            return { ok: false as const, status: 409 as const, message: "本地清理正在进行或等待安全复核，请稍后重试" };
        }
        void work;
        return { ok: true as const, status: 202 as const, bvid, releaseId, fileCount: candidate.fileCount, totalBytes: candidate.totalBytes };
    }
    function requestLocalCleanup(bvid: string, localDir: string) {
        if (!deps.canRun() || !localDir)
            return null;
        const generation = deps.generation();
        const active = localCleanupInFlight.get(bvid);
        if (active)
            return active;
        const retry = localCleanupRetries.get(bvid);
        if (retry && retry.nextAt > deps.now())
            return null;
        const work = performVerifiedLocalCleanup(bvid, localDir)
            .then(() => {
            if (generation !== deps.generation())
                return;
            localCleanupRetries.delete(bvid);
            scheduleLocalCleanupRetryTimer();
        })
            .catch((error: unknown) => {
            if (generation !== deps.generation())
                return;
            if (isRecord(error) && error.localCleanupRetryable) {
                scheduleLocalCleanupRetry(bvid, localDir);
            }
            else {
                console.warn(`[Scheduler] Verified local cleanup skipped for ${bvid}: ${safeErrorSummary(error)}`);
            }
        })
            .finally(() => {
            localCleanupInFlight.delete(bvid);
        });
        localCleanupInFlight.set(bvid, work);
        return work;
    }
    async function cleanupSharedUploadDir(downloadDir: string, bvids: Set<string> = new Set(), options: DownloadCleanupOptions = {}) {
        const generation = deps.generation();
        const current = () => deps.canRun() && generation === deps.generation();
        try {
            const result = await cleanupUploadedSessionFiles(downloadDir, {
                ...options, canDelete: () => current() && (options.canDelete?.() ?? false),
            });
            if (!current())
                return;
            const remainingManifest = readCleanupManifest(downloadDir);
            const remainingPaths = remainingManifest
                ? [...remainingManifest.outputs, ...(remainingManifest.history || [])].map((file) => file.relativePath)
                : [];
            if (remainingManifest || result.removedDirectory) {
                for (const bvid of bvids) {
                    deps.state.reconcileLocalCleanupPlans(bvid, downloadDir, remainingPaths, result.removedDirectory);
                }
            }
            if (result.removedDirectory || (remainingManifest
                && remainingManifest.outputs.length === 0
                && (remainingManifest.history || []).length === 0)) {
                for (const bvid of bvids) {
                    deps.state.markLocalUploadGroupComplete(bvid, downloadDir);
                }
            }
            if (!result.removedDirectory) {
                logManager.push({
                    timestamp: new Date().toISOString(),
                    type: "system",
                    level: "warn",
                    summary: `本地文件已保留，未授权清理的文件不会自动删除`,
                    raw: `[DownloadRecovery] retained ${result.retainedBytes} bytes in ${downloadDir}`,
                    simpleVisible: true,
                    debugVisible: true,
                });
            }
        }
        catch (error: unknown) {
            console.warn(`[Scheduler] Failed to cleanup ${downloadDir}: ${safeErrorSummary(error)}`);
        }
        finally {
            if (current())
                deps.refreshCapacity(true);
        }
    }
    function stop() {
        if (localCleanupRetryTimer)
            localCleanupRetryTimer();
        localCleanupRetryTimer = null;
    }
    function reset() {
        if (localCleanupSweepPromise || localCleanupInFlight.size)
            throw new Error('Local cleanup must drain before storage rebind');
        stop();
        localCleanupRetries.clear();
    }
    return {
        startSweep: startLocalCleanupSweep, request: requestLocalCleanup,
        preview: previewLocalArchiveRelease, release: requestLocalArchiveRelease,
        perform: performVerifiedLocalCleanup, stop, reset,
        get sweeping() { return Boolean(localCleanupSweepPromise); },
        get busy() { return Boolean(localCleanupSweepPromise) || localCleanupInFlight.size > 0; },
        retryState(bvid: string) { const retry = localCleanupRetries.get(bvid); return retry ? { ...retry } : undefined; },
    };
}
