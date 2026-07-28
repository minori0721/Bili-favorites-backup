export type PlaybackMediaErrorAction = "ignore" | "proxy" | "hevc" | "decode" | "final";
export type PlaybackDeliveryViewStatus = "pending" | "direct" | "proxy" | "unknown";

export interface PlaybackMediaErrorInput {
  mediaErrorCode: number;
  forceProxy: boolean;
  fallbackStarted: boolean;
  actualCodec?: string;
  requestedCodec?: string;
  browserSupportsHevc: boolean;
}

export function decidePlaybackMediaError(input: PlaybackMediaErrorInput): PlaybackMediaErrorAction {
  const code = Number(input.mediaErrorCode || 0);
  if (code === 1) return "ignore";

  const actualCodec = String(input.actualCodec || "").trim().toLowerCase();
  const requestedCodec = String(input.requestedCodec || "").trim().toLowerCase();
  const isHevc = (codec: string) => /^(?:hevc|h\.?265|hev1|hvc1)(?:$|[\s._-])/.test(codec);
  const actualHevc = isHevc(actualCodec);
  const requestedHevc = isHevc(requestedCodec);
  const likelyHevc = actualHevc || (!actualCodec && requestedHevc);

  if ((code === 0 || code === 3) && likelyHevc && !input.browserSupportsHevc) return "hevc";
  if (code === 3 && likelyHevc) return "hevc";
  if (code === 4 && likelyHevc && !input.browserSupportsHevc) return "hevc";
  if (code === 3) return "decode";
  if (!input.forceProxy && !input.fallbackStarted && (code === 0 || code === 2 || code === 4)) {
    return "proxy";
  }
  return "final";
}

export function resolvePlaybackDeliveryViewStatus(
  current: string,
  reported: string,
  final: boolean
): PlaybackDeliveryViewStatus {
  if (reported === "direct" || reported === "proxy") return reported;
  if (current === "direct" || current === "proxy") return current;
  if (!final && reported === "pending") return "pending";
  return "unknown";
}
