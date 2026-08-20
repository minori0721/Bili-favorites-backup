export class StorageUrlError extends Error {
  readonly code = "STORAGE_URL_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "StorageUrlError";
  }
}

export function parseStorageBaseUrl(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new StorageUrlError("内部通信地址不能为空");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StorageUrlError("内部通信地址不是有效URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StorageUrlError("内部通信地址必须使用HTTP或HTTPS");
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new StorageUrlError("内部通信地址不能包含凭据、查询串或片段");
  }
  return url;
}

export function buildStorageDavUrl(value: unknown) {
  const url = parseStorageBaseUrl(value);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = `${pathname}/dav` || "/dav";
  return url.toString();
}
