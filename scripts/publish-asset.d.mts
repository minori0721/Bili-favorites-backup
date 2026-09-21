/** Readers see either the previous complete file or the new complete file. */
export function publishAsset(file: string, contents: string | Uint8Array): Promise<void>;
