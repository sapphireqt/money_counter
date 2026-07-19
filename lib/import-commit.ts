import {
  matchCategoryRule,
  normalizeCurrency,
  normalizeDateInput,
  resolveSignedAmountCents,
  type CategoryRule,
} from "./finance.ts";

/**
 * Pure, framework-free planning for the final import write. It validates each
 * incoming row against the target account and turns it into a ready-to-insert
 * transaction — WITHOUT touching a database, so it can be unit-tested in plain
 * Node and reused by the API route (which only executes the plan in one D1
 * batch = one implicit transaction).
 *
 * This is deliberately separate from parsing/preview (lib/import-preview): the
 * client resolves duplicates and exclusions during preview and sends only the
 * operations it wants created; the server re-validates them here.
 */

export type ImportCommitRow = {
  accountName?: string;
  currency?: string;
  date?: string;
  amount?: string | number;
  amountCents?: string | number;
  direction?: string;
  description?: string;
  category?: string;
  payee?: string;
  notes?: string;
};

export type CommitAccount = {
  id: number;
  name: string;
  currency: string;
  opened_at?: string | null;
  closed_at?: string | null;
};

export type PlannedTransaction = {
  accountId: number;
  date: string;
  description: string;
  category: string;
  payee: string;
  amountCents: number;
  notes: string;
};

export type ResolveResult =
  | { ok: true; tx: PlannedTransaction }
  | { ok: false; reason: string };

/** Fingerprint used to skip rows already present in the account (DB-seeded). */
export function dedupeKey(
  accountId: number,
  date: string,
  amountCents: number,
  description: string
): string {
  return `${accountId}::${date}::${amountCents}::${description.trim().toLowerCase()}`;
}

/**
 * Validate one row against a concrete account and build the insert. Rejections
 * mirror the server contract: bad date, bad/zero amount, a currency that does
 * not match the account, or a date outside the account's lifetime.
 */
export function resolveImportRow(
  row: ImportCommitRow,
  account: CommitAccount,
  rules: CategoryRule[]
): ResolveResult {
  const date = normalizeDateInput(row.date);
  if (!date) {
    return { ok: false, reason: "некорректная дата" };
  }

  const amountCents = resolveSignedAmountCents(
    row.amount ?? row.amountCents,
    row.direction
  );
  if (amountCents === null || amountCents === 0) {
    return { ok: false, reason: "некорректная сумма" };
  }

  // Currency lives on the account. A row that declares a different currency is
  // a conflict, not a silent relabel.
  const rowCurrency = String(row.currency ?? "").trim();
  if (rowCurrency && normalizeCurrency(rowCurrency) !== account.currency) {
    return { ok: false, reason: "другая валюта" };
  }

  // Operations must fall inside the account's declared lifetime.
  if (
    (account.opened_at && date < account.opened_at) ||
    (account.closed_at && date > account.closed_at)
  ) {
    return { ok: false, reason: "вне периода существования счёта" };
  }

  const description =
    String(row.description ?? "").trim() ||
    (amountCents > 0 ? "Поступление" : "Расход");
  const payee = String(row.payee ?? "").trim();
  const category =
    String(row.category ?? "").trim() ||
    matchCategoryRule(description, rules) ||
    matchCategoryRule(payee, rules);

  return {
    ok: true,
    tx: {
      accountId: account.id,
      date,
      description,
      category,
      payee,
      amountCents,
      notes: String(row.notes ?? "").trim(),
    },
  };
}

export type PlanResult = {
  planned: PlannedTransaction[];
  rejected: Array<{ row: number; reason: string }>;
  duplicates: number;
};

export type PlanOptions = {
  account: CommitAccount;
  rules: CategoryRule[];
  /** Fingerprints already in the DB for this account (see dedupeKey). */
  existingKeys: Set<string>;
  /**
   * When true, skip the DB-fingerprint dedupe entirely. The Phase 2 preview has
   * already surfaced duplicates and the user made an explicit per-row decision,
   * so every row that reaches the server must be created.
   */
  skipDedupe?: boolean;
};

/**
 * Plan a single-account import (Phase 2 always targets one chosen account).
 * Rows that fail validation are rejected; rows whose fingerprint already exists
 * are counted as duplicates and skipped — unless `skipDedupe` is set.
 */
export function planForcedImport(
  rows: ImportCommitRow[],
  options: PlanOptions
): PlanResult {
  const { account, rules, existingKeys, skipDedupe = false } = options;
  const planned: PlannedTransaction[] = [];
  const rejected: Array<{ row: number; reason: string }> = [];
  let duplicates = 0;

  rows.forEach((row, index) => {
    const result = resolveImportRow(row, account, rules);
    if (!result.ok) {
      rejected.push({ row: index + 1, reason: result.reason });
      return;
    }
    const { tx } = result;
    if (!skipDedupe) {
      const fingerprint = dedupeKey(tx.accountId, tx.date, tx.amountCents, tx.description);
      if (existingKeys.has(fingerprint)) {
        duplicates += 1;
        return;
      }
    }
    planned.push(tx);
  });

  return { planned, rejected, duplicates };
}
