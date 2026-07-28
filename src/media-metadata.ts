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

export function normalizeBilibiliQualityLabel(value: unknown) {
  const label = String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!label) return undefined;
  if (/杜比视界|dolby\s*vision/i.test(label)) return "杜比视界";
  if (/\bHDR\b|HDR\s*真彩/i.test(label)) return "HDR";
  if (/(?:^|\s)8K(?:\s|$)|4320P/i.test(label)) return "8K";
  if (/(?:^|\s)4K(?:\s|$)|2160P/i.test(label)) return "4K";
  if (/1080P.*(?:60|高帧率)|(?:60|高帧率).*1080P/i.test(label)) return "1080P60";
  if (/1080P\+|1080P.*高码率/i.test(label)) return "1080P+";
  if (/1080P/i.test(label)) return "1080P";
  if (/720P.*(?:60|高帧率)|(?:60|高帧率).*720P/i.test(label)) return "720P60";
  if (/720P/i.test(label)) return "720P";
  if (/480P/i.test(label)) return "480P";
  if (/360P/i.test(label)) return "360P";
  return label.replace(/\s+/g, "").slice(0, 40) || undefined;
}

export function actualQualityLabel(metadata: Pick<RemoteFileMediaMetadata, "width" | "height" | "fps"> | undefined) {
  if (!metadata) return undefined;
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return undefined;
  const shortEdge = Math.min(width, height);
  const fps = Number(metadata.fps || 0);
  return `${Math.max(1, Math.round(shortEdge))}p${fps >= 50 ? "60" : ""}`;
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
