import assert from "node:assert/strict";
import test from "node:test";

import {
  accountIsActiveOn,
  buildCategoryPresentation,
  groupOperationItemsByDate,
  hasOperationListFilters,
  selectActiveAccountsOn,
  shouldLoadOperationHistory,
  sortOperationItems,
} from "../lib/phase1.ts";

test("account availability includes both lifetime boundary dates", () => {
  const account = { openedAt: "2026-03-10", closedAt: "2026-07-16" };

  assert.equal(accountIsActiveOn(account, "2026-03-09"), false);
  assert.equal(accountIsActiveOn(account, "2026-03-10"), true);
  assert.equal(accountIsActiveOn(account, "2026-07-16"), true);
  assert.equal(accountIsActiveOn(account, "2026-07-17"), false);
});

test("account options contain only accounts active on the selected date", () => {
  const accounts = [
    { id: 1, openedAt: "2026-01-01", closedAt: null },
    { id: 2, openedAt: "2026-08-01", closedAt: null },
    { id: 3, openedAt: null, closedAt: "2026-06-30" },
  ];

  assert.deepEqual(
    selectActiveAccountsOn(accounts, "2026-07-16").map((account) => account.id),
    [1]
  );
});

test("history scope expands only when search or filters are active", () => {
  const empty = {
    query: "",
    accountId: "all",
    type: "all",
    category: "",
    flaggedOnly: false,
  };

  assert.equal(hasOperationListFilters(empty), false);
  assert.equal(shouldLoadOperationHistory("history", empty), false);
  assert.equal(shouldLoadOperationHistory("period", { ...empty, query: "Mercado" }), false);
  assert.equal(shouldLoadOperationHistory("history", { ...empty, query: "Mercado" }), true);
  assert.equal(shouldLoadOperationHistory("history", { ...empty, flaggedOnly: true }), true);
});

test("category presentation keeps every non-zero slice and limits only the legend", () => {
  const input = [
    { label: "A", cents: 100, color: "#1" },
    { label: "B", cents: 500, color: "#2" },
    { label: "C", cents: 300, color: "#3" },
    { label: "D", cents: 200, color: "#4" },
    { label: "E", cents: 400, color: "#5" },
    { label: "Zero", cents: 0, color: "#6" },
  ];

  const result = buildCategoryPresentation(input);

  assert.deepEqual(result.slices.map((item) => item.label), ["B", "E", "C", "D", "A"]);
  assert.deepEqual(result.legend.map((item) => item.label), ["B", "E", "C", "D"]);
  assert.equal(result.totalCents, 1500);
  assert.equal(result.slices.some((item) => item.label === "Остальное"), false);
});

test("amount sorting is absolute and date sorting restores day order", () => {
  const rows = [
    { id: 1, date: "2026-07-12", amountCents: -200 },
    { id: 2, date: "2026-07-11", amountCents: 900 },
    { id: 3, date: "2026-07-12", amountCents: -100 },
  ];
  const read = (row: (typeof rows)[number]) => row;

  assert.deepEqual(sortOperationItems(rows, "amount-desc", read).map((row) => row.id), [2, 1, 3]);
  assert.deepEqual(sortOperationItems(rows, "amount-asc", read).map((row) => row.id), [3, 1, 2]);
  const byDate = sortOperationItems(rows, "date", read);
  assert.deepEqual(byDate.map((row) => row.id), [3, 1, 2]);
  assert.deepEqual(
    groupOperationItemsByDate(byDate, (row) => row.date).map((group) => ({
      date: group.date,
      ids: group.items.map((row) => row.id),
    })),
    [
      { date: "2026-07-12", ids: [3, 1] },
      { date: "2026-07-11", ids: [2] },
    ]
  );
});
