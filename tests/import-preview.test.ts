import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { analyzeImport } from "../lib/import.ts";
import { analyzePdf, type PdfPage } from "../lib/pdf.ts";
import {
  attachDuplicateCandidates,
  descriptionSimilarity,
  findDuplicateCandidates,
  formatDateRangeRu,
  guessPhase2Columns,
  normalizePdfOperations,
  normalizeTextOperations,
  pluralRu,
  summarizeOperations,
  type ExistingTransaction,
  type NormalizedOperation,
} from "../lib/import-preview.ts";

const ORIGINAL_TSV = readFileSync(
  new URL("./fixtures/account-statement-original.tsv", import.meta.url),
  "utf8"
);
const CHECK_TSV = readFileSync(
  new URL("./fixtures/account-statement-phase2-production-check.tsv", import.meta.url),
  "utf8"
);
const KBANK_PAGES = JSON.parse(
  readFileSync(new URL("./fixtures/kbank-pages.json", import.meta.url), "utf8")
) as PdfPage[];

function normalizeTsv(text: string, dateField: "completed" | "started" = "completed") {
  const analyze = analyzeImport(text, { defaultCurrency: "EUR" });
  const columns = guessPhase2Columns(analyze);
  if (dateField === "started") columns.dateIndex = columns.startedIndex;
  return normalizeTextOperations(analyze, { columns, defaultCurrency: analyze.detectedCurrency });
}

// Turn normalized operations into "already stored" transactions (signed cents).
function asExisting(ops: NormalizedOperation[]): ExistingTransaction[] {
  return ops.map((op, index) => ({
    id: index + 1,
    date: op.date ?? "",
    description: op.description,
    amountCents: op.direction === "expense" ? -(op.amountCents ?? 0) : op.amountCents ?? 0,
  }));
}

// --- TSV normalization (parser contract §9) ---------------------------------

test("original TSV normalizes to the 14 contract operations", () => {
  const ops = normalizeTsv(ORIGINAL_TSV);
  assert.equal(ops.length, 14, "14 normalized operations");

  const summary = summarizeOperations(ops);
  assert.equal(summary.expenseCount, 13);
  assert.equal(summary.incomeCount, 1);
  assert.equal(summary.currency, "EUR");
  assert.equal(summary.minDate, "2026-06-01");
  assert.equal(summary.maxDate, "2026-06-20");

  const expected = [
    ["2026-06-01", "Tren De Palau", "expense", 900],
    ["2026-06-01", "Serveis Ambientals de Castelldefels - SAC", "expense", 530],
    ["2026-06-07", "Izquierdo Prieto Inversio", "expense", 815],
    ["2026-06-09", "Premium plan fee", "expense", 899],
    ["2026-06-09", "Tecnorino", "expense", 15000],
    ["2026-06-09", "Parking Teknon", "expense", 395],
    ["2026-06-10", "YouTube", "expense", 799],
    ["2026-06-10", "Vimusa", "expense", 50],
    ["2026-06-11", "Vimusa", "expense", 150],
    ["2026-06-12", "Payment from EXPATPA", "income", 15000],
    ["2026-06-15", "Transfer to MAKSIM POGOZHII", "expense", 60000],
    ["2026-06-16", "Transfer to ANASTASIIA KOSTYRINA", "expense", 75000],
    ["2026-06-20", "Turo Park Medical Cent", "expense", 21900],
    ["2026-06-20", "EasyPark", "expense", 469],
  ] as const;

  ops.forEach((op, index) => {
    const [date, description, direction, cents] = expected[index];
    assert.equal(op.date, date, `#${index + 1} date`);
    assert.equal(op.description, description, `#${index + 1} description`);
    assert.equal(op.direction, direction, `#${index + 1} direction`);
    assert.equal(op.amountCents, cents, `#${index + 1} amount`);
    assert.equal(op.currency, "EUR");
    assert.equal(op.issues.length, 0, `#${index + 1} has no issues`);
  });
});

test("fee is one separate expense (Amount=0 + Fee>0 → single fee op)", () => {
  const ops = normalizeTsv(ORIGINAL_TSV);
  const fees = ops.filter((op) => op.isFee);
  assert.equal(fees.length, 1);
  assert.equal(fees[0].description, "Premium plan fee");
  assert.equal(fees[0].direction, "expense");
  assert.equal(fees[0].amountCents, 899);

  const summary = summarizeOperations(ops);
  assert.equal(summary.feeCount, 1);
  assert.equal(summary.feeTotalCents, 899);
});

test("a row with a non-zero amount AND a fee yields two operations", () => {
  const header =
    "Type\tStarted Date\tCompleted Date\tDescription\tAmount\tFee\tCurrency\tState";
  const row =
    "Card Payment\t2026-06-01 10:00:00\t2026-06-01 11:00:00\tHotel Booking\t-100\t5\tEUR\tCOMPLETED";
  const ops = normalizeTsv(`${header}\n${row}`);
  assert.equal(ops.length, 2, "main operation + separate fee");
  const main = ops.find((op) => !op.isFee)!;
  const fee = ops.find((op) => op.isFee)!;
  assert.equal(main.amountCents, 10000, "fee is not folded into the main amount");
  assert.equal(main.direction, "expense");
  assert.equal(fee.amountCents, 500);
  assert.equal(fee.direction, "expense");
  assert.equal(fee.description, "Hotel Booking");
});

test("unsigned amount + unclassifiable Type falls back to the amount sign, not expense", () => {
  // No amount parses negative → amountIsSigned=false; "Type" is the direction
  // column but "Transfer" is unclassifiable, so direction must follow the sign
  // (positive → income), never be forced to expense.
  const text = [
    "Date,Description,Type,Amount",
    "2026-07-02,Salary,Transfer,500.00",
    "2026-07-03,Coffee,Purchase,3.50",
  ].join("\n");
  const analyze = analyzeImport(text, { defaultCurrency: "EUR" });
  const ops = normalizeTextOperations(analyze, {
    columns: guessPhase2Columns(analyze),
    defaultCurrency: analyze.detectedCurrency,
    sourceFormat: "csv",
  });
  const salary = ops.find((op) => op.description === "Salary")!;
  const coffee = ops.find((op) => op.description === "Coffee")!;
  assert.equal(salary.direction, "income", "positive + unclassifiable Type → income");
  assert.equal(coffee.direction, "expense", "'Purchase' still classifies as expense");
});

test("TSV date defaults to Completed Date and Started Date is an alternative", () => {
  const completed = normalizeTsv(ORIGINAL_TSV, "completed");
  assert.equal(completed[0].date, "2026-06-01"); // Tren completed
  assert.equal(completed[0].startedAt, "2026-05-31"); // Tren started

  const started = normalizeTsv(ORIGINAL_TSV, "started");
  assert.equal(started[0].date, "2026-05-31"); // switches saved date to Started
});

test("non-COMPLETED bank state becomes a bank_state issue", () => {
  const text = ORIGINAL_TSV.replace(
    "Tren De Palau\t-9\t0\tEUR\tCOMPLETED",
    "Tren De Palau\t-9\t0\tEUR\tPENDING"
  );
  const ops = normalizeTsv(text);
  const tren = ops.find((op) => op.description === "Tren De Palau");
  assert.ok(tren);
  const issue = tren.issues.find((i) => i.kind === "bank_state");
  assert.ok(issue, "has bank_state issue");
  assert.equal(issue.kind === "bank_state" && issue.state, "PENDING");
});

// --- PDF normalization (parser contract §10) --------------------------------

test("KBank PDF normalizes to the 10 contract operations (Error Correction kept)", () => {
  const result = analyzePdf(KBANK_PAGES);
  assert.equal(result.bank, "kbank");
  const ops = normalizePdfOperations(result.rows, { currency: result.currency });
  assert.equal(ops.length, 10, "10 operations, Beginning Balance excluded");

  const expected = [
    ["2026-06-05", "Debit Card Spending", "expense", 3359],
    ["2026-06-05", "Debit Card Spending", "expense", 335893],
    ["2026-06-05", "Error Correction", "income", 335893],
    ["2026-06-08", "Debit Card Spending", "expense", 20900],
    ["2026-06-11", "Transfer Withdrawal · To BAY X8078 VITALII DEN++", "expense", 200000],
    ["2026-06-12", "Debit Card Spending", "expense", 53957],
    ["2026-06-15", "Debit Card Spending", "expense", 10900],
    ["2026-06-19", "Interest Deposit", "income", 807],
    ["2026-06-19", "Withholding Tax Payable", "expense", 121],
    ["2026-06-20", "Debit Card Spending", "expense", 35000],
  ] as const;

  ops.forEach((op, index) => {
    const [date, description, direction, cents] = expected[index];
    assert.equal(op.date, date, `#${index + 1} date`);
    assert.equal(op.description, description, `#${index + 1} description`);
    assert.equal(op.direction, direction, `#${index + 1} direction`);
    assert.equal(op.amountCents, cents, `#${index + 1} amount`);
    assert.equal(op.currency, "THB");
  });

  // Error Correction is its own income, never merged with the matching debit.
  const debit = ops[1];
  const correction = ops[2];
  assert.equal(debit.direction, "expense");
  assert.equal(correction.direction, "income");
  assert.equal(debit.amountCents, correction.amountCents);
});

test("KBank description drops Ref Code and Channel but keeps beneficiary", () => {
  const result = analyzePdf(KBANK_PAGES);
  const ops = normalizePdfOperations(result.rows, { currency: result.currency });
  for (const op of ops) {
    assert.doesNotMatch(op.description, /Ref Code/i);
    assert.doesNotMatch(op.description, /EDC\/E-Commerce|Automatic Transfer|K PLUS/i);
  }
  assert.ok(ops.some((op) => /To BAY X8078 VITALII DEN/.test(op.description)));
});

// --- duplicate candidate contract (§8, matrix D-01..D-08) -------------------

const OP_EASYPARK: NormalizedOperation = {
  sourceRowId: "tsv-13",
  sourceFormat: "tsv",
  sourceIndex: 13,
  isFee: false,
  date: "2026-06-20",
  startedAt: "2026-06-20",
  completedAt: "2026-06-20",
  description: "EasyPark",
  direction: "expense",
  amountCents: 469,
  currency: "EUR",
  sourceState: "COMPLETED",
  issues: [],
};

test("D-03/D-05: amount+direction+date match; description not required (EasyPark→Парковка)", () => {
  const existing: ExistingTransaction[] = [
    { id: 1, date: "2026-06-19", description: "Парковка", amountCents: -469 },
  ];
  const candidates = findDuplicateCandidates(OP_EASYPARK, existing);
  assert.equal(candidates.length, 1, "matches despite different description");
  assert.equal(candidates[0].id, 1);
});

test("D-02/D-07: opposite direction is never a candidate", () => {
  const existing: ExistingTransaction[] = [
    { id: 1, date: "2026-06-20", description: "EasyPark", amountCents: 469 }, // income
  ];
  assert.equal(findDuplicateCandidates(OP_EASYPARK, existing).length, 0);
});

test("D-03: a different amount is never a candidate", () => {
  const existing: ExistingTransaction[] = [
    { id: 1, date: "2026-06-20", description: "EasyPark", amountCents: -470 },
  ];
  assert.equal(findDuplicateCandidates(OP_EASYPARK, existing).length, 0);
});

test("D-04: the ±3-day window is inclusive and bounded (Started or Completed)", () => {
  const near: ExistingTransaction[] = [
    { id: 1, date: "2026-06-23", description: "EasyPark", amountCents: -469 }, // +3 days
  ];
  const far: ExistingTransaction[] = [
    { id: 1, date: "2026-06-24", description: "EasyPark", amountCents: -469 }, // +4 days
  ];
  assert.equal(findDuplicateCandidates(OP_EASYPARK, near).length, 1, "+3 days is in window");
  assert.equal(findDuplicateCandidates(OP_EASYPARK, far).length, 0, "+4 days is out of window");

  // Started Date widens the window: op started 2026-05-31, completed 2026-06-01.
  const startedMatch: NormalizedOperation = {
    ...OP_EASYPARK,
    startedAt: "2026-05-31",
    completedAt: "2026-06-01",
    date: "2026-06-01",
  };
  const nearStarted: ExistingTransaction[] = [
    { id: 9, date: "2026-05-29", description: "x", amountCents: -469 }, // within 3 of Started
  ];
  assert.equal(findDuplicateCandidates(startedMatch, nearStarted).length, 1);
});

test("D-06: multiple candidates are returned sorted, most likely first", () => {
  const existing: ExistingTransaction[] = [
    { id: 1, date: "2026-06-18", description: "Random", amountCents: -469 },
    { id: 2, date: "2026-06-20", description: "EasyPark", amountCents: -469 },
  ];
  const candidates = findDuplicateCandidates(OP_EASYPARK, existing);
  assert.equal(candidates.length, 2, "user can see other candidates");
  assert.equal(candidates[0].id, 2, "exact description + same day ranks first");
});

test("D-08: in-file rows are never each other's duplicates (empty existing → no dupes)", () => {
  const ops = normalizeTsv(ORIGINAL_TSV);
  const withDupes = attachDuplicateCandidates(ops, []);
  assert.ok(withDupes.every((op) => op.issues.every((i) => i.kind !== "duplicate_candidate")));
});

// --- modified TSV → 14 duplicates + 1 new (parser contract §11) -------------

test("modified TSV yields 14 duplicate candidates + 1 new operation", () => {
  const original = normalizeTsv(ORIGINAL_TSV);
  const existing = asExisting(original); // the account already has the 14 originals

  const check = normalizeTsv(CHECK_TSV);
  assert.equal(check.length, 15, "15 normalized operations");

  const withDupes = attachDuplicateCandidates(check, existing);
  const dupes = withDupes.filter((op) =>
    op.issues.some((i) => i.kind === "duplicate_candidate")
  );
  const fresh = withDupes.filter((op) =>
    op.issues.every((i) => i.kind !== "duplicate_candidate")
  );
  assert.equal(dupes.length, 14, "14 possible duplicates");
  assert.equal(fresh.length, 1, "1 new operation");
  assert.equal(fresh[0].description, "PHASE 2 IMPORT CHECK");
  assert.equal(fresh[0].amountCents, 1234);
  assert.equal(fresh[0].direction, "expense");
});

// --- formatting helpers ------------------------------------------------------

test("formatDateRangeRu renders same-month / cross-month / cross-year", () => {
  assert.equal(formatDateRangeRu("2026-06-01", "2026-06-20"), "1–20 июня 2026");
  assert.equal(formatDateRangeRu("2026-06-05", "2026-06-05"), "5 июня 2026");
  assert.equal(formatDateRangeRu("2026-05-28", "2026-06-03"), "28 мая – 3 июня 2026");
  assert.equal(
    formatDateRangeRu("2025-12-20", "2026-01-03"),
    "20 декабря 2025 – 3 января 2026"
  );
});

test("pluralRu picks the correct Russian form", () => {
  const forms: [string, string, string] = ["операция", "операции", "операций"];
  assert.equal(pluralRu(1, forms), "операция");
  assert.equal(pluralRu(2, forms), "операции");
  assert.equal(pluralRu(5, forms), "операций");
  assert.equal(pluralRu(11, forms), "операций");
  assert.equal(pluralRu(21, forms), "операция");
});

test("descriptionSimilarity is 100 for identical, 0 for unrelated", () => {
  assert.equal(descriptionSimilarity("EasyPark", "EasyPark"), 100);
  assert.equal(descriptionSimilarity("EasyPark", "Парковка"), 0);
  assert.ok(descriptionSimilarity("Turo Park Medical Cent", "Turo Park") > 0);
});
