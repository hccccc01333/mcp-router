export interface ToolStats {
  id: string;
  searchHits: number;
  schemaViews: number;
  calls: number;
  errors: number;
  lastUsedAt?: number;
}

export interface SearchRecord {
  query: string;
  hits: string[];
  ts: number;
}

export interface ToolRankRow {
  id: string;
  score: number;
  calls: number;
  errors: number;
  searchHits: number;
  schemaViews: number;
}

export interface UsageSnapshot {
  totals: {
    searches: number;
    schemas: number;
    calls: number;
    errors: number;
  };
  topTools: ToolRankRow[];
  recentSearches: SearchRecord[];
}

const RANK_WEIGHT = { call: 3, searchHit: 1, schemaView: 2, error: -2 };

export class UsageStats {
  private toolMap = new Map<string, ToolStats>();
  private searches: SearchRecord[] = [];
  private totals = { searches: 0, schemas: 0, calls: 0, errors: 0 };

  private touch(id: string, mutate: (s: ToolStats) => void): void {
    let stats = this.toolMap.get(id);
    if (!stats) {
      stats = { id, searchHits: 0, schemaViews: 0, calls: 0, errors: 0 };
      this.toolMap.set(id, stats);
    }
    mutate(stats);
  }

  recordSearch(query: string, hitIds: string[]): void {
    this.totals.searches++;
    for (const id of hitIds) {
      this.touch(id, (s) => {
        s.searchHits++;
      });
    }
    this.searches.push({ query, hits: hitIds, ts: Date.now() });
    if (this.searches.length > 50) this.searches.shift();
  }

  recordSchema(id: string): void {
    this.totals.schemas++;
    this.touch(id, (s) => {
      s.schemaViews++;
    });
  }

  recordCall(id: string, ok: boolean): void {
    this.totals.calls++;
    this.touch(id, (s) => {
      s.calls++;
      if (!ok) s.errors++;
      s.lastUsedAt = Date.now();
    });
  }

  snapshot(): UsageSnapshot {
    const topTools: ToolRankRow[] = [...this.toolMap.values()]
      .map((s) => ({
        id: s.id,
        score:
          s.calls * RANK_WEIGHT.call +
          s.searchHits * RANK_WEIGHT.searchHit +
          s.schemaViews * RANK_WEIGHT.schemaView +
          s.errors * RANK_WEIGHT.error,
        calls: s.calls,
        errors: s.errors,
        searchHits: s.searchHits,
        schemaViews: s.schemaViews,
      }))
      .filter((r) => r.calls > 0 || r.searchHits > 0 || r.schemaViews > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 20);
    return { totals: { ...this.totals }, topTools, recentSearches: [...this.searches].reverse() };
  }

  reset(): void {
    this.toolMap.clear();
    this.searches = [];
    this.totals = { searches: 0, schemas: 0, calls: 0, errors: 0 };
  }
}