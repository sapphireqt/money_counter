import assert from "node:assert/strict";
import test from "node:test";

import {
  descriptionHistoryWindowStart,
  normalizeDescription,
  rankDescriptionSuggestions,
} from "../lib/operations.ts";

test("uses a rolling twelve-month description history window", () => {
  assert.equal(
    descriptionHistoryWindowStart(new Date("2026-07-16T12:00:00Z")),
    "2025-07-16"
  );
});

test("normalizes whitespace without changing the user's casing", () => {
  assert.equal(normalizeDescription("  Metro   Sabadell  "), "Metro Sabadell");
});

test("ranks prefix, word-prefix and substring matches in that order", () => {
  const rows = [
    { description: "Super Mercado", category: "Еда", date: "2026-06-01" },
    { description: "Mercadona", category: "Еда", date: "2026-05-01" },
    { description: "La Mercadona Centro", category: "Еда", date: "2026-07-01" },
  ];
  assert.deepEqual(
    rankDescriptionSuggestions(rows, "me").map((row) => row.description),
    ["Mercadona", "La Mercadona Centro", "Super Mercado"]
  );
});

test("uses frequency then recency and only auto-selects a confident category", () => {
  const rows = [
    { description: "Mercadona", category: "Еда", date: "2026-01-01" },
    { description: "Mercadona", category: "Еда", date: "2026-04-01" },
    { description: "Mercadona", category: "Другое", date: "2026-05-01" },
    { description: "Metro", category: "Транспорт", date: "2026-07-01" },
    { description: "Metro", category: "Транспорт", date: "2026-06-01" },
  ];
  const [mercadona, metro] = rankDescriptionSuggestions(rows, "me");
  assert.equal(mercadona.description, "Mercadona");
  assert.equal(mercadona.usageCount, 3);
  assert.equal(mercadona.autoCategory, false);
  assert.equal(metro.autoCategory, true);
  assert.equal(metro.category, "Транспорт");
});

test("requires two characters and caps results at eight", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    description: `Market ${index}`,
    category: "Еда",
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
  }));
  assert.deepEqual(rankDescriptionSuggestions(rows, "m"), []);
  assert.equal(rankDescriptionSuggestions(rows, "ma", 20).length, 8);
});
