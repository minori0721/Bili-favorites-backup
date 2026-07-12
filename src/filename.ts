import type { RemoteFileRecord } from "./state.js";
import { sanitizeSegment } from "./utils.js";

function formatFilenameDate(value: number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export function renderArchivedFilename(
  template: string,
  record: { bvid: string; title: string; upperName: string },
  metadata: NonNullable<RemoteFileRecord["filenameMetadata"]> | undefined,
  pageIndex?: number,
  multiplePages = false
) {
  const source = String(template || "<videoTitle>-<bvid>");
  const required: Array<[string, unknown, string]> = [
    ["<publishDate>", metadata?.publishDate, "缺少视频发布日期"],
    ["<videoDate>", metadata?.videoDate, "缺少分P发布日期"],
    ["<dfn>", metadata?.dfn, "缺少实际画质信息"],
    ["<videoCodecs>", metadata?.videoCodecs, "缺少实际编码信息"],
  ];
  for (const [token, value, reason] of required) {
    if (source.includes(token) && !value) return { name: "", reason };
  }
  let name = source
    .replace(/<videoTitle>/g, record.title || record.bvid)
    .replace(/<ownerName>/g, record.upperName || "Unknown")
    .replace(/<bvid>/g, record.bvid)
    .replace(/<publishDate>/g, formatFilenameDate(Number(metadata?.publishDate)))
    .replace(/<videoDate>/g, formatFilenameDate(Number(metadata?.videoDate)))
    .replace(/<dfn>/g, String(metadata?.dfn || ""))
    .replace(/<videoCodecs>/g, String(metadata?.videoCodecs || ""));
  name = sanitizeSegment(name).replace(/\.+$/g, "").trim();
  if (multiplePages) {
    if (!pageIndex) return { name: "", reason: "多P文件缺少可确认的分P序号" };
    name += `_P${pageIndex}`;
  }
  return { name, reason: "" };
}
