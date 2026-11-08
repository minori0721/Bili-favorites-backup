export function promotionTags(image: string, rawTags: string | undefined): string[];
export function registryDigest(reference: string): string | null;

export function promoteImage(
  image: string,
  digest: string | undefined,
  tags: string[],
  operations?: {
    create(tag: string, source: string): void;
    inspect(reference: string): string | null;
    wait(milliseconds: number): Promise<unknown>;
  },
): Promise<void>;
