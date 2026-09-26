export function promotionTags(image: string, rawTags: string | undefined): string[];

export function promoteImage(
  image: string,
  digest: string | undefined,
  tags: string[],
  operations?: {
    create(tag: string, source: string): void;
    inspect(reference: string): string;
    wait(milliseconds: number): Promise<unknown>;
  },
): Promise<void>;
