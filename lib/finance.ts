export const accountTypes = [
  { value: "checking", label: "Расчетный" },
  { value: "savings", label: "Накопительный" },
  { value: "cash", label: "Наличные" },
  { value: "credit", label: "Кредитный" },
  { value: "investment", label: "Инвестиции" },
  { value: "other", label: "Другой" },
] as const;

export type AccountType = (typeof accountTypes)[number]["value"];

const validAccountTypes = new Set(accountTypes.map((type) => type.value));

export function normalizeAccountType(value: unknown): AccountType {
  return typeof value === "string" && validAccountTypes.has(value as AccountType)
    ? (value as AccountType)
    : "checking";
}

export function normalizeCurrency(value: unknown) {
  const normalized =
    typeof value === "string" ? value.trim().toUpperCase() : "EUR";

  // 3 letters for fiat, up to 5 to allow crypto tickers (USDT, MATIC, …).
  return /^[A-Z]{3,5}$/.test(normalized) ? normalized : "EUR";
}

export function normalizeColor(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : "#2563eb";
}

export function parseMoneyInputToCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }

  if (typeof value !== "string") {
    return null;
  }

  // Normalize Unicode minus / dash variants to ASCII "-".
  let s = value.trim().replace(/[\u2212\u2012\u2013\u2014\u2015\uff0d\ufe63]/g, "-");
  if (!s) {
    return null;
  }

  let isNegative = false;

  // Accounting parentheses: (45.20) -> -45.20
  if (s.startsWith("(") && s.endsWith(")")) {
    isNegative = true;
    s = s.slice(1, -1).trim();
  }

  // Leading or trailing minus (German/SAP exports write "50,00-").
  const leading = s.match(/^-\s*/);
  if (leading) {
    isNegative = true;
    s = s.slice(leading[0].length);
  }
  const trailing = s.match(/\s*-$/);
  if (trailing) {
    isNegative = true;
    s = s.slice(0, s.length - trailing[0].length);
  }

  // An interior "-" means the cell is not a number ("1-2", "2026-01").
  if (s.includes("-")) {
    return null;
  }

  const cleaned = s.replace(/[^\d.,]/g, "");
  if (!/\d/.test(cleaned)) {
    return null;
  }

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let intPart = "";
  let fracPart = "";

  if (lastComma >= 0 && lastDot >= 0) {
    // Both separators present: the right-most one is the decimal point.
    const decPos = Math.max(lastComma, lastDot);
    intPart = cleaned.slice(0, decPos).replace(/\D/g, "");
    fracPart = cleaned.slice(decPos + 1).replace(/\D/g, "");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const occurrences = cleaned.split(sep).length - 1;
    const pos = cleaned.lastIndexOf(sep);
    const before = cleaned.slice(0, pos).replace(/\D/g, "");
    const after = cleaned.slice(pos + 1).replace(/\D/g, "");
    // Repeated separators ("1.234.567") are always grouping. A single
    // separator followed by exactly 3 digits is grouping ("1.234" -> 1234)
    // only when the part before it is a valid leading group (1-3 digits, no
    // leading zero) — so "0.999" / "00.123" stay decimals.
    if (occurrences > 1 || (after.length === 3 && /^[1-9]\d{0,2}$/.test(before))) {
      intPart = cleaned.replace(/\D/g, "");
      fracPart = "";
    } else {
      intPart = before;
      fracPart = after;
    }
  } else {
    intPart = cleaned.replace(/\D/g, "");
  }

  if (!intPart && !fracPart) {
    return null;
  }

  const parsed = Number(`${intPart || "0"}.${fracPart || "0"}`);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const cents = Math.round(parsed * 100);
  return isNegative ? -Math.abs(cents) : cents;
}

export function resolveSignedAmountCents(
  amount: unknown,
  direction: unknown
): number | null {
  const parsed = parseMoneyInputToCents(amount);
  if (parsed === null) {
    return null;
  }

  const normalizedDirection =
    typeof direction === "string" ? direction.trim().toLowerCase() : "";

  if (
    ["expense", "out", "outcome", "расход", "трата", "списание"].includes(
      normalizedDirection
    )
  ) {
    return -Math.abs(parsed);
  }

  if (
    ["income", "in", "revenue", "приход", "доход", "поступление"].includes(
      normalizedDirection
    )
  ) {
    return Math.abs(parsed);
  }

  return parsed;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9,
  sept: 9, oct: 10, nov: 11, dec: 12,
  янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6, июл: 7, авг: 8,
  сен: 9, окт: 10, ноя: 11, дек: 12,
};

function toIsoDate(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  // Reject impossible calendar days (Feb 31, Apr 31, Feb 29 in non-leap years)
  // so they don't silently roll over when later rendered with `new Date`.
  // `setUTCFullYear` avoids the legacy 0-99 -> 1900-1999 mapping of `Date.UTC`.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function expandYear(value: number): number {
  if (value >= 100) {
    return value;
  }
  return value >= 70 ? 1900 + value : 2000 + value;
}

/**
 * Robust date parser for bank statements. Returns an ISO `YYYY-MM-DD` string
 * (no time, no timezone shift) or null. Handles ISO date/datetime,
 * `DD.MM.YYYY`, `DD/MM/YYYY`, `MM/DD/YYYY` (auto-disambiguated), `YYYY/MM/DD`,
 * two-digit years, and `DD Mon YYYY` / `Mon DD, YYYY` with EN/RU month names.
 */
export function parseFlexibleDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const raw = value.trim().replace(/^["']+|["']+$/g, "").trim();
  if (!raw) {
    return null;
  }

  // ISO: 2026-05-31, 2026/05/31, 2026.05.31, optionally followed by a time.
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (match) {
    return toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  // Day/month/year with separators, optionally followed by a time.
  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T].*)?$/);
  if (match) {
    let day = Number(match[1]);
    let month = Number(match[2]);
    // Default is EU day-first. Swap to MM/DD only when the second part can't be
    // a month but the first one can (e.g. US "06/20/2026").
    if (month > 12 && day <= 12) {
      [day, month] = [month, day];
    }
    return toIsoDate(expandYear(Number(match[3])), month, day);
  }

  // Day Month-name Year: "31 May 2026", "31-май-2026", "1 Jun 26".
  match = raw.match(/^(\d{1,2})[ .\-/]+([A-Za-zА-Яа-я]+)[ .,\-/]+(\d{2,4})$/);
  if (match) {
    const month = MONTH_NAMES[match[2].toLowerCase().slice(0, 4)] ??
      MONTH_NAMES[match[2].toLowerCase().slice(0, 3)];
    if (month) {
      return toIsoDate(expandYear(Number(match[3])), month, Number(match[1]));
    }
  }

  // Month-name Day, Year: "May 31, 2026", "Jun 1 2026".
  match = raw.match(/^([A-Za-zА-Яа-я]+)[ .\-/]+(\d{1,2})[ .,\-/]+(\d{2,4})$/);
  if (match) {
    const month = MONTH_NAMES[match[1].toLowerCase().slice(0, 4)] ??
      MONTH_NAMES[match[1].toLowerCase().slice(0, 3)];
    if (month) {
      return toIsoDate(expandYear(Number(match[3])), month, Number(match[2]));
    }
  }

  return null;
}

export function normalizeDateInput(value: unknown) {
  return parseFlexibleDate(value);
}

export type CategoryRule = { pattern: string; category: string };

/**
 * Return the category of the first rule whose pattern is a case-insensitive
 * substring of the given text (description/payee), or "" if none match.
 */
export function matchCategoryRule(text: unknown, rules: CategoryRule[]): string {
  if (typeof text !== "string" || !text.trim()) {
    return "";
  }
  const haystack = text.toLowerCase();
  for (const rule of rules) {
    const pattern = rule.pattern.trim().toLowerCase();
    if (pattern && haystack.includes(pattern)) {
      return rule.category;
    }
  }
  return "";
}

export function centsToInputValue(cents: number) {
  return (cents / 100).toFixed(2);
}

export function formatMoneyParts(cents: number, currency: string) {
  const code = normalizeCurrency(currency);
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).formatToParts(cents / 100);
  } catch {
    // Intl only accepts ISO-shaped (3-letter) currency codes and throws on
    // crypto tickers like USDT. Emulate the ru-RU currency layout instead:
    // "1 234,56" + narrow space + the code as the currency part.
    const parts: Intl.NumberFormatPart[] = [
      ...new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).formatToParts(cents / 100),
      { type: "literal", value: " " },
      { type: "currency", value: code },
    ];
    return parts;
  }
}

export function formatMoney(cents: number, currency: string) {
  return formatMoneyParts(cents, currency)
    .map((part) => part.value)
    .join("");
}

// Phase 1 day-group header, e.g. "24 июня".
export function formatDayHeader(date: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  }).format(new Date(`${date}T00:00:00`));
}
