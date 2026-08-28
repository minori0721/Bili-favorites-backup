export interface PreviewSkippedItem {
  reason: string;
}

export interface PreviewSkippedSummary<T extends PreviewSkippedItem> {
  skipped: T[];
  skippedTotal: number;
  skippedByReason: Record<string, number>;
}

function reasonKey(reason: unknown) {
  const value = String(reason || "未知原因").trim();
  const firstClause = value.split(/[：:]/, 1)[0]?.trim() || value;
  return firstClause.slice(0, 120) || "未知原因";
}

export class SkippedPreviewCollector<T extends PreviewSkippedItem> {
  private readonly sampleLimit: number;
  private readonly samples: T[] = [];
  private readonly counts = new Map<string, number>();
  private total = 0;

  constructor(sampleLimit = Number.POSITIVE_INFINITY) {
    this.sampleLimit = Number.isFinite(sampleLimit)
      ? Math.max(0, Math.floor(sampleLimit))
      : Number.POSITIVE_INFINITY;
  }

  add(item: T) {
    this.total += 1;
    const key = reasonKey(item.reason);
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
    if (this.samples.length < this.sampleLimit) this.samples.push(item);
  }

  addMany(items: readonly T[]) {
    for (const item of items) this.add(item);
  }

  addSummary(summary: PreviewSkippedSummary<T>) {
    this.total += Math.max(0, Number(summary.skippedTotal || 0));
    for (const [key, count] of Object.entries(summary.skippedByReason || {})) {
      this.counts.set(key, (this.counts.get(key) || 0) + Math.max(0, Number(count || 0)));
    }
    for (const item of summary.skipped || []) {
      if (this.samples.length >= this.sampleLimit) break;
      this.samples.push(item);
    }
  }

  snapshot(): PreviewSkippedSummary<T> {
    return {
      skipped: [...this.samples],
      skippedTotal: this.total,
      skippedByReason: Object.fromEntries(this.counts),
    };
  }
}
