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

  return /^[A-Z]{3}$/.test(normalized) ? normalized : "EUR";
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

  let normalized = value.trim();
  if (!normalized) {
    return null;
  }

  let isNegative = false;
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    isNegative = true;
    normalized = normalized.slice(1, -1);
  }

  normalized = normalized.replace(/[^\d,.\-]/g, "");
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("-")) {
    isNegative = true;
    normalized = normalized.slice(1);
  }

  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  const decimalSeparator =
    lastComma > lastDot ? "," : lastDot > lastComma ? "." : null;

  if (decimalSeparator) {
    const parts = normalized.split(decimalSeparator);
    const decimals = parts.pop() ?? "";
    normalized = `${parts.join("").replace(/[^\d]/g, "")}.${decimals.replace(
      /[^\d]/g,
      ""
    )}`;
  } else {
    normalized = normalized.replace(/[^\d]/g, "");
  }

  const parsed = Number(normalized);
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

export function normalizeDateInput(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const raw = value.trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return raw;
  }

  const dottedMatch = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dottedMatch) {
    const [, day, month, year] = dottedMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

export function centsToInputValue(cents: number) {
  return (cents / 100).toFixed(2);
}

export function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: normalizeCurrency(currency),
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatDateShort(date: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
  }).format(new Date(`${date}T00:00:00`));
}
