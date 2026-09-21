/** Preserve each ranked source's allocation, deduplicate, then fill unused slots.
 * Sources are product selectors, never downstream matcher results. */
export function selectDiscoveryIds(
  sources: readonly { ids: readonly string[]; share: number }[],
  limit: number,
): string[] {
  const selected = new Set<string>();
  const ranked: { id: string; priority: number; source: number }[] = [];
  const add = (id: string, source: number, rank: number) => {
    if (selected.has(id) || selected.size >= limit) return false;
    selected.add(id);
    ranked.push({
      id,
      priority: (rank + 0.5) / Math.max(sources[source].share, 0.001),
      source,
    });
    return true;
  };
  for (const [index, source] of sources.entries()) {
    let added = 0;
    const quota = Math.floor(limit * source.share);
    for (const id of source.ids) {
      if (added >= quota || selected.size >= limit) break;
      if (add(id, index, added)) added++;
    }
  }
  for (const [index, source] of sources.entries()) {
    for (const [rank, id] of source.ids.entries()) {
      if (selected.size >= limit) break;
      add(id, index, rank);
    }
  }
  return ranked
    .sort((a, b) => a.priority - b.priority || a.source - b.source)
    .map((item) => item.id);
}
