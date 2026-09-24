import { safeErrorSummary } from "./diagnostics.js";

/** Release a fetched cover that was rejected before its body was read. */
export async function cancelUnreadCoverResponse(response: Response | null) {
  if (!response?.body || response.bodyUsed) return;
  try {
    await response.body.cancel();
  } catch (error) {
    console.debug(`[CoverResponse] failed to cancel unused body: ${safeErrorSummary(error)}`);
  }
}

interface CoverResponseErrors {
  http(status: number): Error;
  contentType(): Error;
  tooLarge(): Error;
}

/** Validate and read one final cover response, releasing its body on every path. */
export async function readCoverImageResponse(response: Response | null, maxBytes: number, errors: CoverResponseErrors) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let completed = false;
  try {
    if (!response?.ok || !response.body) throw errors.http(response?.status || 0);
    const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) throw errors.contentType();
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxBytes) throw errors.tooLarge();

    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) {
        completed = true;
        return Buffer.concat(chunks, total);
      }
      total += part.value.byteLength;
      if (total > maxBytes) throw errors.tooLarge();
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    if (reader && !completed) {
      try {
        await reader.cancel();
      } catch (error) {
        console.debug(`[CoverResponse] failed to cancel reader: ${safeErrorSummary(error)}`);
      }
    }
    if (reader) {
      try {
        reader.releaseLock();
      } catch (error) {
        console.debug(`[CoverResponse] failed to release reader: ${safeErrorSummary(error)}`);
      }
    }
    await cancelUnreadCoverResponse(response);
  }
}
