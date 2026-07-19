import assert from "node:assert/strict";
import test from "node:test";

import {
  dedupeKey,
  planForcedImport,
  resolveImportRow,
  type CommitAccount,
  type ImportCommitRow,
} from "../lib/import-commit.ts";

const EUR: CommitAccount = { id: 1, name: "REVOLUT", currency: "EUR" };
const rules = [{ pattern: "youtube", category: "Подписки" }];

// --- resolveImportRow: server-side revalidation (matrix W-06) ---------------

test("resolveImportRow accepts a valid row and derives category from rules", () => {
  const row: ImportCommitRow = {
    date: "2026-06-10",
    amount: "7.99",
    direction: "expense",
    description: "YouTube",
    currency: "EUR",
  };
  const result = resolveImportRow(row, EUR, rules);
  assert.ok(result.ok);
  assert.equal(result.tx.amountCents, -799);
  assert.equal(result.tx.category, "Подписки");
  assert.equal(result.tx.accountId, 1);
});

test("resolveImportRow rejects bad date / zero amount / currency / lifetime", () => {
  assert.deepEqual(
    resolveImportRow({ date: "2026-13-40", amount: "5", direction: "expense" }, EUR, []),
    { ok: false, reason: "некорректная дата" }
  );
  assert.deepEqual(
    resolveImportRow({ date: "2026-06-10", amount: "0", direction: "expense" }, EUR, []),
    { ok: false, reason: "некорректная сумма" }
  );
  assert.deepEqual(
    resolveImportRow(
      { date: "2026-06-10", amount: "5", direction: "expense", currency: "USD" },
      EUR,
      []
    ),
    { ok: false, reason: "другая валюта" }
  );
  const closed: CommitAccount = { ...EUR, closed_at: "2026-06-01" };
  assert.deepEqual(
    resolveImportRow({ date: "2026-06-10", amount: "5", direction: "expense" }, closed, []),
    { ok: false, reason: "вне периода существования счёта" }
  );
});

// --- planForcedImport: submit writes only the included rows (W-05/W-07) ------

function rows(): ImportCommitRow[] {
  return [
    { date: "2026-06-01", amount: "9.00", direction: "expense", description: "Tren De Palau", currency: "EUR" },
    { date: "2026-06-12", amount: "150.00", direction: "income", description: "Payment from EXPATPA", currency: "EUR" },
  ];
}

test("planForcedImport plans every valid included row", () => {
  const plan = planForcedImport(rows(), { account: EUR, rules: [], existingKeys: new Set() });
  assert.equal(plan.planned.length, 2);
  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.duplicates, 0);
  assert.equal(plan.planned[0].amountCents, -900);
  assert.equal(plan.planned[1].amountCents, 15000);
});

test("planForcedImport skips DB duplicates unless skipDedupe is set", () => {
  const existing = new Set([dedupeKey(1, "2026-06-01", -900, "Tren De Palau")]);

  const deduped = planForcedImport(rows(), { account: EUR, rules: [], existingKeys: existing });
  assert.equal(deduped.planned.length, 1, "duplicate dropped");
  assert.equal(deduped.duplicates, 1);

  const forced = planForcedImport(rows(), {
    account: EUR,
    rules: [],
    existingKeys: existing,
    skipDedupe: true,
  });
  assert.equal(forced.planned.length, 2, "explicit decision: nothing dropped");
  assert.equal(forced.duplicates, 0);
});

test("planForcedImport reports rejected rows by 1-based index", () => {
  const bad = [...rows(), { date: "nope", amount: "1", direction: "expense" }];
  const plan = planForcedImport(bad, { account: EUR, rules: [], existingKeys: new Set() });
  assert.equal(plan.planned.length, 2);
  assert.deepEqual(plan.rejected, [{ row: 3, reason: "некорректная дата" }]);
});
