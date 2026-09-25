export interface ImageLayer {
  digest: string;
  size: number;
}

export function platformLayers(
  manifest: unknown,
  image: string,
  inspectManifest: (reference: string) => unknown,
): ImageLayer[];

export function compareLayers(previous: ImageLayer[], current: ImageLayer[]): {
  reused: number;
  total: number;
  downloadBytes: number;
  changedPositions: number[];
  identical: boolean;
};

export function cacheDestinations(ref: string | undefined, image: string): string[];
