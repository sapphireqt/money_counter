export type DescriptionHistoryRow = {
  description: string;
  category: string;
  date: string;
};

export type DescriptionSuggestion = {
  description: string;
  category: string;
  usageCount: number;
  autoCategory: boolean;
};

export function descriptionHistoryWindowStart(now: Date): string {
  const target = new Date(
    Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate())
  );
  return target.toISOString().slice(0, 10);
}

export function normalizeDescription(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function matchQuality(description: string, query: string): number | null {
  const haystack = description.toLocaleLowerCase("ru-RU");
  const needle = query.toLocaleLowerCase("ru-RU");
  if (haystack.startsWith(needle)) return 0;
  if (haystack.split(/[\s\p{P}\p{S}]+/u).some((word) => word.startsWith(needle))) return 1;
  return haystack.includes(needle) ? 2 : null;
}

export function rankDescriptionSuggestions(
  rows: DescriptionHistoryRow[],
  rawQuery: string,
  limit = 8
): DescriptionSuggestion[] {
  const query = normalizeDescription(rawQuery);
  if ([...query].length < 2 || limit <= 0) return [];

  const groups = new Map<
    string,
    {
      description: string;
      count: number;
      latest: string;
      quality: number;
      categories: Map<string, { name: string; count: number; latest: string }>;
    }
  >();

  for (const row of rows) {
    const description = normalizeDescription(row.description);
    if (!description) continue;
    const quality = matchQuality(description, query);
    if (quality === null) continue;
    const key = description.toLocaleLowerCase("ru-RU");
    const current = groups.get(key) ?? {
      description,
      count: 0,
      latest: row.date,
      quality,
      categories: new Map(),
    };
    current.count += 1;
    if (row.date >= current.latest) {
      current.latest = row.date;
      current.description = description;
    }
    const category = normalizeDescription(row.category);
    if (category) {
      const categoryKey = category.toLocaleLowerCase("ru-RU");
      const categoryStats = current.categories.get(categoryKey) ?? {
        name: category,
        count: 0,
        latest: row.date,
      };
      categoryStats.count += 1;
      if (row.date >= categoryStats.latest) {
        categoryStats.latest = row.date;
        categoryStats.name = category;
      }
      current.categories.set(categoryKey, categoryStats);
    }
    groups.set(key, current);
  }

  return [...groups.values()]
    .sort(
      (a, b) =>
        a.quality - b.quality ||
        b.count - a.count ||
        b.latest.localeCompare(a.latest) ||
        a.description.localeCompare(b.description, "ru")
    )
    .slice(0, Math.min(limit, 8))
    .map((group) => {
      const category = [...group.categories.values()].sort(
        (a, b) => b.count - a.count || b.latest.localeCompare(a.latest)
      )[0];
      const confidence = category ? category.count / group.count : 0;
      return {
        description: group.description,
        category: category?.name ?? "",
        usageCount: group.count,
        autoCategory: Boolean(category && category.count >= 2 && confidence >= 0.75),
      };
    });
}
