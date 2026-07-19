import {
  formatMoney,
  normalizeCurrency,
  parseFlexibleDate,
  parseMoneyInputToCents,
} from "./finance.ts";
import {
  classifyDirection,
  detectAmountSigned,
  normalizeHeaderName,
  type AnalyzeResult,
  type ParsedRow,
} from "./import.ts";

/**
 * Phase 2 import preview: a pure, framework-free layer on top of the CSV/TSV
 * engine (lib/import) and the PDF engine (lib/pdf). It turns raw parsed rows
 * into a bank-agnostic "normalized operation" model, splits fees into their own
 * operation, flags non-final bank states, and — given the existing operations
 * of the chosen account — finds possible duplicates.
 *
 * NOTHING here touches a database. The result is consumed by the mapping,
 * preview and duplicate-search UI; only the final explicit submit writes.
 */

export type ImportDirection = "expense" | "income";

export type SourceFormat = "tsv" | "csv" | "pdf";

/** A transaction already stored on the target account (read-only, for dedupe). */
export type ExistingTransaction = {
  id: number;
  date: string;
  description: string;
  /** Signed minor units, exactly as stored (negative = expense). */
  amountCents: number;
};

export type DuplicateCandidate = {
  id: number;
  date: string;
  description: string;
  /** Signed minor units, as stored. */
  amountCents: number;
  /** Higher = more likely the same operation (description similarity + proximity). */
  score: number;
};

export type AmountOption = { amountCents: number; label: string };

export type ImportIssue =
  | { kind: "duplicate_candidate"; candidates: DuplicateCandidate[] }
  | { kind: "bank_state"; state: string }
  | { kind: "missing_date"; options: string[] }
  | { kind: "ambiguous_amount"; options: AmountOption[] };

export type ImportIssueKind = ImportIssue["kind"];

export type NormalizedOperation = {
  /** Stable id within one preview (e.g. "tsv-3", "tsv-3-fee", "pdf-5"). */
  sourceRowId: string;
  sourceFormat: SourceFormat;
  sourceIndex: number;
  /** True for the separate expense created from a source Fee column. */
  isFee: boolean;

  /** Calendar date saved to the operation (YYYY-MM-DD) or null when unknown. */
  date: string | null;
  /** Ephemeral — used only for ordering and the ±3-day duplicate window. */
  startedAt: string | null;
  completedAt: string | null;

  description: string;
  direction: ImportDirection | null;
  /** POSITIVE absolute minor units, or null when the amount is unresolved. */
  amountCents: number | null;
  currency: string;

  /** The raw bank State (TSV), when present — drives the bank_state issue. */
  sourceState: string | null;

  issues: ImportIssue[];
};

// --- column resolution (TSV/CSV) --------------------------------------------

export type Phase2Columns = {
  /** The column mapped to the saved date (defaults to Completed Date). */
  dateIndex: number;
  descriptionIndex: number;
  amountIndex: number;
  // Auto-detected, not user-editable in the compact Phase 2 mapping UI:
  startedIndex: number;
  completedIndex: number;
  feeIndex: number;
  currencyIndex: number;
  stateIndex: number;
  directionIndex: number;
};

function findHeader(headers: string[], names: string[]): number {
  const normalized = headers.map(normalizeHeaderName);
  for (const name of names) {
    const idx = normalized.indexOf(name);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Seed the Phase 2 mapping from the generic engine's guess. The saved date
 * defaults to Completed Date (falling back to any date column); Started Date is
 * located separately because it feeds the duplicate window and is offered as an
 * alternative in the mapping UI.
 */
export function guessPhase2Columns(analyze: AnalyzeResult): Phase2Columns {
  const { headers, mapping } = analyze;
  const completedIndex = findHeader(headers, [
    "completed date",
    "date completed",
  ]);
  const startedIndex = findHeader(headers, ["started date", "date started"]);
  const dateIndex =
    completedIndex >= 0 ? completedIndex : mapping.date >= 0 ? mapping.date : startedIndex;
  const stateIndex = findHeader(headers, ["state", "status", "статус", "estado"]);
  return {
    dateIndex,
    descriptionIndex: mapping.description,
    amountIndex: mapping.amount,
    startedIndex,
    completedIndex: completedIndex >= 0 ? completedIndex : dateIndex,
    feeIndex: mapping.fee,
    currencyIndex: mapping.currency,
    stateIndex,
    directionIndex: analyze.directionIndex,
  };
}

function cell(record: string[], index: number): string {
  return index >= 0 ? (record[index] ?? "").trim() : "";
}

function cleanDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const COMPLETED_STATES = new Set(["completed", "complete", "settled", "posted", "success", "successful"]);

// --- TSV / CSV normalization -------------------------------------------------

export type NormalizeTextOptions = {
  columns: Phase2Columns;
  defaultCurrency: string;
  sourceFormat?: SourceFormat;
};

export function normalizeTextOperations(
  analyze: AnalyzeResult,
  options: NormalizeTextOptions
): NormalizedOperation[] {
  const { columns, defaultCurrency } = options;
  const sourceFormat: SourceFormat = options.sourceFormat ?? "tsv";
  const amountIsSigned = detectAmountSigned(analyze.dataRows, columns.amountIndex);
  const operations: NormalizedOperation[] = [];

  analyze.dataRows.forEach((record, index) => {
    const startedAt = columns.startedIndex >= 0 ? parseFlexibleDate(cell(record, columns.startedIndex)) : null;
    const completedAt = columns.completedIndex >= 0 ? parseFlexibleDate(cell(record, columns.completedIndex)) : null;
    const date = parseFlexibleDate(cell(record, columns.dateIndex));
    const description = cleanDescription(cell(record, columns.descriptionIndex));
    const currencyRaw = cell(record, columns.currencyIndex);
    const currency = currencyRaw ? normalizeCurrency(currencyRaw) : defaultCurrency;
    const stateRaw = cell(record, columns.stateIndex);
    const sourceState = stateRaw || null;

    const amountRaw = parseMoneyInputToCents(cell(record, columns.amountIndex));
    const feeRaw = columns.feeIndex >= 0 ? parseMoneyInputToCents(cell(record, columns.feeIndex)) : null;

    // Direction: a signed amount decides on its own; otherwise fall back to a
    // direction/type column. Never trust the Type column when the amount is
    // signed (that would double-negate).
    let direction: ImportDirection | null = null;
    if (amountRaw !== null && amountRaw !== 0) {
      if (amountIsSigned) {
        direction = amountRaw < 0 ? "expense" : "income";
      } else if (columns.directionIndex >= 0) {
        // An unclassifiable direction/Type value must NOT force "expense" — fall
        // back to the amount's own sign (matches the legacy resolveRowCents),
        // otherwise a positive receipt with a Type like "Transfer" flips to a
        // spurious expense.
        direction =
          classifyDirection(cell(record, columns.directionIndex)) ??
          (amountRaw < 0 ? "expense" : "income");
      } else {
        direction = amountRaw < 0 ? "expense" : "income";
      }
    }

    const dateOptions = [startedAt, completedAt].filter((value): value is string => Boolean(value));
    const stateIssue =
      sourceState && !COMPLETED_STATES.has(sourceState.toLowerCase())
        ? ({ kind: "bank_state", state: sourceState.toUpperCase() } as ImportIssue)
        : null;

    // Main operation — created only when the row carries a non-zero amount.
    if (amountRaw !== null && amountRaw !== 0) {
      const issues: ImportIssue[] = [];
      if (!date) issues.push({ kind: "missing_date", options: dateOptions });
      if (stateIssue) issues.push(stateIssue);
      operations.push({
        sourceRowId: `${sourceFormat}-${index}`,
        sourceFormat,
        sourceIndex: index,
        isFee: false,
        date,
        startedAt,
        completedAt,
        description,
        direction: direction ?? (amountRaw < 0 ? "expense" : "income"),
        amountCents: Math.abs(amountRaw),
        currency,
        sourceState,
        issues,
      });
    }

    // Fee — always a separate expense, never folded into the main amount.
    if (feeRaw !== null && feeRaw > 0) {
      const issues: ImportIssue[] = [];
      if (!date) issues.push({ kind: "missing_date", options: dateOptions });
      if (stateIssue) issues.push(stateIssue);
      operations.push({
        sourceRowId: `${sourceFormat}-${index}-fee`,
        sourceFormat,
        sourceIndex: index,
        isFee: true,
        date,
        startedAt,
        completedAt,
        description,
        direction: "expense",
        amountCents: Math.abs(feeRaw),
        currency,
        sourceState,
        issues,
      });
    }
  });

  return operations;
}

// --- PDF (KBank) normalization ----------------------------------------------

export function normalizePdfOperations(
  rows: ParsedRow[],
  options: { currency: string }
): NormalizedOperation[] {
  const operations: NormalizedOperation[] = [];
  rows.forEach((row, index) => {
    const issues: ImportIssue[] = [];
    let amountCents: number | null =
      row.amountCents === null ? null : Math.abs(row.amountCents);
    let direction: ImportDirection | null =
      row.amountCents === null ? null : row.amountCents < 0 ? "expense" : "income";

    if (row.skip === "нет даты") {
      issues.push({ kind: "missing_date", options: [] });
    } else if (row.skip === "сумма ≠ Δостатка") {
      const delta = row.amountCents ?? 0;
      const printed = row.amountAltCents ?? delta;
      amountCents = null;
      direction = delta < 0 ? "expense" : "income";
      issues.push({
        kind: "ambiguous_amount",
        options: [
          { amountCents: Math.abs(delta), label: "по изменению баланса" },
          { amountCents: Math.abs(printed), label: "как в выписке" },
        ],
      });
    } else if (row.skip) {
      // "нет суммы"/"нулевая сумма": not a real operation — drop it.
      return;
    }

    operations.push({
      sourceRowId: `pdf-${index}`,
      sourceFormat: "pdf",
      sourceIndex: index,
      isFee: false,
      date: row.date,
      startedAt: row.date,
      completedAt: row.date,
      description: cleanDescription(row.description),
      direction,
      amountCents,
      currency: row.currency || options.currency,
      sourceState: null,
      issues,
    });
  });
  return operations;
}

// --- duplicate candidate search ---------------------------------------------

function dayNumber(iso: string): number | null {
  const parts = iso.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return null;
  const probe = new Date(0);
  probe.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  return Math.round(probe.getTime() / 86_400_000);
}

function daysApart(a: string, b: string): number | null {
  const na = dayNumber(a);
  const nb = dayNumber(b);
  if (na === null || nb === null) return null;
  return Math.abs(na - nb);
}

const STOP_TOKENS = new Set([
  "to",
  "from",
  "payment",
  "transfer",
  "card",
  "the",
  "of",
  "for",
  "and",
  "к",
  "в",
  "на",
  "по",
  "оплата",
  "перевод",
  "платеж",
]);

function tokens(value: string): string[] {
  return cleanDescription(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^0-9a-zа-я]+/i)
    .filter((token) => token.length >= 3 && !STOP_TOKENS.has(token));
}

/**
 * Rank how similar two descriptions are (0 = unrelated). Description is NOT a
 * hard duplicate condition — this only orders candidates and picks the most
 * likely one, so an imported "EasyPark" can still surface a hand-entered
 * "Парковка" that matches on amount + direction + date.
 */
export function descriptionSimilarity(a: string, b: string): number {
  const na = cleanDescription(a).toLowerCase().replace(/ё/g, "е");
  const nb = cleanDescription(b).toLowerCase().replace(/ё/g, "е");
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  if (ta.length === 0 || tb.size === 0) return 0;
  let shared = 0;
  let prefix = 0;
  for (const token of ta) {
    if (tb.has(token)) shared += 1;
    else if ([...tb].some((other) => other.startsWith(token) || token.startsWith(other))) prefix += 1;
  }
  const overlap = shared / Math.max(ta.length, tb.size);
  return Math.round(overlap * 80) + (prefix > 0 ? 10 : 0);
}

/**
 * Find existing operations that could be the same as `op`. Hard conditions:
 * same direction, same absolute amount, and an existing date within ±3 calendar
 * days of the source Started OR Completed date. Sorted most-likely first.
 */
export function findDuplicateCandidates(
  op: NormalizedOperation,
  existing: ExistingTransaction[]
): DuplicateCandidate[] {
  if (op.direction === null || op.amountCents === null) return [];
  const windowDates = [op.startedAt, op.completedAt, op.date].filter(
    (value): value is string => Boolean(value)
  );
  if (windowDates.length === 0) return [];

  const candidates: DuplicateCandidate[] = [];
  for (const existingTx of existing) {
    const existingDirection: ImportDirection = existingTx.amountCents < 0 ? "expense" : "income";
    if (existingDirection !== op.direction) continue;
    if (Math.abs(existingTx.amountCents) !== op.amountCents) continue;

    let closest = Infinity;
    for (const date of windowDates) {
      const gap = daysApart(existingTx.date, date);
      if (gap !== null) closest = Math.min(closest, gap);
    }
    if (closest > 3) continue;

    const similarity = descriptionSimilarity(op.description, existingTx.description);
    candidates.push({
      id: existingTx.id,
      date: existingTx.date,
      description: existingTx.description,
      amountCents: existingTx.amountCents,
      // Description similarity dominates; proximity breaks ties.
      score: similarity * 10 + (3 - Math.min(3, closest)),
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  return candidates;
}

/**
 * Attach a `duplicate_candidate` issue to every operation that has ≥1 candidate
 * among the existing account operations. Returns NEW operation objects (the
 * originals are never mutated), so re-running is idempotent.
 */
export function attachDuplicateCandidates(
  operations: NormalizedOperation[],
  existing: ExistingTransaction[]
): NormalizedOperation[] {
  return operations.map((op) => {
    const withoutDuplicate = op.issues.filter((issue) => issue.kind !== "duplicate_candidate");
    const candidates = findDuplicateCandidates(op, existing);
    const issues = candidates.length
      ? [...withoutDuplicate, { kind: "duplicate_candidate", candidates } as ImportIssue]
      : withoutDuplicate;
    return { ...op, issues };
  });
}

// --- summaries & formatting --------------------------------------------------

export type OperationsSummary = {
  count: number;
  expenseCount: number;
  incomeCount: number;
  feeCount: number;
  feeTotalCents: number;
  minDate: string | null;
  maxDate: string | null;
  currency: string;
};

export function summarizeOperations(operations: NormalizedOperation[]): OperationsSummary {
  let expenseCount = 0;
  let incomeCount = 0;
  let feeCount = 0;
  let feeTotalCents = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  const currencyCounts = new Map<string, number>();

  for (const op of operations) {
    if (op.direction === "expense") expenseCount += 1;
    if (op.direction === "income") incomeCount += 1;
    if (op.isFee) {
      feeCount += 1;
      feeTotalCents += op.amountCents ?? 0;
    }
    if (op.date) {
      if (minDate === null || op.date < minDate) minDate = op.date;
      if (maxDate === null || op.date > maxDate) maxDate = op.date;
    }
    currencyCounts.set(op.currency, (currencyCounts.get(op.currency) ?? 0) + 1);
  }

  let currency = "EUR";
  let best = -1;
  for (const [code, hits] of currencyCounts) {
    if (hits > best) {
      best = hits;
      currency = code;
    }
  }

  return {
    count: operations.length,
    expenseCount,
    incomeCount,
    feeCount,
    feeTotalCents,
    minDate,
    maxDate,
    currency,
  };
}

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

function parts(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

/** "1–20 июня 2026", "28 мая – 3 июня 2026", "20 дек. 2025 – 3 янв. 2026". */
export function formatDateRangeRu(minDate: string | null, maxDate: string | null): string {
  if (!minDate && !maxDate) return "";
  if (!minDate) minDate = maxDate;
  if (!maxDate) maxDate = minDate;
  const a = parts(minDate!);
  const b = parts(maxDate!);
  if (minDate === maxDate) {
    return `${a.day} ${MONTHS_GENITIVE[a.month - 1]} ${a.year}`;
  }
  if (a.year === b.year && a.month === b.month) {
    return `${a.day}–${b.day} ${MONTHS_GENITIVE[a.month - 1]} ${a.year}`;
  }
  if (a.year === b.year) {
    return `${a.day} ${MONTHS_GENITIVE[a.month - 1]} – ${b.day} ${MONTHS_GENITIVE[b.month - 1]} ${a.year}`;
  }
  return `${a.day} ${MONTHS_GENITIVE[a.month - 1]} ${a.year} – ${b.day} ${MONTHS_GENITIVE[b.month - 1]} ${b.year}`;
}

/** Russian plural: pluralRu(1, ["операция","операции","операций"]). */
export function pluralRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const tail = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (tail > 1 && tail < 5) return forms[1];
  if (tail === 1) return forms[0];
  return forms[2];
}

/** "9,00 € · расход" — the mapping-step amount example. */
export function formatAmountWithType(op: NormalizedOperation): string {
  if (op.amountCents === null || op.direction === null) return "—";
  const money = formatMoney(op.amountCents, op.currency);
  return `${money} · ${op.direction === "expense" ? "расход" : "поступление"}`;
}

/** The first issue that still blocks import for this operation, if any. */
export function blockingIssue(op: NormalizedOperation): ImportIssue | null {
  return op.issues.length ? op.issues[0] : null;
}

export function hasIssues(op: NormalizedOperation): boolean {
  return op.issues.length > 0;
}
