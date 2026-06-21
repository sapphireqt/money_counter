import {
  normalizeCurrency,
  parseFlexibleDate,
  parseMoneyInputToCents,
} from "./finance";

/**
 * Bank-statement import engine: delimiter detection, an RFC 4180-ish CSV/TSV
 * parser, a tolerant header-mapping layer (EN/RU + common bank aliases) and
 * amount resolution that understands signed amounts, split debit/credit
 * columns and a separate fee column. Pure and dependency-free so it can be
 * unit-tested in plain Node.
 */

export type FieldKey =
  | "date"
  | "amount"
  | "debit"
  | "credit"
  | "fee"
  | "currency"
  | "description"
  | "payee"
  | "category";

export type ColumnMapping = Record<FieldKey, number>;

export type FieldDef = {
  key: FieldKey;
  label: string;
  /** Ordered by priority — earlier aliases win when several columns match. */
  aliases: string[];
};

export const FIELD_DEFS: FieldDef[] = [
  {
    key: "date",
    label: "Дата",
    aliases: [
      "date",
      "дата",
      "completed date",
      "date completed",
      "booking date",
      "posting date",
      "value date",
      "transaction date",
      "started date",
      "date started",
      "дата операции",
      "дата транзакции",
      "дата платежа",
      "дата проводки",
      // ES
      "fecha",
      "fecha operacion",
      "fecha de operacion",
      "fecha valor",
      "fecha contable",
      // DE
      "buchungstag",
      "buchungsdatum",
      "wertstellung",
      "datum",
      // FR / IT
      "date operation",
      "date de operation",
      "date comptable",
      "date valeur",
      "data",
      "data operazione",
      "data contabile",
      "data valuta",
    ],
  },
  {
    key: "amount",
    label: "Сумма",
    aliases: [
      "amount",
      "сумма",
      "sum",
      "amount eur",
      "amount usd",
      "transaction amount",
      "сумма операции",
      "сумма в валюте счета",
      "сумма в валюте счёта",
      "money",
      // PayPal — "net" already includes the fee, prefer it over "gross".
      // ("total" is intentionally excluded: it is almost always a running
      // balance column, not the per-transaction amount.)
      "net",
      "net amount",
      "gross",
      // ES
      "importe",
      "importe eur",
      // DE
      "betrag",
      "umsatz",
      // FR / IT
      "montant",
      "importo",
    ],
  },
  {
    key: "debit",
    label: "Расход",
    aliases: [
      "debit",
      "дебет",
      "withdrawal",
      "withdrawals",
      "paid out",
      "amount out",
      "money out",
      "out",
      "outflow",
      "расход",
      "списание",
      "списания",
      "сумма расхода",
      // ES / FR / IT
      "debe",
      "cargo",
      "debit",
      "addebito",
    ],
  },
  {
    key: "credit",
    label: "Приход",
    aliases: [
      "credit",
      "кредит",
      "deposit",
      "deposits",
      "paid in",
      "amount in",
      "money in",
      "in",
      "inflow",
      "приход",
      "зачисление",
      "поступление",
      "сумма прихода",
      // ES / FR / IT
      "haber",
      "abono",
      "credito",
      "accredito",
    ],
  },
  {
    key: "fee",
    label: "Комиссия",
    aliases: ["fee", "fees", "комиссия", "commission", "charge fee", "сбор"],
  },
  {
    key: "currency",
    label: "Валюта",
    aliases: [
      "currency",
      "валюта",
      "ccy",
      "cur",
      "валюта операции",
      "divisa",
      "moneda",
      "wahrung",
    ],
  },
  {
    key: "description",
    label: "Описание",
    aliases: [
      "description",
      "описание",
      "details",
      "detail",
      "narrative",
      "reference",
      "memo",
      "purpose",
      "назначение",
      "назначение платежа",
      "comment",
      "комментарий",
      "name",
      "наименование",
      "transaction details",
      // ES
      "concepto",
      "descripcion",
      "detalle",
      // DE
      "verwendungszweck",
      "buchungstext",
      "beschreibung",
      // FR / IT
      "libelle",
      "causale",
      "descrizione",
      "movimiento",
      "concept",
    ],
  },
  {
    key: "payee",
    label: "Контрагент",
    aliases: [
      "payee",
      "merchant",
      "merchant name",
      "beneficiary",
      "counterparty",
      "payer",
      "контрагент",
      "получатель",
      "отправитель",
      "vendor",
    ],
  },
  {
    key: "category",
    label: "Категория",
    // Note: a bank "Type"/"Тип" column (Card Payment, Transfer, …) is a payment
    // method, NOT a spending category, so it is intentionally excluded here.
    // Leaving the category empty lets the user's auto-rules fill it on import.
    aliases: ["category", "категория", "categoria", "categorie"],
  },
];

const DIRECTION_ALIASES = [
  "direction",
  "type",
  "тип",
  "тип операции",
  "operation type",
  "transaction type",
  "debit/credit",
  "dr/cr",
  "cr/dr",
  "indicator",
];

const EXPENSE_WORDS = new Set([
  "expense",
  "out",
  "outcome",
  "outgoing",
  "outgoings",
  "debit",
  "dr",
  "d",
  "withdrawal",
  "payment",
  "purchase",
  "charge",
  "fee",
  "pos",
  "расход",
  "трата",
  "трату",
  "списание",
  "покупка",
  "покупку",
  "оплата",
  "оплату",
  "платеж",
  "дебет",
  "-",
]);

const INCOME_WORDS = new Set([
  "income",
  "in",
  "incoming",
  "revenue",
  "credit",
  "cr",
  "c",
  "deposit",
  "refund",
  "refunds",
  "reimbursement",
  "received",
  "receive",
  "chargeback",
  "приход",
  "доход",
  "поступление",
  "пополнение",
  "зачисление",
  "возврат",
  "получено",
  "кредит",
  "+",
]);

export function normalizeHeaderName(value: string): string {
  return value
    .replace(/^﻿/, "")
    .replace(/^["']+|["']+$/g, "")
    .toLowerCase()
    .replace(/ё/g, "е")
    // Strip Latin diacritics (Währung -> wahrung, descripción -> descripcion)
    // while preserving Cyrillic.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looseHeader(value: string): string {
  return normalizeHeaderName(value)
    .replace(/\([^)]*\)/g, "")
    .replace(/[.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CANDIDATE_DELIMITERS = [",", "\t", ";", "|"];

/**
 * Detect the most likely delimiter by the column count it produces *most
 * consistently* across lines — not the maximum. Consistency dominates so that
 * a few stray delimiter chars inside one description/tags cell can't outvote
 * the real delimiter. Works regardless of file extension (a comma-delimited
 * `.tsv` is still detected as comma).
 */
export function detectDelimiter(text: string): string {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 20);

  if (lines.length === 0) {
    return ",";
  }

  let best = ",";
  let bestScore = -1;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = lines.map((line) => splitLineLoose(line, delimiter).length);

    // Find the modal (most common) column count of at least 2.
    const tally = new Map<number, number>();
    for (const count of counts) {
      if (count >= 2) {
        tally.set(count, (tally.get(count) ?? 0) + 1);
      }
    }
    if (tally.size === 0) {
      continue;
    }

    let modeCount = 0;
    let modeLines = 0;
    for (const [count, lineHits] of tally) {
      if (lineHits > modeLines || (lineHits === modeLines && count > modeCount)) {
        modeCount = count;
        modeLines = lineHits;
      }
    }

    // Consistency (how many lines agree) dominates; column count breaks ties.
    const score = modeLines * 1000 + modeCount;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

// Quote-aware split of a single line, used only for delimiter scoring.
function splitLineLoose(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

/**
 * Full CSV/TSV parser supporting quoted fields, escaped quotes (`""`) and
 * newlines inside quotes. Strips a BOM and skips fully empty rows.
 */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const sep = delimiter ?? detectDelimiter(clean);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    const next = clean[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        continue;
      }
      cell += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === sep) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell.trim());
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }

  return rows;
}

function findHeaderIndex(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeaderName);
  const loose = headers.map(looseHeader);

  for (const alias of aliases) {
    for (let index = 0; index < headers.length; index += 1) {
      if (normalized[index] === alias || loose[index] === alias) {
        return index;
      }
    }
  }
  return -1;
}

// True when `header`'s tokens begin with the alias's tokens, e.g. the alias
// "date" matches a header "date operation" / "fecha valor".
function tokenPrefixMatch(header: string, alias: string): boolean {
  const aliasTokens = alias.split(" ").filter(Boolean);
  const headerTokens = header.split(" ").filter(Boolean);
  if (headerTokens.length < aliasTokens.length) {
    return false;
  }
  return aliasTokens.every((token, i) => headerTokens[i] === token);
}

export function emptyMapping(): ColumnMapping {
  return {
    date: -1,
    amount: -1,
    debit: -1,
    credit: -1,
    fee: -1,
    currency: -1,
    description: -1,
    payee: -1,
    category: -1,
  };
}

export function guessMapping(headers: string[]): ColumnMapping {
  const mapping = emptyMapping();
  const normalized = headers.map(normalizeHeaderName);
  const loose = headers.map(looseHeader);
  const claimed = new Set<number>();

  const claim = (key: FieldKey, index: number) => {
    mapping[key] = index;
    if (index >= 0) {
      claimed.add(index);
    }
  };

  // Pass 1: exact match (normalized or loose), by field then alias priority.
  for (const field of FIELD_DEFS) {
    for (const alias of field.aliases) {
      let found = -1;
      for (let i = 0; i < headers.length; i += 1) {
        if (claimed.has(i)) continue;
        if (normalized[i] === alias || loose[i] === alias) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        claim(field.key, found);
        break;
      }
    }
  }

  // Pass 2: token-prefix match for fields still unmapped, e.g. an alias
  // "net amount" matching a header "Net Amount EUR". Restricted to MULTI-WORD
  // aliases — a single generic word like "data"/"amount" must not fuzzy-grab
  // unrelated headers such as "Data Source" or "Amount Currency".
  for (const field of FIELD_DEFS) {
    if (mapping[field.key] >= 0) continue;
    for (const alias of field.aliases) {
      if (alias.split(" ").length < 2) continue;
      let found = -1;
      for (let i = 0; i < headers.length; i += 1) {
        if (claimed.has(i)) continue;
        if (tokenPrefixMatch(loose[i], alias)) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        claim(field.key, found);
        break;
      }
    }
  }

  // Don't let a single signed "amount" column also masquerade as debit/credit.
  if (mapping.amount >= 0) {
    if (mapping.debit === mapping.amount) mapping.debit = -1;
    if (mapping.credit === mapping.amount) mapping.credit = -1;
  }

  // A "net" amount column already has the fee deducted — don't subtract it
  // again from a separate fee column (PayPal Gross/Fee/Net).
  if (mapping.amount >= 0 && loose[mapping.amount].includes("net")) {
    mapping.fee = -1;
  }

  return mapping;
}

function mappingScore(mapping: ColumnMapping) {
  let score = 0;
  for (const field of FIELD_DEFS) {
    if (mapping[field.key] >= 0) score += 1;
  }
  const hasAmount =
    mapping.amount >= 0 || mapping.debit >= 0 || mapping.credit >= 0;
  const essential = mapping.date >= 0 && hasAmount;
  return (essential ? 100 : 0) + score;
}

// Statements often carry metadata/blank lines above the table. Pick the row
// whose cells look most like a header (best field-alias coverage) instead of
// blindly trusting row 0.
function findHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 15);
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < limit; i += 1) {
    const score = mappingScore(guessMapping(rows[i]));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// A file is "signed" when its amount column actually parses to a negative for
// at least one row (covers leading-, trailing- and unicode-minus). When signed,
// a direction column must be ignored to avoid double negation.
export function detectAmountSigned(
  dataRows: string[][],
  amountIndex: number
): boolean {
  if (amountIndex < 0) {
    return false;
  }
  return dataRows.some((record) => {
    const cents = parseMoneyInputToCents(cellAt(record, amountIndex));
    return cents !== null && cents < 0;
  });
}

function cellAt(record: string[], index: number): string {
  return index >= 0 ? (record[index] ?? "").trim() : "";
}

// Classify a direction from a closed set of debit/credit-like words. Matching
// is token-based: a word only counts when it appears as a whole token (so
// "Outgoing Transfer" -> expense, "Card Refund" -> income), and a value that
// contains BOTH an expense and an income word stays unclassified rather than
// guessing. For signed-amount files the direction column is ignored anyway.
function classifyDirection(value: string): "expense" | "income" | null {
  const normalized = value.trim().toLowerCase().replace(/ё/g, "е");
  if (!normalized) return null;
  if (EXPENSE_WORDS.has(normalized)) return "expense";
  if (INCOME_WORDS.has(normalized)) return "income";

  let hasExpense = false;
  let hasIncome = false;
  for (const token of normalized.split(/[^0-9a-zа-я+-]+/i)) {
    if (!token) continue;
    if (EXPENSE_WORDS.has(token)) hasExpense = true;
    if (INCOME_WORDS.has(token)) hasIncome = true;
  }
  if (hasExpense && !hasIncome) return "expense";
  if (hasIncome && !hasExpense) return "income";
  return null;
}

export type ParsedRow = {
  date: string | null;
  amountCents: number | null;
  currency: string;
  description: string;
  payee: string;
  category: string;
  /** Reason the row is not importable, if any. */
  skip: string | null;
  raw: string[];
};

export type AnalyzeOptions = {
  defaultCurrency?: string;
};

export type AnalyzeResult = {
  delimiter: string;
  headers: string[];
  dataRows: string[][];
  mapping: ColumnMapping;
  directionIndex: number;
  amountIsSigned: boolean;
  detectedCurrency: string;
  rows: ParsedRow[];
  valid: number;
  skipped: number;
};

/**
 * Resolve a single row to signed cents using whatever columns are mapped:
 * split debit/credit, a single signed amount (+ optional direction column for
 * banks that keep amounts positive), minus any separate fee.
 */
export type ResolveOptions = {
  amountIsSigned: boolean;
  directionIndex: number;
  /** Invert the sign of every row — for credit-card exports (charges positive). */
  flipSign?: boolean;
};

export function resolveRowCents(
  record: string[],
  mapping: ColumnMapping,
  options: ResolveOptions
): number | null {
  let base: number | null = null;

  const hasSplit = mapping.debit >= 0 || mapping.credit >= 0;
  if (hasSplit) {
    const debit = parseMoneyInputToCents(cellAt(record, mapping.debit));
    const credit = parseMoneyInputToCents(cellAt(record, mapping.credit));
    if (debit === null && credit === null) {
      base = null;
    } else {
      base = (credit ? Math.abs(credit) : 0) - (debit ? Math.abs(debit) : 0);
    }
  } else if (mapping.amount >= 0) {
    base = parseMoneyInputToCents(cellAt(record, mapping.amount));
    if (base !== null && !options.amountIsSigned && options.directionIndex >= 0) {
      const direction = classifyDirection(cellAt(record, options.directionIndex));
      if (direction === "expense") base = -Math.abs(base);
      if (direction === "income") base = Math.abs(base);
    }
  }

  if (base === null) {
    return null;
  }

  if (options.flipSign) {
    base = -base;
  }

  if (mapping.fee >= 0) {
    const fee = parseMoneyInputToCents(cellAt(record, mapping.fee));
    if (fee) {
      base -= Math.abs(fee);
    }
  }

  return base;
}

function mostCommonCurrency(
  dataRows: string[][],
  currencyIndex: number,
  fallback: string
): string {
  if (currencyIndex < 0) {
    return fallback;
  }
  const counts = new Map<string, number>();
  for (const record of dataRows) {
    const value = cellAt(record, currencyIndex);
    if (!value) continue;
    const normalized = normalizeCurrency(value);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

export function buildRows(
  dataRows: string[][],
  mapping: ColumnMapping,
  options: ResolveOptions & { defaultCurrency: string }
): ParsedRow[] {
  return dataRows.map((record) => {
    const date = parseFlexibleDate(cellAt(record, mapping.date));
    const amountCents = resolveRowCents(record, mapping, options);
    const rawCurrency = cellAt(record, mapping.currency);
    const currency = rawCurrency
      ? normalizeCurrency(rawCurrency)
      : options.defaultCurrency;
    const description = cellAt(record, mapping.description);
    const payee = cellAt(record, mapping.payee);
    const category = cellAt(record, mapping.category);

    let skip: string | null = null;
    if (!date) {
      skip = "нет даты";
    } else if (amountCents === null) {
      skip = "нет суммы";
    } else if (amountCents === 0) {
      skip = "нулевая сумма";
    }

    return {
      date,
      amountCents,
      currency,
      description,
      payee,
      category,
      skip,
      raw: record,
    };
  });
}

export function analyzeImport(
  text: string,
  options: AnalyzeOptions = {}
): AnalyzeResult {
  const fallbackCurrency = normalizeCurrency(options.defaultCurrency ?? "EUR");
  const delimiter = detectDelimiter(text);
  const all = parseDelimited(text, delimiter);
  const headerIndex = findHeaderRow(all);
  const headers = all[headerIndex] ?? [];
  const dataRows = all.slice(headerIndex + 1);
  const mapping = guessMapping(headers);
  const directionIndex = findHeaderIndex(headers, DIRECTION_ALIASES);

  // The file is signed when the amount column actually parses to a negative
  // for some row (covers leading/trailing/unicode minus and parentheses).
  const amountIsSigned = detectAmountSigned(dataRows, mapping.amount);

  const detectedCurrency = mostCommonCurrency(
    dataRows,
    mapping.currency,
    fallbackCurrency
  );

  const rows = buildRows(dataRows, mapping, {
    amountIsSigned,
    directionIndex,
    defaultCurrency: detectedCurrency,
  });

  const valid = rows.filter((row) => !row.skip).length;

  return {
    delimiter,
    headers,
    dataRows,
    mapping,
    directionIndex,
    amountIsSigned,
    detectedCurrency,
    rows,
    valid,
    skipped: rows.length - valid,
  };
}
