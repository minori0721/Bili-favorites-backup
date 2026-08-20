export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { joinRemotePath as joinStrictRemotePath } from "./remote-path.js";

export function sanitizeSegment(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

export function joinRemotePath(base: string, ...segments: string[]) {
  return joinStrictRemotePath(base, ...segments);
}
