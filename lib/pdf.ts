import { parseFlexibleDate, parseMoneyInputToCents } from "./finance.ts";
import type { ParsedRow } from "./import.ts";

/**
 * PDF bank-statement parsing. PURE and framework-free: the caller (the browser)
 * extracts positioned text with pdfjs and passes it in as PdfPage[]; this module
 * only does layout reconstruction, so it can be unit-tested in plain Node.
 *
 * Currently supports one bank profile — Kasikornbank / K PLUS (Thailand, THB).
 * That statement has a single unsigned "Withdrawal / Deposit" column and a
 * running "Outstanding Balance" column, so the sign of each transaction is
 * derived from the balance delta (the only reliable source: there is no
 * debit/credit indicator and the amount itself carries no sign). New banks are
 * added as additional profiles keyed off their header signature.
 */

export type PdfTextItem = { str: string; x: number; y: number };
export type PdfPage = { items: PdfTextItem[] };

export type PdfAnalyzeResult = {
  /** Detected bank profile, or null when no profile matched the document. */
  bank: string | null;
  currency: string;
  rows: ParsedRow[];
  valid: number;
  skipped: number;
};

type Line = { y: number; tokens: PdfTextItem[] };

// Cluster text items into visual lines (shared baseline y). PDF y grows upward,
// so lines come out top -> bottom; tokens within a line are left -> right.
function toLines(items: PdfTextItem[]): Line[] {
  const Y_TOL = 2.5;
  const sorted = items
    .filter((it) => it.str.trim() !== "")
    .slice()
    .sort((a, b) => b.y - a.y);
  const lines: Line[] = [];
  for (const it of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate.y - it.y) <= Y_TOL);
    if (line) line.tokens.push(it);
    else lines.push({ y: it.y, tokens: [it] });
  }
  for (const line of lines) line.tokens.sort((a, b) => a.x - b.x);
  return lines;
}

function joinBand(tokens: PdfTextItem[], min: number, max: number): string {
  return tokens
    .filter((t) => t.x >= min && t.x < max)
    .map((t) => t.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Kasikornbank / K PLUS ---------------------------------------------------
// Column x-bands measured from the statement layout (page width 595):
//   date <95 | time ~101 | description 110..180 | amount 180..290 |
//   outstanding balance 290..335 | channel 330..400 | details 400+
const KBANK = {
  dateMax: 95,
  descMin: 110,
  descMax: 180,
  amtMin: 180,
  amtMax: 290,
  balMin: 290,
  balMax: 335,
  chanMin: 330,
  chanMax: 400,
  detMin: 400,
};

export function detectKbank(pages: PdfPage[]): boolean {
  const text = pages
    .flatMap((page) => page.items.map((item) => item.str))
    .join(" ")
    .toLowerCase();
  const hasColumns =
    text.includes("withdrawal / deposit") ||
    (text.includes("outstanding balance") && text.includes("descriptions"));
  const hasBrand = text.includes("k plus") || text.includes("kbpdf");
  return hasColumns && hasBrand;
}

function lastNumberInBand(
  tokens: PdfTextItem[],
  min: number,
  max: number
): number | null {
  const matches = tokens.filter(
    (t) => t.x >= min && t.x < max && parseMoneyInputToCents(t.str) !== null
  );
  if (matches.length === 0) return null;
  return parseMoneyInputToCents(matches[matches.length - 1].str);
}

export function extractKbank(pages: PdfPage[]): PdfAnalyzeResult {
  const currency = "THB";
  const rows: ParsedRow[] = [];
  let prevBalance: number | null = null;

  for (const page of pages) {
    for (const line of toLines(page.items)) {
      const tokens = line.tokens;
      const first = tokens[0];
      if (!first) continue;

      const dateStr = first.x < KBANK.dateMax ? first.str.trim() : "";
      if (!/^\d{1,2}-\d{1,2}-\d{2,4}$/.test(dateStr)) continue; // not a table row

      const desc = joinBand(tokens, KBANK.descMin, KBANK.descMax);
      const descLower = desc.toLowerCase();
      const balanceCents = lastNumberInBand(tokens, KBANK.balMin, KBANK.balMax);

      // "Beginning Balance" seeds the running balance; it is not a transaction.
      if (descLower.includes("beginning balance")) {
        if (balanceCents !== null) prevBalance = balanceCents;
        continue;
      }
      // Ending balance / per-page totals are not transactions either.
      if (descLower.includes("ending balance") || descLower.startsWith("total ")) {
        continue;
      }

      const date = parseFlexibleDate(dateStr);
      const printed = lastNumberInBand(tokens, KBANK.amtMin, KBANK.amtMax);

      // Sign from the running-balance delta — the amount column is unsigned and
      // there is no debit/credit indicator. Fall back to description keywords
      // only if a balance is somehow missing.
      let amountCents: number | null = null;
      if (balanceCents !== null && prevBalance !== null) {
        amountCents = balanceCents - prevBalance;
      } else if (printed !== null) {
        const income = /deposit|interest|refund|correction|credit/i.test(descLower);
        amountCents = income ? Math.abs(printed) : -Math.abs(printed);
      }
      if (balanceCents !== null) prevBalance = balanceCents;

      // The Channel column ("EDC/E-Commerce", "K PLUS", "Automatic Transfer") is
      // a technical routing label, not part of the human description, so it is
      // dropped. From Details we keep only *useful* text — a transfer beneficiary
      // like "To BAY X0000 JOHN DOE++" — and drop the technical "Ref Code …".
      const details = joinBand(tokens, KBANK.detMin, KBANK.detMin + 200);
      const usefulDetails =
        details && !/^ref\s*code\b/i.test(details) ? details : "";
      const description = usefulDetails ? `${desc} · ${usefulDetails}` : desc;

      let skip: string | null = null;
      let amountAltCents: number | null = null;
      if (!date) {
        skip = "нет даты";
      } else if (amountCents === null) {
        skip = "нет суммы";
      } else if (amountCents === 0) {
        skip = "нулевая сумма";
      } else if (
        // The printed amount must equal the balance delta; a mismatch means the
        // columns were misread, so flag it instead of importing a wrong number.
        printed !== null &&
        Math.abs(Math.abs(amountCents) - Math.abs(printed)) > 1
      ) {
        skip = "сумма ≠ Δостатка";
        // Surface the printed figure alongside the balance-delta amount so the
        // preview can let the user choose which one to import.
        amountAltCents = amountCents < 0 ? -Math.abs(printed) : Math.abs(printed);
      }

      rows.push({
        date,
        amountCents,
        currency,
        description,
        payee: "",
        category: "",
        skip,
        raw: tokens.map((t) => t.str),
        amountAltCents,
      });
    }
  }

  const valid = rows.filter((row) => !row.skip).length;
  return { bank: "kbank", currency, rows, valid, skipped: rows.length - valid };
}

/**
 * Try every known PDF profile. Returns bank=null with no rows when the document
 * matches none — the caller surfaces "формат не распознан".
 */
export function analyzePdf(pages: PdfPage[]): PdfAnalyzeResult {
  if (detectKbank(pages)) {
    return extractKbank(pages);
  }
  return { bank: null, currency: "EUR", rows: [], valid: 0, skipped: 0 };
}
