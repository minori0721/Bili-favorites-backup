import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isBBDownCredentialDirectoryName } from "./credential-temp.js";
import {
  DEFAULT_BBDOWN_ENCODING_PRIORITY,
  normalizeBBDownEncodingPriority,
  type AppConfig,
  type BBDownEncoding,
} from "./config.js";
import type { QualityArtifactProfile } from "./quality-artifact.js";
import type { UploadFileMetadata } from "./state.js";
import { BBDOWN_BUILD_INFO } from "./generated/bbdown-build-info.js";
import { writeJsonFile } from "./storage.js";
import {
  actualQualityLabel,
  normalizeActualCodec,
  normalizeBilibiliQualityLabel,
  parseFrameRate,
} from "./media-metadata.js";

export const DOWNLOAD_SESSION_FILE = ".bfb-download.json";
export const DOWNLOAD_RETAINED_FILE = ".bfb-retained.json";
export const BBDOWN_SOURCE_COMMIT = BBDOWN_BUILD_INFO.commit;
const PREVIOUS_BBDOWN_2_0_6_COMMIT = "b4d4ba36a7934d8490c5a43274941022eac5c483";
const PREVIOUS_BBDOWN_PATCH_COMMIT = "fa7209d63bd73a4ab07913ce1478a0e13056ad09";
const PREVIOUS_BBDOWN_INTERACTIVE_COMMIT = "0ea9463202e8a57e0d673f29166e54f4ed770255";
const PREVIOUS_BBDOWN_SOURCE_COMMIT = "76c1a802825efd9761699d42955fd0553a9dfa9d";
const PREVIOUS_BBDOWN_PROBE_COMMIT = "d34b69482d3cdf3af3aea12cf1123142609b5c07";
const LEGACY_BBDOWN_SOURCE_COMMIT = "fd926373dfe03d68bf84a1ad8a4ffbf402b00988";
const HISTORIC_BBDOWN_SOURCE_COMMIT = "fcb895f357df49c45010cefab773025d5d50cf7c";
const OLDEST_HISTORIC_BBDOWN_SOURCE_COMMIT = "259a5558cee0a349a7ebb60bd31e40c88e5bc1ed";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

function errorCode(error: unknown) {
  const value = record(error);
  return typeof value.code === "string" ? value.code : "";
}

export type DownloadSessionKind = "backup" | "quality_upgrade";
export type DownloadSessionStatus = "prepared" | "downloading" | "complete" | "partial" | "failed";

export type StrictEncodingAssessmentStatus = "matched" | "mismatch" | "unknown";

export interface StrictEncodingAssessment {
  status: StrictEncodingAssessmentStatus;
  requestedEncoding: BBDownEncoding;
  actualEncodings: string[];
  encodingMismatch: boolean;
  verifiedPages: number;
  totalPages: number;
  mismatchedFiles: string[];
  unknownFiles: string[];
  summary: string;
}

export type StrictQualityAssessmentStatus = "matched" | "mismatch" | "unknown";

export interface StrictQualityAssessment {
  status: StrictQualityAssessmentStatus;
  requestedQuality: string;
  actualQualities: string[];
  qualityMismatch: boolean;
  verifiedPages: number;
  totalPages: number;
  mismatchedFiles: string[];
  unknownFiles: string[];
  summary: string;
}

export type StrictEncodingValidationSource = "selected_stream" | "ffprobe" | "upload_preflight";

/**
 * A strict encoding retry is a safety boundary, not a best-effort preference.
 * Keep the assessment on the error so the scheduler can park the job without
 * re-reading or guessing from BBDown's human-readable output.
 */
export class StrictEncodingValidationError extends Error {
  readonly code: string;
  readonly permanent = true;
  readonly deferToNextCycle = false;
  readonly downloadFailureCategory = "tool" as const;
  readonly encodingValidation = true as const;
  readonly encodingAssessment: StrictEncodingAssessment;
  readonly source: StrictEncodingValidationSource;

  constructor(assessment: StrictEncodingAssessment, source: StrictEncodingValidationSource = "ffprobe") {
    const code = source === "selected_stream"
      ? "BFB_ENCODING_SELECTED_MISMATCH"
      : assessment.status === "unknown"
        ? "BFB_ENCODING_UNVERIFIED"
        : "BFB_ENCODING_MISMATCH";
    super(assessment.summary);
    this.name = "StrictEncodingValidationError";
    this.code = code;
    this.encodingAssessment = assessment;
    this.source = source;
  }
}

export class StrictQualityValidationError extends Error {
  readonly code: string;
  readonly permanent = true;
  readonly deferToNextCycle = false;
  readonly downloadFailureCategory = "tool" as const;
  readonly qualityValidation = true as const;
  readonly qualityAssessment: StrictQualityAssessment;
  readonly source: StrictEncodingValidationSource;

  constructor(assessment: StrictQualityAssessment, source: StrictEncodingValidationSource = "selected_stream") {
    const code = assessment.status === "unknown" ? "BFB_QUALITY_UNVERIFIED" : "BFB_QUALITY_MISMATCH";
    super(assessment.summary);
    this.name = "StrictQualityValidationError";
    this.code = code;
    this.qualityAssessment = assessment;
    this.source = source;
  }
}

export function createStrictEncodingValidationError(
  assessment: StrictEncodingAssessment,
  source: StrictEncodingValidationSource = "ffprobe",
) {
  return new StrictEncodingValidationError(assessment, source);
}

export function strictEncodingDiagnosticPatch(assessment: StrictEncodingAssessment) {
  return {
    requestedEncoding: assessment.requestedEncoding,
    actualEncodings: [...assessment.actualEncodings],
    encodingMismatch: assessment.encodingMismatch,
    verifiedPages: assessment.verifiedPages,
  };
}

export function strictQualityDiagnosticPatch(assessment: StrictQualityAssessment) {
  return {
    requestedQuality: assessment.requestedQuality,
    actualQualities: [...assessment.actualQualities],
    qualityMismatch: assessment.qualityMismatch,
    verifiedPages: assessment.verifiedPages,
  };
}

export interface DownloadPageSnapshot {
  index: number;
  cid: number;
  title: string;
  duration: number;
  publishedAt?: number;
}

export interface DownloadOutputRecord {
  pageIndex: number;
  cid: number;
  relativePath: string;
  size: number;
  duration: number;
  videoCodec: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  quickHash: string;
  verifiedAt: string;
}

export interface HistoricalOutputRecord extends DownloadOutputRecord {
  snapshotAt: string;
  reason: "removed" | "replaced" | "legacy_unmatched";
  uploadedTargets?: string[];
}

export interface DownloadSelectedStreamRecord {
  pageIndex: number;
  cid: number;
  bilibiliQuality: string;
  observedAt: string;
}

export interface DownloadSessionManifest {
  schemaVersion: 1;
  sessionId: string;
  kind: DownloadSessionKind;
  bvid: string;
  accountUid: number;
  bbdownCommit: string;
  configFingerprint: string;
  configSnapshot: {
    quality: string;
    encoding: string;
    encodingPriority?: BBDownEncoding[];
    apiMode?: "web" | "app";
    hiRes: boolean;
    dolby: boolean;
    filenameTemplate: string;
  };
  createdAt: string;
  updatedAt: string;
  snapshotAt: string;
  publishedAt?: number;
  status: DownloadSessionStatus;
  pages: DownloadPageSnapshot[];
  selectedStreams?: DownloadSelectedStreamRecord[];
  outputs: DownloadOutputRecord[];
  history: HistoricalOutputRecord[];
  qualityUpgrade?: {
    userId: string;
    mediaId: number;
    folderTitle: string;
    remotePath: string;
    oldFiles: Array<{ name: string; path: string; size?: number; qualityProfile?: { quality: string; encoding: string; hiRes: boolean; dolby: boolean } }>;
    artifactKey?: string;
    qualityProfile?: QualityArtifactProfile;
    downloadUserId?: string;
    targets?: Array<{
      userId: string;
      mediaId: number;
      folderTitle: string;
      remotePath: string;
      oldFiles: Array<{ name: string; path: string; size?: number; qualityProfile?: { quality: string; encoding: string; hiRes: boolean; dolby: boolean } }>;
    }>;
  };
  legacyAdopted?: boolean;
  lastError?: string;
}

type DownloadQualityUpgrade = NonNullable<DownloadSessionManifest["qualityUpgrade"]>;
type DownloadQualityUpgradeFile = DownloadQualityUpgrade["oldFiles"][number];

function sessionRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decodeUpgradeFile(value: unknown, field: string): DownloadQualityUpgradeFile | null {
  const file = sessionRecord(value);
  if (!file) return invalidSessionField(field);
  if (typeof file.name !== 'string') return invalidSessionField(`${field}.name`);
  if (typeof file.path !== 'string') return invalidSessionField(`${field}.path`);
  if (file.size !== undefined && (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0)) return invalidSessionField(`${field}.size`);
  let qualityProfile: DownloadQualityUpgradeFile["qualityProfile"];
  if (file.qualityProfile !== undefined) {
    const profile = sessionRecord(file.qualityProfile);
    if (!profile || typeof profile.quality !== "string" || typeof profile.encoding !== "string"
      || typeof profile.hiRes !== "boolean" || typeof profile.dolby !== "boolean") return invalidSessionField(`${field}.qualityProfile`);
    qualityProfile = {
      quality: profile.quality,
      encoding: profile.encoding,
      hiRes: profile.hiRes,
      dolby: profile.dolby,
    };
  }
  return {
    name: file.name,
    path: file.path,
    ...(typeof file.size === "number" ? { size: file.size } : {}),
    ...(qualityProfile ? { qualityProfile } : {}),
  };
}

function decodeUpgradeFiles(value: unknown, field: string): DownloadQualityUpgradeFile[] | null {
  if (!Array.isArray(value)) return invalidSessionField(field);
  const files: DownloadQualityUpgradeFile[] = [];
  for (const item of value) {
    const file = decodeUpgradeFile(item, `${field}[${files.length}]`);
    if (!file) return null;
    files.push(file);
  }
  return files;
}

function decodeQualityArtifactProfile(value: unknown): QualityArtifactProfile | null {
  const profile = sessionRecord(value);
  if (!profile || typeof profile.quality !== "string" || typeof profile.encoding !== "string"
    || typeof profile.hiRes !== "boolean" || typeof profile.dolby !== "boolean"
    || typeof profile.filenameTemplate !== "string") return null;
  return {
    quality: profile.quality,
    encoding: profile.encoding,
    hiRes: profile.hiRes,
    dolby: profile.dolby,
    filenameTemplate: profile.filenameTemplate,
  };
}

function decodeUpgradeTarget(value: unknown, field: string): NonNullable<DownloadQualityUpgrade["targets"]>[number] | null {
  const target = sessionRecord(value);
  if (!target) return invalidSessionField(field);
  if (typeof target.userId !== 'string') return invalidSessionField(`${field}.userId`);
  if (!isSafeInteger(target.mediaId)) return invalidSessionField(`${field}.mediaId`);
  if (typeof target.folderTitle !== 'string') return invalidSessionField(`${field}.folderTitle`);
  if (typeof target.remotePath !== 'string') return invalidSessionField(`${field}.remotePath`);
  const oldFiles = decodeUpgradeFiles(target.oldFiles, `${field}.oldFiles`);
  if (!oldFiles) return null;
  return {
    userId: target.userId,
    mediaId: target.mediaId,
    folderTitle: target.folderTitle,
    remotePath: target.remotePath,
    oldFiles,
  };
}

function decodeQualityUpgrade(value: unknown): DownloadQualityUpgrade | null {
  const upgrade = sessionRecord(value);
  if (!upgrade) return invalidSessionField('qualityUpgrade');
  if (typeof upgrade.userId !== 'string') return invalidSessionField('qualityUpgrade.userId');
  if (!isSafeInteger(upgrade.mediaId)) return invalidSessionField('qualityUpgrade.mediaId');
  if (typeof upgrade.folderTitle !== 'string') return invalidSessionField('qualityUpgrade.folderTitle');
  if (typeof upgrade.remotePath !== 'string') return invalidSessionField('qualityUpgrade.remotePath');
  if (upgrade.artifactKey !== undefined && typeof upgrade.artifactKey !== 'string') return invalidSessionField('qualityUpgrade.artifactKey');
  if (upgrade.downloadUserId !== undefined && typeof upgrade.downloadUserId !== 'string') return invalidSessionField('qualityUpgrade.downloadUserId');
  const oldFiles = decodeUpgradeFiles(upgrade.oldFiles, 'qualityUpgrade.oldFiles');
  if (!oldFiles) return null;
  let qualityProfile: QualityArtifactProfile | undefined;
  if (upgrade.qualityProfile !== undefined) {
    qualityProfile = decodeQualityArtifactProfile(upgrade.qualityProfile) || undefined;
    if (!qualityProfile) return invalidSessionField('qualityUpgrade.qualityProfile');
  }
  let targets: NonNullable<DownloadQualityUpgrade["targets"]> | undefined;
  if (upgrade.targets !== undefined) {
    if (!Array.isArray(upgrade.targets)) return invalidSessionField('qualityUpgrade.targets');
    targets = [];
    for (const value of upgrade.targets) {
      const target = decodeUpgradeTarget(value, `qualityUpgrade.targets[${targets.length}]`);
      if (!target) return null;
      targets.push(target);
    }
  }
  return {
    userId: upgrade.userId,
    mediaId: upgrade.mediaId,
    folderTitle: upgrade.folderTitle,
    remotePath: upgrade.remotePath,
    oldFiles,
    ...(typeof upgrade.artifactKey === "string" ? { artifactKey: upgrade.artifactKey } : {}),
    ...(qualityProfile ? { qualityProfile } : {}),
    ...(typeof upgrade.downloadUserId === "string" ? { downloadUserId: upgrade.downloadUserId } : {}),
    ...(targets ? { targets } : {}),
  };
}

class DownloadSessionFieldError extends Error {
  constructor(readonly field: string) { super(`Invalid download manifest field: ${field}`); }
}
function invalidSessionField(field: string): never { throw new DownloadSessionFieldError(field); }

function decodeDownloadSessionManifest(value: unknown): DownloadSessionManifest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = record(value);
  if (candidate.schemaVersion !== 1) return invalidSessionField('schemaVersion');
  if (typeof candidate.sessionId !== 'string' || !candidate.sessionId) return invalidSessionField('sessionId');
  if (candidate.kind !== 'backup' && candidate.kind !== 'quality_upgrade') return invalidSessionField('kind');
  if (typeof candidate.bvid !== 'string' || !candidate.bvid) return invalidSessionField('bvid');
  if (!isSafeInteger(candidate.accountUid) || candidate.accountUid < 0) return invalidSessionField('accountUid');
  if (typeof candidate.bbdownCommit !== 'string') return invalidSessionField('bbdownCommit');
  if (typeof candidate.configFingerprint !== 'string') return invalidSessionField('configFingerprint');
  if (!sessionRecord(candidate.configSnapshot)) return invalidSessionField('configSnapshot');
  if (typeof candidate.createdAt !== 'string' || !Number.isFinite(Date.parse(candidate.createdAt))) return invalidSessionField('createdAt');
  if (typeof candidate.updatedAt !== 'string' || !Number.isFinite(Date.parse(candidate.updatedAt))) return invalidSessionField('updatedAt');
  if (typeof candidate.snapshotAt !== 'string' || !Number.isFinite(Date.parse(candidate.snapshotAt))) return invalidSessionField('snapshotAt');
  if (!['prepared','downloading','complete','partial','failed'].includes(String(candidate.status))) return invalidSessionField('status');
  if (!Array.isArray(candidate.pages)) return invalidSessionField('pages');
  if (!Array.isArray(candidate.outputs)) return invalidSessionField('outputs');
  if (!Array.isArray(candidate.history)) return invalidSessionField('history');
  const pages: DownloadPageSnapshot[] = [];
  for (const [index, page] of candidate.pages.entries()) {
    const item = record(page);
    if (!isSafeInteger(item.index) || item.index < 1) return invalidSessionField(`pages[${index}].index`);
    if (!isSafeInteger(item.cid) || item.cid < 1) return invalidSessionField(`pages[${index}].cid`);
    if (typeof item.title !== 'string') return invalidSessionField(`pages[${index}].title`);
    if (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration < 0) return invalidSessionField(`pages[${index}].duration`);
    if (item.publishedAt !== undefined && (typeof item.publishedAt !== 'number' || !Number.isFinite(item.publishedAt))) return invalidSessionField(`pages[${index}].publishedAt`);
    pages.push({ index: item.index, cid: item.cid, title: item.title, duration: item.duration,
      ...(typeof item.publishedAt === "number" ? { publishedAt: item.publishedAt } : {}) });
  }
  if (new Set(pages.map(page => page.cid)).size !== pages.length
    || new Set(pages.map(page => page.index)).size !== pages.length) return invalidSessionField('pages.identity');
  if (candidate.publishedAt !== undefined && (typeof candidate.publishedAt !== 'number' || !Number.isFinite(candidate.publishedAt))) return invalidSessionField('publishedAt');
  if (candidate.legacyAdopted !== undefined && typeof candidate.legacyAdopted !== 'boolean') return invalidSessionField('legacyAdopted');
  if (candidate.lastError !== undefined && typeof candidate.lastError !== 'string') return invalidSessionField('lastError');
  const snapshot = record(candidate.configSnapshot);
  if (typeof snapshot.quality !== 'string') return invalidSessionField('configSnapshot.quality');
  if (typeof snapshot.encoding !== 'string') return invalidSessionField('configSnapshot.encoding');
  if (typeof snapshot.hiRes !== 'boolean') return invalidSessionField('configSnapshot.hiRes');
  if (typeof snapshot.dolby !== 'boolean') return invalidSessionField('configSnapshot.dolby');
  if (typeof snapshot.filenameTemplate !== 'string') return invalidSessionField('configSnapshot.filenameTemplate');
  if (snapshot.encodingPriority !== undefined && (!Array.isArray(snapshot.encodingPriority) || !snapshot.encodingPriority.every(item => typeof item === 'string'))) return invalidSessionField('configSnapshot.encodingPriority');
  if (snapshot.apiMode !== undefined && snapshot.apiMode !== 'app' && snapshot.apiMode !== 'web') return invalidSessionField('configSnapshot.apiMode');
  const status = candidate.status as DownloadSessionStatus;
  const selectedStreams = decodeSelectedStreams(candidate.selectedStreams);
  if (selectedStreams === null) return invalidSessionField('selectedStreams');
  const outputs = decodeManifestOutputList(candidate.outputs, false);
  const history = decodeManifestOutputList(candidate.history, true);
  if (!outputs || !history) return null;
  let qualityUpgrade: DownloadQualityUpgrade | undefined;
  if (candidate.qualityUpgrade !== undefined) {
    qualityUpgrade = decodeQualityUpgrade(candidate.qualityUpgrade) || undefined;
    if (!qualityUpgrade) return invalidSessionField('qualityUpgrade');
  }
  return {
    schemaVersion: 1,
    sessionId: candidate.sessionId,
    kind: candidate.kind,
    bvid: candidate.bvid,
    accountUid: candidate.accountUid,
    bbdownCommit: candidate.bbdownCommit,
    configFingerprint: candidate.configFingerprint,
    configSnapshot: {
      quality: snapshot.quality,
      encoding: snapshot.encoding,
      ...(Array.isArray(snapshot.encodingPriority) ? { encodingPriority: normalizeBBDownEncodingPriority(snapshot.encodingPriority) } : {}),
      ...(snapshot.apiMode === "app" || snapshot.apiMode === "web" ? { apiMode: snapshot.apiMode } : {}),
      hiRes: snapshot.hiRes,
      dolby: snapshot.dolby,
      filenameTemplate: snapshot.filenameTemplate,
    },
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    snapshotAt: candidate.snapshotAt,
    ...(typeof candidate.publishedAt === "number" && Number.isFinite(candidate.publishedAt) ? { publishedAt: candidate.publishedAt } : {}),
    status,
    pages,
    ...(selectedStreams ? { selectedStreams } : {}),
    outputs,
    history,
    ...(qualityUpgrade ? { qualityUpgrade } : {}),
    ...(candidate.legacyAdopted === true ? { legacyAdopted: true } : {}),
    ...(typeof candidate.lastError === "string" ? { lastError: candidate.lastError } : {}),
  };
}

export type DownloadSessionReadResult =
  | { kind: "missing" }
  | { kind: "invalid"; reason: "json" | "schema" | "field"; field?: string }
  | { kind: "valid"; manifest: DownloadSessionManifest };

function decodeDownloadSession(value: unknown): DownloadSessionReadResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", reason: "schema" };
  }
  const candidate = record(value);
  if (candidate.schemaVersion !== 1) {
    return { kind: "invalid", reason: "schema", field: "schemaVersion" };
  }
  try {
    const manifest = decodeDownloadSessionManifest(value);
    return manifest ? { kind: 'valid', manifest } : { kind: 'invalid', reason: 'field', field: 'manifest' };
  } catch (error) {
    if (error instanceof DownloadSessionFieldError) return { kind: 'invalid', reason: 'field', field: error.field };
    throw error;
  }
}

export function invalidDownloadSessionMessage(result: Extract<DownloadSessionReadResult, { kind: "invalid" }>) {
  const field = result.field ? ` (${result.field})` : "";
  return `download session manifest is invalid: ${result.reason}${field}`;
}

export interface PreparedDownloadSession {
  manifest: DownloadSessionManifest;
  missingPages: DownloadPageSnapshot[];
  recoveredPages: number;
  incompatibleFragmentsMoved: number;
  unavailable: boolean;
}

export interface DownloadRecoverySummary {
  resumableSessions: number;
  completedPages: number;
  totalPages: number;
  retainedBytes: number;
  legacyDirectories: number;
  legacyBytes: number;
  cleanupEligibleBytes: number;
}

export interface DownloadCacheInspection {
  usedBytes: number;
  fileCount: number;
  exportableBytes: number;
  exportableFiles: number;
  recovery: DownloadRecoverySummary;
}

export interface DownloadCleanupResult {
  removedFiles: number;
  removedRelativePaths: string[];
  removedDirectories: number;
  removedBytes: number;
  retainedBytes: number;
  removedDirectory: boolean;
}

export interface DownloadCleanupAuthorization {
  relativePath: string;
  expectedSize: number;
  manifestSessionId?: string;
  expectedIdentity?: { dev: number; ino: number; mtimeMs: number; ctimeMs: number };
}

export interface DownloadCleanupOptions {
  /**
   * Restrict deletion to manifest paths that have been independently confirmed
   * as uploaded. Without an explicit set, all media and the manifest are retained.
   */
  confirmedRelativePaths?: Iterable<string>;
  /**
   * Persistent, manifest-bound authorization used by the scheduler. The
   * expected size and session id are checked again immediately before unlink.
   */
  authorizedFiles?: Iterable<DownloadCleanupAuthorization>;
  canDelete?: () => boolean;
  /** Keep the manifest when some tracked outputs still need upload. */
  preserveManifest?: boolean;
}

export interface Aria2TrackRecoveryIssue {
  pageIndex: number;
  track: "video" | "audio";
  reason: "range" | "length" | "control";
}

function nowIso() {
  return new Date().toISOString();
}

function safeStamp(value = nowIso()) {
  return value.replace(/[-:.]/g, "").replace(/Z$/, "Z");
}

export function downloadSessionPath(downloadDir: string) {
  return path.join(downloadDir, DOWNLOAD_SESSION_FILE);
}

function configSnapshot(config: AppConfig): DownloadSessionManifest["configSnapshot"] {
  return {
    quality: String(config.bbdownQuality || ""),
    encoding: String(config.bbdownEncoding || ""),
    encodingPriority: normalizeBBDownEncodingPriority(config.bbdownEncodingPriority, config.bbdownEncoding),
    apiMode: config.bbdownApiMode === "app" ? "app" : "web",
    hiRes: Boolean(config.bbdownHiRes),
    dolby: Boolean(config.bbdownDolby),
    filenameTemplate: String(config.filenameTemplate || "<videoTitle>-<bvid>"),
  };
}

export function buildDownloadConfigFingerprint(config: AppConfig, accountUid: number) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ accountUid, bbdownCommit: BBDOWN_SOURCE_COMMIT, ...configSnapshot(config) }))
    .digest("hex");
}

export function readDownloadSession(downloadDir: string): DownloadSessionReadResult {
  const filePath = downloadSessionPath(downloadDir);
  try {
    return decodeDownloadSession(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    if (error instanceof SyntaxError) return { kind: "invalid", reason: "json" };
    throw error;
  }
}

function normalizeManifestRelativePath(value: unknown) {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return null;
  }
  const normalized = path.normalize(value.replace(/[\\/]+/g, path.sep));
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`) ? normalized : null;
}

function decodeManifestOutput(value: unknown, historical: false, field?: string): DownloadOutputRecord | null;
function decodeManifestOutput(value: unknown, historical: true, field?: string): HistoricalOutputRecord | null;
function decodeManifestOutput(value: unknown, historical: boolean, field = "outputs"): DownloadOutputRecord | HistoricalOutputRecord | null {
  const output = sessionRecord(value);
  const relativePath = output && typeof output.relativePath === 'string'
    ? normalizeManifestRelativePath(output.relativePath) : null;
  if (!output) return invalidSessionField(field);
  if (!isSafeInteger(output.pageIndex) || output.pageIndex < 1) return invalidSessionField(`${field}.pageIndex`);
  if (!isSafeInteger(output.cid) || output.cid < 1) return invalidSessionField(`${field}.cid`);
  if (!relativePath) return invalidSessionField(`${field}.relativePath`);
  if (typeof output.size !== 'number' || !Number.isFinite(output.size) || output.size < 0) return invalidSessionField(`${field}.size`);
  if (typeof output.duration !== 'number' || !Number.isFinite(output.duration) || output.duration < 0) return invalidSessionField(`${field}.duration`);
  if (typeof output.videoCodec !== 'string') return invalidSessionField(`${field}.videoCodec`);
  if (typeof output.quickHash !== 'string') return invalidSessionField(`${field}.quickHash`);
  if (typeof output.verifiedAt !== 'string' || !Number.isFinite(Date.parse(output.verifiedAt))) return invalidSessionField(`${field}.verifiedAt`);
  if (output.audioCodec !== undefined && typeof output.audioCodec !== 'string') return invalidSessionField(`${field}.audioCodec`);
  if (output.width !== undefined && (!isSafeInteger(output.width) || output.width <= 0)) return invalidSessionField(`${field}.width`);
  if (output.height !== undefined && (!isSafeInteger(output.height) || output.height <= 0)) return invalidSessionField(`${field}.height`);
  if (output.frameRate !== undefined && (typeof output.frameRate !== 'number' || !Number.isFinite(output.frameRate) || output.frameRate <= 0)) return invalidSessionField(`${field}.frameRate`);
  const base: DownloadOutputRecord = {
    pageIndex: output.pageIndex,
    cid: output.cid,
    relativePath,
    size: output.size,
    duration: output.duration,
    videoCodec: output.videoCodec,
    ...(typeof output.audioCodec === 'string' ? { audioCodec: output.audioCodec } : {}),
    ...(typeof output.width === 'number' ? { width: output.width } : {}),
    ...(typeof output.height === 'number' ? { height: output.height } : {}),
    ...(typeof output.frameRate === 'number' ? { frameRate: output.frameRate } : {}),
    quickHash: output.quickHash,
    verifiedAt: output.verifiedAt,
  };
  if (!historical) return base;
  const reason = output.reason;
  if (typeof output.snapshotAt !== 'string' || !Number.isFinite(Date.parse(output.snapshotAt))
    || (reason !== 'removed' && reason !== 'replaced' && reason !== 'legacy_unmatched')) return invalidSessionField(`${field}.history`);
  if (output.uploadedTargets !== undefined && !isStringArray(output.uploadedTargets)) return invalidSessionField(`${field}.uploadedTargets`);
  return {
    ...base,
    snapshotAt: output.snapshotAt,
    reason,
    ...(isStringArray(output.uploadedTargets) ? { uploadedTargets: [...output.uploadedTargets] } : {}),
  };
}

function decodeManifestOutputList(value: unknown, historical: false): DownloadOutputRecord[] | null;
function decodeManifestOutputList(value: unknown, historical: true): HistoricalOutputRecord[] | null;
function decodeManifestOutputList(value: unknown, historical: boolean): DownloadOutputRecord[] | HistoricalOutputRecord[] | null {
  if (!Array.isArray(value)) return null;
  const identities = new Set<string>();
  if (historical) {
    const outputs: HistoricalOutputRecord[] = [];
    for (const item of value) {
      const decoded = decodeManifestOutput(item, true, `history[${outputs.length}]`);
      if (!decoded) return null;
      const identity = `${decoded.pageIndex}:${decoded.cid}:${decoded.relativePath}`;
      if (identities.has(identity)) return invalidSessionField(`${historical ? "history" : "outputs"}[${outputs.length}].identity`);
      identities.add(identity);
      outputs.push(decoded);
    }
    return outputs;
  }
  const outputs: DownloadOutputRecord[] = [];
  for (const item of value) {
    const decoded = decodeManifestOutput(item, false, `outputs[${outputs.length}]`);
    if (!decoded) return null;
    const identity = `${decoded.pageIndex}:${decoded.cid}:${decoded.relativePath}`;
    if (identities.has(identity)) return invalidSessionField(`${historical ? "history" : "outputs"}[${outputs.length}].identity`);
    identities.add(identity);
    outputs.push(decoded);
  }
  return outputs;
}

function normalizeManifestOutputPaths<T extends DownloadOutputRecord | HistoricalOutputRecord>(value: readonly T[]): T[] {
  return value.map((output) => {
    const relativePath = normalizeManifestRelativePath(output.relativePath);
    if (!relativePath) throw new Error('Invalid download session output path');
    return { ...output, relativePath };
  });
}

function sessionEncodingPriority(snapshot: DownloadSessionManifest["configSnapshot"]) {
  return normalizeBBDownEncodingPriority(snapshot.encodingPriority, snapshot.encoding);
}

function decodeSelectedStreams(value: unknown): DownloadSelectedStreamRecord[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const selected = new Map<number, DownloadSelectedStreamRecord>();
  for (const [index, item] of value.entries()) {
    const itemRecord = record(item);
    const pageIndex = itemRecord.pageIndex;
    const cid = itemRecord.cid;
    const bilibiliQuality = normalizeBilibiliQualityLabel(itemRecord.bilibiliQuality);
    if (!isSafeInteger(pageIndex) || pageIndex < 1) return invalidSessionField(`selectedStreams[${index}].pageIndex`);
    if (!isSafeInteger(cid) || cid < 1 || selected.has(cid)) return invalidSessionField(`selectedStreams[${index}].cid`);
    if (!bilibiliQuality) return invalidSessionField(`selectedStreams[${index}].bilibiliQuality`);
    if (typeof itemRecord.observedAt !== 'string' || !Number.isFinite(Date.parse(itemRecord.observedAt))) return invalidSessionField(`selectedStreams[${index}].observedAt`);
    selected.set(cid, { pageIndex, cid, bilibiliQuality, observedAt: new Date(itemRecord.observedAt).toISOString() });
  }
  return [...selected.values()].sort((left, right) => left.pageIndex - right.pageIndex);
}

export function writeDownloadSession(downloadDir: string, manifest: DownloadSessionManifest) {
  manifest.updatedAt = nowIso();
  // Persist paths in the same normalized form that readers and cleanup use.
  // This keeps manifests portable between Windows and Linux runtimes.
  manifest.outputs = normalizeManifestOutputPaths(manifest.outputs);
  manifest.history = normalizeManifestOutputPaths(manifest.history);
  writeJsonFile(downloadSessionPath(downloadDir), manifest);
}

export function buildUploadFileMetadataFromSession(
  downloadDir: string,
  files: string[],
  options: { requireVerifiedMediaMetadata?: boolean } = {}
) {
  const requireVerifiedMediaMetadata = Boolean(options.requireVerifiedMediaMetadata);
  const session = readDownloadSession(downloadDir);
  if (session.kind === "invalid") throw new Error(`Upload metadata preflight failed: ${invalidDownloadSessionMessage(session)}`);
  if (session.kind === "missing") {
    if (requireVerifiedMediaMetadata) throw new Error("Upload metadata preflight failed: download session manifest is missing");
    return undefined;
  }
  const manifest = session.manifest;

  const selectedPaths = [...new Set(files.map((file) => file.replace(/\\/g, "/")).filter(Boolean))];
  if (requireVerifiedMediaMetadata && selectedPaths.length === 0) {
    throw new Error("Upload metadata preflight failed: output file list is empty");
  }
  const requested = new Set(selectedPaths);
  const matched = new Set<string>();
  const selectedStreams = new Map((manifest.selectedStreams || []).map((item) => [item.cid, item] as const));
  const pages = new Map(manifest.pages.map((page) => [page.cid, page] as const));
  const result: Record<string, UploadFileMetadata> = {};
  let missingMediaMetadata = 0;

  for (const output of manifest.outputs) {
    const relativePath = output.relativePath.replace(/\\/g, "/");
    if (!requested.has(relativePath)) continue;
    matched.add(relativePath);
    const hasVerifiedMediaMetadata = output.width !== undefined && output.height !== undefined;
    if (!hasVerifiedMediaMetadata) missingMediaMetadata += 1;

    const page = pages.get(output.cid);
    const selectedStream = selectedStreams.get(output.cid);
    const codec = normalizeActualCodec(output.videoCodec);
    const mediaMetadata = output.width && output.height ? {
      width: output.width,
      height: output.height,
      duration: output.duration,
      fps: output.frameRate,
      codec,
      source: "ffprobe" as const,
      observedAt: output.verifiedAt,
    } : undefined;
    result[relativePath] = {
      publishDate: manifest.publishedAt,
      videoDate: page?.publishedAt || manifest.publishedAt,
      cid: output.cid,
      pageIndex: output.pageIndex,
      bilibiliQuality: selectedStream?.bilibiliQuality,
      dfn: actualQualityLabel(mediaMetadata),
      videoCodecs: codec,
      mediaMetadata,
    };
  }

  if (requireVerifiedMediaMetadata) {
    const missingOutputs = selectedPaths.length - matched.size;
    if (missingOutputs > 0 || missingMediaMetadata > 0) {
      const reasons = [
        missingOutputs > 0 ? `${missingOutputs} output file(s) are absent from the download session` : "",
        missingMediaMetadata > 0 ? `${missingMediaMetadata} output file(s) lack verified ffprobe dimensions` : "",
      ].filter(Boolean);
      throw new Error(`Upload metadata preflight failed: ${reasons.join("; ")}`);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizedSessionPath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function assessStrictEncoding(
  downloadDir: string,
  requestedEncoding: BBDownEncoding,
  files?: string[],
): StrictEncodingAssessment {
  const session = readDownloadSession(downloadDir);
  const requested = requestedEncoding;
  if (session.kind !== "valid") {
    return {
      status: "unknown",
      requestedEncoding: requested,
      actualEncodings: ["UNKNOWN"],
      encodingMismatch: true,
      verifiedPages: 0,
      totalPages: 0,
      mismatchedFiles: [],
      unknownFiles: [],
      summary: `请求 ${requested}，下载清单${session.kind === "invalid" ? "损坏" : "缺失"}，无法取得已验证编码；未上传候选，也未执行归档替换。`,
    };
  }
  const manifest = session.manifest;

  const outputs = [...manifest.outputs];
  const outputPaths = outputs.map((output) => normalizedSessionPath(output.relativePath));
  const selectedPaths = files && files.length > 0
    ? [...new Set(files.map(normalizedSessionPath).filter(Boolean))]
    : outputPaths;
  const selectedSet = new Set(selectedPaths);
  const outputSet = new Set(outputPaths);
  const fileListMatchesManifest = selectedPaths.length === outputPaths.length
    && outputPaths.every((relativePath) => selectedSet.has(relativePath));
  const fileListMismatchPaths = [
    ...outputPaths.filter((relativePath) => !selectedSet.has(relativePath)),
    ...selectedPaths.filter((relativePath) => !outputSet.has(relativePath)),
  ];
  const actualEncodings = new Set<string>();
  const mismatchedFiles: string[] = [];
  const unknownFiles: string[] = [];
  let verifiedPages = 0;

  for (const output of outputs) {
    const relativePath = normalizedSessionPath(output.relativePath);
    const codec = normalizeActualCodec(output.videoCodec);
    if (!codec) {
      unknownFiles.push(relativePath);
      continue;
    }
    verifiedPages += 1;
    actualEncodings.add(codec);
    if (codec !== requested) mismatchedFiles.push(relativePath);
  }

  const pageCids = new Set(manifest.pages.map((page) => page.cid));
  const outputCids = new Set(outputs.map((output) => output.cid));
  const allPagesPresent = manifest.pages.length > 0
    && [...pageCids].every((cid) => outputCids.has(cid));
  const hasUnknownState = unknownFiles.length > 0 || !fileListMatchesManifest || !allPagesPresent;
  const status: StrictEncodingAssessmentStatus = mismatchedFiles.length > 0
    ? "mismatch"
    : hasUnknownState
      ? "unknown"
      : "matched";
  const actual = [...actualEncodings].sort();
  const displayActual = actual.length > 0 ? actual.join("、") : "未知";
  const missingPageCount = Math.max(0, manifest.pages.length - outputCids.size);
  const summary = status === "mismatch"
    ? `请求 ${requested}，但实际文件编码为 ${displayActual}；未上传候选，也未执行归档替换。`
    : status === "unknown"
      ? !fileListMatchesManifest
        ? `请求 ${requested}，下载输出与待上传文件清单不一致，无法确认全部分P编码；未上传候选，也未执行归档替换。`
        : `请求 ${requested}，有 ${Math.max(unknownFiles.length, missingPageCount)} 个分P未取得可验证编码（已验证 ${verifiedPages}/${manifest.pages.length}）；未上传候选，也未执行归档替换。`
      : `请求 ${requested}，全部 ${verifiedPages} 个分P已验证为 ${displayActual}。`;

  return {
    status,
    requestedEncoding: requested,
    actualEncodings: actual.length > 0 ? actual : ["UNKNOWN"],
    encodingMismatch: status !== "matched",
    verifiedPages,
    totalPages: manifest.pages.length,
    mismatchedFiles,
    unknownFiles: [
      ...unknownFiles,
      ...fileListMismatchPaths,
    ],
    summary,
  };
}

export function assessStrictQuality(
  downloadDir: string,
  requestedQuality: string,
  files?: string[],
): StrictQualityAssessment {
  const session = readDownloadSession(downloadDir);
  const requested = normalizeBilibiliQualityLabel(requestedQuality) || String(requestedQuality || "").trim().toUpperCase();
  if (session.kind !== "valid" || !requested) {
    return {
      status: "unknown",
      requestedQuality: requested || String(requestedQuality || "").trim(),
      actualQualities: ["UNKNOWN"],
      qualityMismatch: true,
      verifiedPages: 0,
      totalPages: session.kind === "valid" ? session.manifest.pages.length : 0,
      mismatchedFiles: [],
      unknownFiles: [],
      summary: `请求 ${requested || "未知画质"}，${session.kind === "invalid" ? "下载清单损坏" : "下载清单或画质证明缺失"}；未上传候选，也未执行归档替换。`,
    };
  }
  const manifest = session.manifest;

  const outputs = [...manifest.outputs];
  const outputPaths = outputs.map((output) => normalizedSessionPath(output.relativePath));
  const selectedPaths = files && files.length > 0
    ? [...new Set(files.map(normalizedSessionPath).filter(Boolean))]
    : outputPaths;
  const selectedSet = new Set(selectedPaths);
  const outputSet = new Set(outputPaths);
  const fileListMatchesManifest = selectedPaths.length === outputPaths.length
    && outputPaths.every((relativePath) => selectedSet.has(relativePath));
  const fileListMismatchPaths = [
    ...outputPaths.filter((relativePath) => !selectedSet.has(relativePath)),
    ...selectedPaths.filter((relativePath) => !outputSet.has(relativePath)),
  ];
  const selectedStreams = new Map((manifest.selectedStreams || []).map((item) => [item.cid, item] as const));
  const actualQualities = new Set<string>();
  const mismatchedFiles: string[] = [];
  const unknownFiles: string[] = [];
  let verifiedPages = 0;

  for (const output of outputs) {
    const relativePath = normalizedSessionPath(output.relativePath);
    const selected = selectedStreams.get(output.cid);
    const actual = normalizeBilibiliQualityLabel(selected?.bilibiliQuality);
    if (!selected || !actual) {
      unknownFiles.push(relativePath);
      continue;
    }
    verifiedPages += 1;
    actualQualities.add(actual);
    if (actual !== requested) mismatchedFiles.push(relativePath);
  }

  const pageCids = new Set(manifest.pages.map((page) => page.cid));
  const outputCids = new Set(outputs.map((output) => output.cid));
  const allPagesPresent = manifest.pages.length > 0
    && [...pageCids].every((cid) => outputCids.has(cid));
  const hasUnknownState = unknownFiles.length > 0 || !fileListMatchesManifest || !allPagesPresent;
  const status: StrictQualityAssessmentStatus = mismatchedFiles.length > 0
    ? "mismatch"
    : hasUnknownState
      ? "unknown"
      : "matched";
  const actual = [...actualQualities].sort();
  const displayActual = actual.length > 0 ? actual.join("、") : "未知";
  const missingPageCount = Math.max(0, manifest.pages.length - outputCids.size);
  const summary = status === "mismatch"
    ? `请求 ${requested}，但 BBDown 选择的实际画质为 ${displayActual}；未上传候选，也未执行归档替换。`
    : status === "unknown"
      ? !fileListMatchesManifest
        ? `请求 ${requested}，下载输出与待上传文件清单不一致，无法确认全部分P画质；未上传候选，也未执行归档替换。`
        : `请求 ${requested}，有 ${Math.max(unknownFiles.length, missingPageCount)} 个分P未取得可验证画质（已验证 ${verifiedPages}/${manifest.pages.length}）；未上传候选，也未执行归档替换。`
      : `请求 ${requested}，全部 ${verifiedPages} 个分P已验证为 ${displayActual}。`;

  return {
    status,
    requestedQuality: requested,
    actualQualities: actual.length > 0 ? actual : ["UNKNOWN"],
    qualityMismatch: status !== "matched",
    verifiedPages,
    totalPages: manifest.pages.length,
    mismatchedFiles,
    unknownFiles: [...unknownFiles, ...fileListMismatchPaths],
    summary,
  };
}

function ffprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.env.FFMPEG_PATH) {
    const extension = process.platform === "win32" ? ".exe" : "";
    const candidate = path.join(path.dirname(process.env.FFMPEG_PATH), `ffprobe${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "ffprobe";
}

async function runFfprobe(filePath: string) {
  const args = [
    "-v", "error",
    "-show_entries",
    "format=duration,size:stream=index,codec_type,codec_name,width,height,duration,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic",
    "-of", "json",
    filePath,
  ];
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(ffprobePath(), args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function quickFileHash(filePath: string, size: number) {
  const sampleSize = Math.min(1024 * 1024, size);
  const file = await fs.promises.open(filePath, "r");
  try {
    const first = Buffer.alloc(sampleSize);
    const last = Buffer.alloc(sampleSize);
    const firstRead = await file.read(first, 0, sampleSize, 0);
    const lastPosition = Math.max(0, size - sampleSize);
    const lastRead = await file.read(last, 0, sampleSize, lastPosition);
    return crypto
      .createHash("sha256")
      .update(String(size))
      .update(first.subarray(0, firstRead.bytesRead))
      .update(last.subarray(0, lastRead.bytesRead))
      .digest("hex");
  } finally {
    await file.close();
  }
}

export async function validateMediaOutput(
  filePath: string,
  expectedDuration = 0
): Promise<Omit<DownloadOutputRecord, "pageIndex" | "cid" | "relativePath" | "verifiedAt">> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("media file is empty");
  const info = record(await runFfprobe(filePath));
  const streams = Array.isArray(info.streams) ? info.streams.map(record) : [];
  const video = streams.find((stream) => stream.codec_type === "video" && Number(record(stream.disposition).attached_pic || 0) !== 1);
  if (!video) throw new Error("media file has no playable video stream");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(record(info.format).duration || video.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("media duration is unavailable");
  if (expectedDuration > 0) {
    const tolerance = Math.max(5, expectedDuration * 0.03);
    if (Math.abs(duration - expectedDuration) > tolerance) {
      throw new Error(`media duration mismatch: expected ${expectedDuration}s, received ${duration.toFixed(3)}s`);
    }
  }
  return {
    size: stat.size,
    duration,
    videoCodec: String(video.codec_name || "unknown"),
    audioCodec: audio?.codec_name ? String(audio.codec_name) : undefined,
    width: Number(video.width || 0) || undefined,
    height: Number(video.height || 0) || undefined,
    frameRate: parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate),
    quickHash: await quickFileHash(filePath, stat.size),
  };
}

function mediaFileName(value: string) {
  return /\.(mp4|mkv|flv|mov|m4v)$/i.test(value);
}

function inferPageIndex(fileName: string, pageCount: number) {
  if (pageCount === 1) return 1;
  const stem = fileName.replace(/\.[^.]+$/, "");
  const match = /_P0*(\d+)$/i.exec(stem);
  return match ? Number(match[1]) : 0;
}

async function listCandidateMediaFiles(downloadDir: string) {
  const files: string[] = [];
  const walk = async (currentDir: string, depth: number): Promise<void> => {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(downloadDir, fullPath);
      if (entry.isDirectory()) {
        if (entry.name.startsWith("_") || (depth === 0 && /^\d+$/.test(entry.name))) continue;
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && mediaFileName(entry.name)) {
        files.push(relativePath);
      }
    }
  };
  await walk(downloadDir, 0);
  return files;
}

async function movePreserving(source: string, target: string) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.rename(source, target);
  } catch (error: unknown) {
    if (!['EXDEV', 'EPERM', 'EACCES'].includes(errorCode(error))) throw error;
    await fs.promises.copyFile(source, target);
    await fs.promises.unlink(source);
  }
}

async function quarantineFile(downloadDir: string, fileName: string, group: "_invalid" | "_incompatible") {
  const source = path.join(downloadDir, fileName);
  const target = path.join(downloadDir, group, safeStamp(), fileName);
  await movePreserving(source, target);
  return path.relative(downloadDir, target);
}

function reindexedOutputPath(relativePath: string, oldIndex: number, newIndex: number) {
  if (oldIndex === newIndex) return relativePath;
  const directory = path.dirname(relativePath);
  const extension = path.extname(relativePath);
  const stem = path.basename(relativePath, extension);
  const match = /_P(\d+)$/i.exec(stem);
  if (!match || Number(match[1]) !== oldIndex) return relativePath;
  const nextPage = String(newIndex).padStart(match[1].length, "0");
  return path.join(directory, `${stem.slice(0, match.index)}_P${nextPage}${extension}`);
}

async function reindexRetainedOutputs(
  downloadDir: string,
  moves: Array<{ output: DownloadOutputRecord; from: string; to: string }>
) {
  if (moves.length === 0) return;
  const stageRoot = path.join(downloadDir, "_reindex", safeStamp());
  const staged: Array<{ output: DownloadOutputRecord; tempPath: string; targetRelative: string }> = [];
  for (let index = 0; index < moves.length; index += 1) {
    const move = moves[index];
    const source = path.join(downloadDir, move.from);
    if (!fs.existsSync(source)) continue;
    const tempPath = path.join(stageRoot, `${index}-${path.basename(move.from)}`);
    await movePreserving(source, tempPath);
    staged.push({ output: move.output, tempPath, targetRelative: move.to });
  }
  for (const item of staged) {
    let targetRelative = item.targetRelative;
    let target = path.join(downloadDir, targetRelative);
    if (fs.existsSync(target)) {
      const extension = path.extname(targetRelative);
      const stem = path.basename(targetRelative, extension);
      targetRelative = path.join(path.dirname(targetRelative), `${stem}-CID${item.output.cid}${extension}`);
      target = path.join(downloadDir, targetRelative);
    }
    await movePreserving(item.tempPath, target);
    item.output.relativePath = targetRelative;
  }
  await fs.promises.rm(stageRoot, { recursive: true, force: true }).catch((error) => {
    console.warn(`[DownloadSession] staged cleanup deferred: ${String(error)}`);
  });
}

function isUnsafeResumeArtifact(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (/\.(aria2|tmp|vclip|aclip|part|download)$/i.test(normalized)) return true;
  const parts = normalized.split("/");
  if (parts.length < 2 || !/^\d+$/.test(parts[0])) return false;
  const name = parts[parts.length - 1];
  return /\.P\d+\..*\.(mp4|m4a)$/i.test(name) || /\.P\d+\.back_ground\.m4a$/i.test(name);
}

async function quarantineIncompatibleFragments(downloadDir: string) {
  const stamp = safeStamp();
  let moved = 0;
  const walk = async (currentDir: string): Promise<void> => {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(currentDir, entry.name);
      const relativePath = path.relative(downloadDir, source);
      if (relativePath.split(path.sep).some((segment) => ["_history", "_invalid", "_incompatible"].includes(segment))) continue;
      if (entry.isDirectory()) {
        await walk(source);
        continue;
      }
      if (!entry.isFile() || !isUnsafeResumeArtifact(relativePath)) continue;
      const target = path.join(downloadDir, "_incompatible", stamp, relativePath);
      await movePreserving(source, target);
      moved += 1;
    }
  };
  await walk(downloadDir);
  return moved;
}

function matchesAria2Track(relativePath: string, issue: Aria2TrackRecoveryIssue) {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.length < 2 || !/^\d+$/.test(parts[0])) return false;
  const name = parts[parts.length - 1];
  if (!new RegExp(`\\.P0*${issue.pageIndex}(?:\\.|$)`, "i").test(name)) return false;
  return issue.track === "video"
    ? /\.mp4(?:\.aria2)?$/i.test(name)
    : /\.(?:m4a|aac)(?:\.aria2)?$/i.test(name);
}

export async function quarantineBrokenAria2Track(downloadDir: string, issue: Aria2TrackRecoveryIssue) {
  const candidates: string[] = [];
  const walk = async (currentDir: string): Promise<void> => {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(currentDir, entry.name);
      const relativePath = path.relative(downloadDir, source);
      if (relativePath.split(path.sep).some((segment) => ["_history", "_invalid", "_incompatible"].includes(segment))) continue;
      if (entry.isDirectory()) {
        await walk(source);
      } else if (entry.isFile() && matchesAria2Track(relativePath, issue)) {
        candidates.push(relativePath);
      }
    }
  };
  await walk(downloadDir);
  if (candidates.length === 0) return 0;
  const stamp = `aria2-reset-${safeStamp()}`;
  for (const relativePath of candidates) {
    await movePreserving(
      path.join(downloadDir, relativePath),
      path.join(downloadDir, "_incompatible", stamp, relativePath)
    );
  }
  return candidates.length;
}

async function reconcileChangedPages(downloadDir: string, manifest: DownloadSessionManifest, pages: DownloadPageSnapshot[]) {
  const currentByCid = new Map(pages.map((page) => [page.cid, page]));
  const currentByIndex = new Map(pages.map((page) => [page.index, page]));
  const retained: DownloadOutputRecord[] = [];
  const reindexMoves: Array<{ output: DownloadOutputRecord; from: string; to: string }> = [];
  for (const output of manifest.outputs) {
    const currentPage = currentByCid.get(output.cid);
    if (currentPage) {
      const retainedOutput = { ...output, pageIndex: currentPage.index };
      const nextRelativePath = reindexedOutputPath(output.relativePath, output.pageIndex, currentPage.index);
      if (nextRelativePath !== output.relativePath) {
        reindexMoves.push({ output: retainedOutput, from: output.relativePath, to: nextRelativePath });
      }
      retained.push(retainedOutput);
      continue;
    }
    const source = path.join(downloadDir, output.relativePath);
    if (!fs.existsSync(source)) continue;
    const reason: HistoricalOutputRecord["reason"] = currentByIndex.has(output.pageIndex) ? "replaced" : "removed";
    const historyRelative = path.join("_history", safeStamp(manifest.snapshotAt), path.basename(output.relativePath));
    await movePreserving(source, path.join(downloadDir, historyRelative));
    manifest.history.push({ ...output, relativePath: historyRelative, snapshotAt: manifest.snapshotAt, reason });
  }
  await reindexRetainedOutputs(downloadDir, reindexMoves);
  manifest.outputs = retained;
}

async function scanAndValidateOutputs(downloadDir: string, manifest: DownloadSessionManifest) {
  const candidateFiles = await listCandidateMediaFiles(downloadDir);
  const pagesByIndex = new Map(manifest.pages.map((page) => [page.index, page]));
  const existingByPath = new Map(manifest.outputs.map((output) => [output.relativePath, output]));
  const outputs: DownloadOutputRecord[] = [];
  for (const output of manifest.outputs) {
    const filePath = path.join(downloadDir, output.relativePath);
    const page = pagesByIndex.get(output.pageIndex);
    if (!fs.existsSync(filePath) || !page || page.cid !== output.cid) continue;
    try {
      const details = await validateMediaOutput(filePath, page.duration);
      if (output.quickHash && output.quickHash !== details.quickHash) throw new Error("media quick hash changed");
      outputs.push({ ...output, ...details, verifiedAt: nowIso() });
    } catch {
      if (path.dirname(output.relativePath) === ".") {
        await quarantineFile(downloadDir, output.relativePath, "_invalid");
      }
    }
  }
  const recordedPaths = new Set(outputs.map((output) => output.relativePath));
  for (const relativePath of candidateFiles) {
    if (recordedPaths.has(relativePath)) continue;
    const fileName = path.basename(relativePath);
    const pageIndex = existingByPath.get(relativePath)?.pageIndex || inferPageIndex(fileName, manifest.pages.length);
    const page = pagesByIndex.get(pageIndex);
    if (!page) {
      const details = await validateMediaOutput(path.join(downloadDir, relativePath), 0).catch((error) => {
        console.debug(`[DownloadSession] legacy output validation skipped: ${String(error)}`);
        return null;
      });
      if (details) {
        const historyRelative = path.join("_history", safeStamp(manifest.snapshotAt), fileName);
        await movePreserving(path.join(downloadDir, relativePath), path.join(downloadDir, historyRelative));
        manifest.history.push({
          ...details,
          pageIndex: pageIndex || 0,
          cid: 0,
          relativePath: historyRelative,
          verifiedAt: nowIso(),
          snapshotAt: manifest.snapshotAt,
          reason: "legacy_unmatched",
        });
      } else {
        await quarantineFile(downloadDir, relativePath, "_invalid");
      }
      continue;
    }
    try {
      const details = await validateMediaOutput(path.join(downloadDir, relativePath), page.duration);
      outputs.push({
        ...details,
        pageIndex: page.index,
        cid: page.cid,
        relativePath,
        verifiedAt: nowIso(),
      });
      recordedPaths.add(relativePath);
    } catch {
      await quarantineFile(downloadDir, relativePath, "_invalid");
    }
  }
  const uniqueByCid = new Map<number, DownloadOutputRecord>();
  for (const output of outputs) {
    if (output.cid && !uniqueByCid.has(output.cid)) uniqueByCid.set(output.cid, output);
  }
  manifest.outputs = [...uniqueByCid.values()].sort((a, b) => a.pageIndex - b.pageIndex);
}

export async function prepareDownloadSession(options: {
  downloadDir: string;
  bvid: string;
  accountUid: number;
  config: AppConfig;
  kind?: DownloadSessionKind;
  pages: DownloadPageSnapshot[];
  publishedAt?: number;
  unavailable?: boolean;
  qualityUpgrade?: DownloadSessionManifest["qualityUpgrade"];
  /** Keep a strict encoding candidate out of the complete state until ffprobe is checked. */
  deferCompleteStatus?: boolean;
}) : Promise<PreparedDownloadSession> {
  const { downloadDir, bvid, accountUid, config } = options;
  await fs.promises.mkdir(downloadDir, { recursive: true });
  const fingerprint = buildDownloadConfigFingerprint(config, accountUid);
  const session = readDownloadSession(downloadDir);
  let manifest = session.kind === "valid" ? session.manifest : null;
  let incompatibleFragmentsMoved = 0;
  if (!manifest || manifest.bvid !== bvid) {
    const existingManifestPath = downloadSessionPath(downloadDir);
    if (session.kind === "invalid") {
      const preservedPath = `${existingManifestPath}.corrupt-${safeStamp()}-${crypto.randomUUID()}`;
      await fs.promises.copyFile(existingManifestPath, preservedPath);
    }
    const at = nowIso();
    manifest = {
      schemaVersion: 1,
      sessionId: crypto.randomUUID(),
      kind: options.kind || "backup",
      bvid,
      accountUid,
      bbdownCommit: BBDOWN_SOURCE_COMMIT,
      configFingerprint: fingerprint,
      configSnapshot: configSnapshot(config),
      createdAt: at,
      updatedAt: at,
      snapshotAt: at,
      publishedAt: options.publishedAt,
      status: "prepared",
      pages: options.pages,
      outputs: [],
      history: [],
      qualityUpgrade: options.qualityUpgrade,
      legacyAdopted: fs.readdirSync(downloadDir).some((name) => name !== DOWNLOAD_SESSION_FILE),
    };
  } else {
    if (options.qualityUpgrade) manifest.qualityUpgrade = options.qualityUpgrade;
    if (manifest.configFingerprint !== fingerprint || manifest.accountUid !== accountUid || manifest.bbdownCommit !== BBDOWN_SOURCE_COMMIT) {
      const nextSnapshot = configSnapshot(config);
      const previousSnapshot = manifest.configSnapshot;
      const sameRuntimeConfig = manifest.accountUid === accountUid
        && previousSnapshot.quality === nextSnapshot.quality
        && previousSnapshot.encoding === nextSnapshot.encoding
        && JSON.stringify(sessionEncodingPriority(previousSnapshot)) === JSON.stringify(sessionEncodingPriority(nextSnapshot))
        && previousSnapshot.hiRes === nextSnapshot.hiRes
        && previousSnapshot.dolby === nextSnapshot.dolby
        && previousSnapshot.filenameTemplate === nextSnapshot.filenameTemplate;
      const compatibleSameApiBbdownUpgrade = [PREVIOUS_BBDOWN_2_0_6_COMMIT, PREVIOUS_BBDOWN_PATCH_COMMIT, PREVIOUS_BBDOWN_INTERACTIVE_COMMIT, PREVIOUS_BBDOWN_SOURCE_COMMIT].includes(manifest.bbdownCommit)
        && previousSnapshot.apiMode === nextSnapshot.apiMode
        && sameRuntimeConfig;
      const compatibleBbdownUpgrade = compatibleSameApiBbdownUpgrade || (
        [
          PREVIOUS_BBDOWN_PROBE_COMMIT,
          LEGACY_BBDOWN_SOURCE_COMMIT,
          HISTORIC_BBDOWN_SOURCE_COMMIT,
        ].includes(manifest.bbdownCommit)
        && previousSnapshot.apiMode === nextSnapshot.apiMode
        && nextSnapshot.apiMode !== "app"
        && sameRuntimeConfig
      );
      const legacyWebUpgrade = !previousSnapshot.apiMode
        && nextSnapshot.apiMode === "web"
        && sameRuntimeConfig
        && (
          manifest.bbdownCommit === BBDOWN_SOURCE_COMMIT
          || manifest.bbdownCommit === PREVIOUS_BBDOWN_2_0_6_COMMIT
          || manifest.bbdownCommit === PREVIOUS_BBDOWN_PATCH_COMMIT
          || manifest.bbdownCommit === PREVIOUS_BBDOWN_INTERACTIVE_COMMIT
          || manifest.bbdownCommit === PREVIOUS_BBDOWN_SOURCE_COMMIT
          || manifest.bbdownCommit === PREVIOUS_BBDOWN_PROBE_COMMIT
          || manifest.bbdownCommit === LEGACY_BBDOWN_SOURCE_COMMIT
          || manifest.bbdownCommit === HISTORIC_BBDOWN_SOURCE_COMMIT
          || manifest.bbdownCommit === OLDEST_HISTORIC_BBDOWN_SOURCE_COMMIT
        );
      if (!legacyWebUpgrade && !compatibleBbdownUpgrade) {
        incompatibleFragmentsMoved = await quarantineIncompatibleFragments(downloadDir);
      }
      manifest.configFingerprint = fingerprint;
      manifest.configSnapshot = nextSnapshot;
      manifest.accountUid = accountUid;
      manifest.bbdownCommit = BBDOWN_SOURCE_COMMIT;
    }
    if (options.pages.length > 0) {
      await reconcileChangedPages(downloadDir, manifest, options.pages);
      manifest.pages = options.pages;
      manifest.snapshotAt = nowIso();
    }
    if (options.publishedAt) manifest.publishedAt = options.publishedAt;
  }
  await scanAndValidateOutputs(downloadDir, manifest);
  if (options.unavailable && manifest.outputs.length === 0 && manifest.history.length > 0) {
    manifest.outputs = manifest.history.map(({ snapshotAt: _snapshotAt, reason: _reason, uploadedTargets: _uploadedTargets, ...output }) => output);
    manifest.history = [];
  }
  const completedCids = new Set(manifest.outputs.map((output) => output.cid));
  const missingPages = manifest.pages.filter((page) => !completedCids.has(page.cid));
  manifest.status = missingPages.length === 0 && manifest.pages.length > 0
    ? options.deferCompleteStatus ? "prepared" : "complete"
    : options.unavailable && manifest.outputs.length > 0
      ? "partial"
      : "prepared";
  manifest.lastError = undefined;
  writeDownloadSession(downloadDir, manifest);
  return {
    manifest,
    missingPages,
    recoveredPages: manifest.outputs.length,
    incompatibleFragmentsMoved,
    unavailable: Boolean(options.unavailable),
  };
}

export async function refreshDownloadSessionOutputs(
  downloadDir: string,
  options: { deferCompleteStatus?: boolean } = {},
) {
  const session = readDownloadSession(downloadDir);
  if (session.kind === "missing") throw new Error(`Download session manifest is missing: ${downloadDir}`);
  if (session.kind === "invalid") throw new Error(`${invalidDownloadSessionMessage(session)}: ${downloadDir}`);
  const manifest = session.manifest;
  await scanAndValidateOutputs(downloadDir, manifest);
  const completedCids = new Set(manifest.outputs.map((output) => output.cid));
  const missingPages = manifest.pages.filter((page) => !completedCids.has(page.cid));
  manifest.status = missingPages.length === 0 && manifest.pages.length > 0 && !options.deferCompleteStatus
    ? "complete"
    : "prepared";
  writeDownloadSession(downloadDir, manifest);
  return { manifest, missingPages };
}

export function markDownloadSessionStatus(downloadDir: string, status: DownloadSessionStatus, error?: string) {
  const session = readDownloadSession(downloadDir);
  if (session.kind === "missing") return;
  if (session.kind === "invalid") throw new Error(invalidDownloadSessionMessage(session));
  const manifest = session.manifest;
  manifest.status = status;
  manifest.lastError = error;
  writeDownloadSession(downloadDir, manifest);
}

export function buildSelectPageArgument(pages: DownloadPageSnapshot[]) {
  const indexes = [...new Set(pages.map((page) => page.index).filter((value) => value > 0))].sort((a, b) => a - b);
  const groups: string[] = [];
  for (let start = 0; start < indexes.length;) {
    let end = start;
    while (end + 1 < indexes.length && indexes[end + 1] === indexes[end] + 1) end += 1;
    groups.push(end > start + 1 ? `${indexes[start]}-${indexes[end]}` : indexes.slice(start, end + 1).join(","));
    start = end + 1;
  }
  return groups.join(",");
}

export function currentSessionFiles(downloadDir: string) {
  const session = readDownloadSession(downloadDir);
  if (session.kind === "invalid") throw new Error(invalidDownloadSessionMessage(session));
  return session.kind === "valid" ? session.manifest.outputs.map((output) => output.relativePath) : [];
}

export function historySessionGroups(downloadDir: string) {
  const session = readDownloadSession(downloadDir);
  if (session.kind === "invalid") throw new Error(invalidDownloadSessionMessage(session));
  if (session.kind === "missing") return [];
  return groupDownloadSessionHistory(session.manifest);
}

export function groupDownloadSessionHistory(manifest: DownloadSessionManifest) {
  const groups = new Map<string, HistoricalOutputRecord[]>();
  for (const output of manifest.history) {
    const list = groups.get(output.snapshotAt) || [];
    list.push(output);
    groups.set(output.snapshotAt, list);
  }
  return [...groups.entries()].map(([snapshotAt, files]) => ({ snapshotAt, files }));
}

export function markHistoryGroupUploaded(downloadDir: string, snapshotAt: string, targetKey: string) {
  const session = readDownloadSession(downloadDir);
  if (session.kind === "invalid") throw new Error(invalidDownloadSessionMessage(session));
  if (session.kind === "missing") return;
  const manifest = session.manifest;
  let changed = false;
  for (const output of manifest.history) {
    if (output.snapshotAt !== snapshotAt) continue;
    output.uploadedTargets ||= [];
    if (!output.uploadedTargets.includes(targetKey)) {
      output.uploadedTargets.push(targetKey);
      changed = true;
    }
  }
  if (changed) writeDownloadSession(downloadDir, manifest);
}

async function removeEmptyDirectories(target: string, root: string): Promise<void> {
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(target, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(target, entry.name), root);
  }
  if (target === root) return;
  try {
    if ((await fs.promises.readdir(target)).length === 0) await fs.promises.rmdir(target);
  } catch (error) {
    console.debug('[DownloadSession] directory changed during empty-directory cleanup', error);
  }
}

export async function cleanupUploadedSessionFiles(downloadDir: string, options: DownloadCleanupOptions = {}) {
  if (options.confirmedRelativePaths === undefined && options.authorizedFiles === undefined) {
    return { removedFiles: 0, removedRelativePaths: [], removedDirectories: 0, removedBytes: 0, removedDirectory: false, retainedBytes: directorySizeSync(downloadDir) };
  }
  const session = readDownloadSession(downloadDir);
  if (session.kind === "invalid") {
    return { removedFiles: 0, removedRelativePaths: [], removedDirectories: 0, removedBytes: 0,
      removedDirectory: false, retainedBytes: directorySizeSync(downloadDir) };
  }
  if (session.kind === "missing") {
    let remaining: string[] = [];
    try { remaining = await fs.promises.readdir(downloadDir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { removedFiles: 0, removedRelativePaths: [], removedDirectories: 0, removedBytes: 0, removedDirectory: true, retainedBytes: 0 };
    }
    if (remaining.length === 0) {
      await fs.promises.rmdir(downloadDir);
      return { removedFiles: 0, removedRelativePaths: [], removedDirectories: 1, removedBytes: 0, removedDirectory: true, retainedBytes: 0 };
    }
    const retainedBytes = directorySizeSync(downloadDir);
    writeJsonFile(path.join(downloadDir, DOWNLOAD_RETAINED_FILE), {
      schemaVersion: 1,
      bvid: path.basename(downloadDir),
      retainedAt: nowIso(),
      reason: "The download session manifest was missing during cleanup; all local files were preserved.",
    });
    return { removedFiles: 0, removedRelativePaths: [], removedDirectories: 0, removedBytes: 0, removedDirectory: false, retainedBytes };
  }
  const manifest = session.manifest;
  const manifestPaths = new Set([
    ...manifest.outputs.map((output) => output.relativePath),
    ...manifest.history.map((output) => output.relativePath),
  ]);
  const authorized = new Map<string, DownloadCleanupAuthorization>();
  if (options.authorizedFiles !== undefined) {
    for (const item of options.authorizedFiles) {
      const relativePath = normalizeManifestRelativePath(item?.relativePath);
      const expectedSize = Number(item?.expectedSize);
      if (!relativePath || !manifestPaths.has(relativePath) || !Number.isFinite(expectedSize) || expectedSize < 0) continue;
      if (item.manifestSessionId && item.manifestSessionId !== manifest.sessionId) continue;
      authorized.set(relativePath, { relativePath, expectedSize, manifestSessionId: item.manifestSessionId, expectedIdentity: item.expectedIdentity });
    }
  }
  if (options.authorizedFiles === undefined && options.confirmedRelativePaths !== undefined) {
    for (const value of options.confirmedRelativePaths) {
      const relativePath = normalizeManifestRelativePath(value);
      if (!relativePath || !manifestPaths.has(relativePath) || authorized.has(relativePath)) continue;
      const expected = [...manifest.outputs, ...manifest.history].find((output) => output.relativePath === relativePath);
      if (expected) {
        authorized.set(relativePath, { relativePath, expectedSize: expected.size });
      }
    }
  }
  let removedFiles = 0;
  let removedBytes = 0;
  const removedPaths = new Set<string>();
  const realRoot = await fs.promises.realpath(downloadDir);
  for (const [relativePath, authorization] of authorized) {
    try {
      const target = path.join(downloadDir, relativePath);
      const realTarget = await fs.promises.realpath(target);
      const relativeTarget = path.relative(realRoot, realTarget);
      if (relativeTarget.startsWith(`..${path.sep}`) || relativeTarget === ".." || path.isAbsolute(relativeTarget)) continue;
      const stat = await fs.promises.lstat(target);
      if (!stat.isFile()) continue;
      const expected = [...manifest.outputs, ...manifest.history].find((output) => output.relativePath === relativePath);
      if (!expected || stat.size !== expected.size || stat.size !== authorization.expectedSize) continue;
      // Keep the final application-state check and unlink in one event-loop turn.
      const currentSession = readDownloadSession(downloadDir);
      if (currentSession.kind !== "valid" || JSON.stringify(currentSession.manifest) !== JSON.stringify(manifest)) break;
      if (options.canDelete && !options.canDelete()) break;
      const currentStat = fs.lstatSync(target);
      const identity = authorization.expectedIdentity || stat;
      if (!currentStat.isFile() || currentStat.size !== authorization.expectedSize
        || currentStat.dev !== identity.dev || currentStat.ino !== identity.ino
        || currentStat.mtimeMs !== identity.mtimeMs || currentStat.ctimeMs !== identity.ctimeMs) continue;
      fs.unlinkSync(target);
      removedPaths.add(relativePath);
      removedFiles += 1;
      removedBytes += stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") removedPaths.add(relativePath);
    }
  }
  // An asynchronous file inspection may have yielded to a new download. Never
  // reconcile an old snapshot over its manifest, even when some files were removed.
  const latestSession = readDownloadSession(downloadDir);
  if (latestSession.kind !== "valid" || JSON.stringify(latestSession.manifest) !== JSON.stringify(manifest)) {
    return { removedFiles, removedRelativePaths: [...removedPaths], removedDirectories: 0,
      removedBytes, removedDirectory: false, retainedBytes: directorySizeSync(downloadDir) };
  }
  const preserveManifest = options.preserveManifest || [...manifestPaths].some((file) => !removedPaths.has(file));
  if (!preserveManifest) {
    try { fs.unlinkSync(downloadSessionPath(downloadDir)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } else if (removedPaths.size > 0) {
    const confirmed = removedPaths;
    manifest.outputs = manifest.outputs.filter((output) => !confirmed.has(output.relativePath));
    manifest.history = manifest.history.filter((output) => !confirmed.has(output.relativePath));
    writeDownloadSession(downloadDir, manifest);
  }
  await removeEmptyDirectories(downloadDir, downloadDir);
  const retainedBytes = directorySizeSync(downloadDir);
  let remaining: string[] = [];
  try { remaining = await fs.promises.readdir(downloadDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { removedFiles, removedRelativePaths: [...removedPaths], removedDirectories: 0, removedBytes, removedDirectory: true, retainedBytes: 0 };
  }
  if (remaining.length === 0) {
    await fs.promises.rmdir(downloadDir);
    return { removedFiles, removedRelativePaths: [...removedPaths], removedDirectories: 1, removedBytes, removedDirectory: true, retainedBytes: 0 };
  }
  const trackedFilesRemain = [...manifestPaths].some((relativePath) => fs.existsSync(path.join(downloadDir, relativePath)));
  if (preserveManifest || trackedFilesRemain) {
    writeJsonFile(path.join(downloadDir, DOWNLOAD_RETAINED_FILE), {
      schemaVersion: 1,
      bvid: manifest.bvid,
      sessionId: manifest.sessionId,
      retainedAt: nowIso(),
      reason: "Unverified or incomplete local artifacts were preserved after confirmed outputs were cleaned.",
    });
    return { removedFiles, removedRelativePaths: [...removedPaths], removedDirectories: 0, removedBytes, removedDirectory: false, retainedBytes: directorySizeSync(downloadDir) };
  }
  writeJsonFile(path.join(downloadDir, DOWNLOAD_RETAINED_FILE), {
    schemaVersion: 1,
    bvid: manifest.bvid,
    sessionId: manifest.sessionId,
    retainedAt: nowIso(),
    reason: "Unverified local artifacts were preserved after all verified outputs were uploaded.",
  });
  return { removedFiles, removedRelativePaths: [...removedPaths], removedDirectories: 0, removedBytes, removedDirectory: false, retainedBytes: directorySizeSync(downloadDir) };
}

function directorySizeSync(target: string): number {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return fs.readdirSync(target).reduce((sum, name) => sum + directorySizeSync(path.join(target, name)), 0);
  } catch {
    return 0;
  }
}

function listFilesSync(rootDir: string) {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(path.relative(rootDir, fullPath));
    }
  };
  try { walk(rootDir); } catch (error) { console.debug('[DownloadSession] file inventory changed while walking the queue directory', error); }
  return files;
}

export function recordDownloadSelectedStream(
  downloadDir: string,
  input: { pageIndex: number; bilibiliQuality: string }
) {
  const session = readDownloadSession(downloadDir);
  if (session.kind === "invalid") throw new Error(invalidDownloadSessionMessage(session));
  if (session.kind === "missing") return false;
  const manifest = session.manifest;
  const page = manifest.pages.find((candidate) => candidate.index === Number(input.pageIndex));
  const bilibiliQuality = normalizeBilibiliQualityLabel(input.bilibiliQuality);
  if (!page || !bilibiliQuality) return false;
  const selected = new Map((manifest.selectedStreams || []).map((item) => [item.cid, item] as const));
  selected.set(page.cid, {
    pageIndex: page.index,
    cid: page.cid,
    bilibiliQuality,
    observedAt: nowIso(),
  });
  manifest.selectedStreams = [...selected.values()].sort((left, right) => left.pageIndex - right.pageIndex);
  writeDownloadSession(downloadDir, manifest);
  return true;
}

function emptyDownloadRecoverySummary(): DownloadRecoverySummary {
  return {
    resumableSessions: 0,
    completedPages: 0,
    totalPages: 0,
    retainedBytes: 0,
    legacyDirectories: 0,
    legacyBytes: 0,
    cleanupEligibleBytes: 0,
  };
}

function classifyManifestRecoverySet(manifest: DownloadSessionManifest, files: Iterable<string>) {
  const retained = new Set<string>();
  const cleanup = new Set<string>();
  const existing = new Set([...files].map((file) => file.replace(/\\/g, "/")));
  let aria2Controls = 0;
  for (const output of [...manifest.outputs, ...(manifest.history || [])]) {
    const relativePath = String(output.relativePath || "").replace(/\\/g, "/");
    if (relativePath && existing.has(relativePath)) retained.add(relativePath);
  }
  for (const relativeFile of existing) {
    const segments = relativeFile.split("/");
    if (segments.some((segment) => segment === "_invalid" || segment === "_incompatible")) continue;
    if (!/\.aria2$/i.test(relativeFile)) continue;
    aria2Controls += 1;
    retained.add(relativeFile);
    const dataFile = relativeFile.replace(/\.aria2$/i, "");
    if (existing.has(dataFile)) retained.add(dataFile);
  }
  for (const relativeFile of existing) {
    const segments = relativeFile.split("/");
    if (segments.some((segment) => segment === "_invalid" || segment === "_incompatible")) {
      cleanup.add(relativeFile);
      continue;
    }
    if (/\.aria2$/i.test(relativeFile)) continue;
    if (isUnsafeResumeArtifact(relativeFile) && !retained.has(relativeFile)) cleanup.add(relativeFile);
  }
  return { retained, cleanup, aria2Controls };
}

function classifyManifestRecovery(downloadDir: string, manifest: DownloadSessionManifest) {
  return classifyManifestRecoverySet(manifest, listFilesSync(downloadDir));
}

export async function cleanupDownloadRecoveryArtifacts(rootDir: string): Promise<DownloadCleanupResult> {
  const result: DownloadCleanupResult = {
    removedFiles: 0,
    removedRelativePaths: [],
    removedDirectories: 0,
    removedBytes: 0,
    removedDirectory: false,
    retainedBytes: 0,
  };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const downloadDir = path.join(rootDir, entry.name);
    if (isBBDownCredentialDirectoryName(entry.name)) {
      await fs.promises.rm(downloadDir, { recursive: true, force: true });
      result.removedDirectories += 1;
      continue;
    }
    if (fs.existsSync(path.join(downloadDir, DOWNLOAD_RETAINED_FILE))) {
      // A retained marker can include the only surviving media or a partial manifest.
      // Releasing these files requires explicit per-file authorization.
      result.retainedBytes += directorySizeSync(downloadDir);
      continue;
    }
    if (!/^BV[0-9A-Za-z]+$/i.test(entry.name)) continue;

    const session = readDownloadSession(downloadDir);
    if (session.kind === "invalid") {
      result.retainedBytes += directorySizeSync(downloadDir);
      continue;
    }
    const candidates = session.kind === "valid"
      ? [...classifyManifestRecovery(downloadDir, session.manifest).cleanup]
      : listFilesSync(downloadDir).filter((relativeFile) => /\.(aria2|tmp|vclip|aclip|part|download)$/i.test(relativeFile));
    const root = path.resolve(downloadDir);
    for (const relativeFile of candidates) {
      const target = path.resolve(downloadDir, relativeFile);
      if (target === root || !target.startsWith(`${root}${path.sep}`)) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(target);
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await fs.promises.unlink(target);
      result.removedFiles += 1;
      result.removedRelativePaths.push(path.relative(downloadDir, target).replace(/\\/g, "/"));
      result.removedBytes += stat.size;
    }
    await removeEmptyDirectories(downloadDir, downloadDir);
  }
  return result;
}

async function listFileSizes(rootDir: string) {
  const files = new Map<string, number>();
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.lstat(fullPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          files.set(path.relative(rootDir, fullPath).replace(/\\/g, "/"), stat.size);
        }
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
  return files;
}

export async function readDownloadSessionAsync(downloadDir: string): Promise<DownloadSessionReadResult> {
  try {
    return decodeDownloadSession(JSON.parse(await fs.promises.readFile(downloadSessionPath(downloadDir), "utf8")) as unknown);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    if (error instanceof SyntaxError) return { kind: "invalid", reason: "json" };
    throw error;
  }
}

export async function inspectDownloadCache(rootDir: string, concurrency = 4): Promise<DownloadCacheInspection> {
  const result: DownloadCacheInspection = {
    usedBytes: 0,
    fileCount: 0,
    exportableBytes: 0,
    exportableFiles: 0,
    recovery: emptyDownloadRecoverySummary(),
  };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return result;
    throw error;
  }

  const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    try {
      const stat = await fs.promises.lstat(path.join(rootDir, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      result.usedBytes += stat.size;
      result.fileCount += 1;
      result.exportableBytes += stat.size;
      result.exportableFiles += 1;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < directories.length) {
      const entry = directories[cursor++];
      const downloadDir = path.join(rootDir, entry.name);
      const fileSizes = await listFileSizes(downloadDir);
      const bytes = [...fileSizes.values()].reduce((total, size) => total + size, 0);
      result.usedBytes += bytes;
      result.fileCount += fileSizes.size;
      if (!isBBDownCredentialDirectoryName(entry.name)) {
        result.exportableBytes += bytes;
        result.exportableFiles += fileSizes.size;
      }
      if (isBBDownCredentialDirectoryName(entry.name)) continue;
      if (fileSizes.has(DOWNLOAD_RETAINED_FILE)) {
        result.recovery.retainedBytes += bytes;
        continue;
      }
      const session = await readDownloadSessionAsync(downloadDir);
      if (session.kind === "invalid") {
        result.recovery.retainedBytes += bytes;
        console.warn(`[DownloadSession] retained corrupt manifest directory ${entry.name}: ${invalidDownloadSessionMessage(session)}`);
        continue;
      }
      if (session.kind === "missing") {
        if (!/^BV[0-9A-Za-z]+$/i.test(entry.name)) continue;
        result.recovery.legacyDirectories += 1;
        result.recovery.legacyBytes += bytes;
        for (const [relativeFile, size] of fileSizes) {
          if (/\.(aria2|tmp|vclip|aclip|part|download)$/i.test(relativeFile)) {
            result.recovery.cleanupEligibleBytes += size;
          }
        }
        continue;
      }
      const manifest = session.manifest;
      const classified = classifyManifestRecoverySet(manifest, fileSizes.keys());
      const sizeOf = (items: Set<string>) => [...items].reduce((total, relativeFile) => total + (fileSizes.get(relativeFile) || 0), 0);
      if (["prepared", "downloading", "failed"].includes(manifest.status)
        && (manifest.outputs.length > 0 || classified.aria2Controls > 0)) {
        result.recovery.resumableSessions += 1;
      }
      result.recovery.completedPages += manifest.outputs.length;
      result.recovery.totalPages += manifest.pages.length;
      result.recovery.retainedBytes += sizeOf(classified.retained);
      result.recovery.cleanupEligibleBytes += sizeOf(classified.cleanup);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(concurrency)), directories.length || 1) }, worker));
  return result;
}

export function findLegacyCover(downloadDir: string) {
  const stack = [downloadDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith("_")) stack.push(fullPath);
      if (entry.isFile() && /\.(jpe?g|png|webp)$/i.test(entry.name)) return fullPath;
    }
  }
  return undefined;
}
