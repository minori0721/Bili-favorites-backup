import type { RemoteFileMediaMetadata } from "./state.js";

export function parseFrameRate(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return undefined;
  const fraction = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(text);
  const parsed = fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(text);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000 ? parsed : undefined;
}

export function normalizeActualCodec(value: unknown) {
  const codec = String(value || "").trim().toLowerCase();
  if (!codec || codec === "unknown") return undefined;
  if (["h264", "avc", "avc1"].includes(codec)) return "AVC";
  if (["hevc", "h265", "h.265", "hev1", "hvc1"].includes(codec)) return "HEVC";
  if (["av1", "av01"].includes(codec)) return "AV1";
  if (["vp9", "vp09"].includes(codec)) return "VP9";
  return codec.toUpperCase();
}

export function actualQualityLabel(metadata: Pick<RemoteFileMediaMetadata, "width" | "height" | "fps"> | undefined) {
  if (!metadata) return undefined;
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return undefined;
  const shortEdge = Math.min(width, height);
  const fps = Number(metadata.fps || 0);
  if (shortEdge >= 4320) return "4320p";
  if (shortEdge >= 2160) return "2160p";
  if (shortEdge >= 1080) return fps >= 50 ? "1080p60" : "1080p";
  if (shortEdge >= 720) return fps >= 50 ? "720p60" : "720p";
  return `${Math.max(1, Math.round(shortEdge))}p`;
}

export function validBrowserMediaMetadata(input: { width: unknown; height: unknown; duration: unknown }) {
  const width = Number(input.width);
  const height = Number(input.height);
  const duration = Number(input.duration);
  if (!Number.isInteger(width) || width < 16 || width > 16_384) return null;
  if (!Number.isInteger(height) || height < 16 || height > 16_384) return null;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 172_800) return null;
  return { width, height, duration };
}
