// Pure forecasting for «Прогнозирование». Money is integer cents. The caller
// supplies a `toDisplay(cents, currency)` converter (the app's single-rate
// conversion) so this module never touches FX itself.
//
// Model (customer spec):
//   Доступный остаток = приходы(факт) − расходы(факт) − желаемая сумма
//                       ± займы, попадающие в месяц
//                       − регулярные, чей день в месяце ЕЩЁ не наступил
//   Daily goal = Доступный остаток / полных дней до конца месяца (вкл. сегодня)
// Already-occurred regulars are left inside actual expenses (not subtracted
// again) — "occurred vs upcoming" is decided by the regular's scheduled day, so
// there is no fuzzy matching against real transactions.

export type RegularPayment = {
  id: number;
  name: string;
  amountCents: number;
  currency: string;
  category: string;
  direction: string; // expense | income
  periodicity: string; // monthly | yearly | every_n_months
  dayOfMonth: number;
  month: number | null;
  intervalMonths: number | null;
  anchorMonth: string | null;
  active: boolean;
  source: string;
};

export type Loan = {
  id: number;
  name: string;
  amountCents: number;
  currency: string;
  direction: string; // owe | owed | reimbursement
  dueDate: string; // YYYY-MM-DD
  status: string; // pending | settled
  settledDate: string | null;
  notes: string;
};

export type ToDisplay = (cents: number, currency: string) => number | null;

export function daysInMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Whole months from anchor (YYYY-MM) to target (YYYY-MM); negative if target is earlier.
function monthDelta(anchor: string, target: string): number {
  const [ay, am] = anchor.split("-").map(Number);
  const [ty, tm] = target.split("-").map(Number);
  return (ty - ay) * 12 + (tm - am);
}

// The day a regular payment lands in month `ym` (clamped to month length), or
// null if it does not occur that month.
export function regularDayInMonth(rp: RegularPayment, ym: string): number | null {
  const month = Number(ym.slice(5, 7));
  let occurs = false;
  if (rp.periodicity === "monthly") {
    occurs = true;
  } else if (rp.periodicity === "yearly") {
    occurs = rp.month != null && rp.month === month;
  } else if (rp.periodicity === "every_n_months") {
    const n = rp.intervalMonths ?? 0;
    if (n >= 1 && rp.anchorMonth && /^\d{4}-\d{2}$/.test(rp.anchorMonth)) {
      const delta = monthDelta(rp.anchorMonth, ym);
      occurs = delta >= 0 && delta % n === 0;
    }
  }
  if (!occurs) return null;
  return Math.min(Math.max(1, rp.dayOfMonth), daysInMonth(ym));
}

// Signed contribution to «Доступный остаток»: outflows negative, inflows positive.
function regularSign(rp: RegularPayment): number {
  return rp.direction === "income" ? 1 : -1;
}
function loanSign(loan: Loan): number {
  return loan.direction === "owe" ? -1 : 1; // owe = we pay out; owed/reimbursement = we receive
}

export type ForecastResult = {
  goalCents: number;
  incomeCents: number;
  expenseCents: number;
  loansNetCents: number;
  upcomingRegularsCents: number; // net signed contribution of not-yet-due regulars
  availableCents: number;
  daysInMonth: number;
  todayDay: number;
  daysLeftInclToday: number;
  dailyGoalCents: number;
  feasible: boolean;
  // Itemized for the breakdown UI (amounts already in display currency, signed):
  regularsThisMonth: Array<{ rp: RegularPayment; day: number; displayCents: number; occurred: boolean }>;
  loansThisMonth: Array<{ loan: Loan; displayCents: number }>;
};

export function forecastMonth(input: {
  month: string; // YYYY-MM (assumed the current month for now)
  today: string; // YYYY-MM-DD
  incomeCents: number; // display currency, actual this month
  expenseCents: number; // display currency, actual this month
  goalCents: number; // display currency
  regularPayments: RegularPayment[];
  loans: Loan[];
  toDisplay: ToDisplay;
}): ForecastResult {
  const { month, today, incomeCents, expenseCents, goalCents, regularPayments, loans, toDisplay } = input;

  const dim = daysInMonth(month);
  const todayInMonth = today.slice(0, 7) === month;
  const todayDay = todayInMonth ? Number(today.slice(8, 10)) : dim; // past-month view → all days done
  const daysLeftInclToday = Math.max(1, dim - todayDay + 1);

  // Regulars occurring this month.
  const regularsThisMonth: ForecastResult["regularsThisMonth"] = [];
  let upcomingRegularsCents = 0;
  for (const rp of regularPayments) {
    if (!rp.active) continue;
    const day = regularDayInMonth(rp, month);
    if (day == null) continue;
    const conv = toDisplay(rp.amountCents, rp.currency);
    if (conv == null) continue; // no rate → skip (flagged elsewhere)
    const signed = regularSign(rp) * conv;
    const occurred = day <= todayDay;
    regularsThisMonth.push({ rp, day, displayCents: signed, occurred });
    if (!occurred) upcomingRegularsCents += signed; // only not-yet-due ones adjust the balance
  }

  // Loans due this month (pending only — settled ones already moved as real txns).
  const loansThisMonth: ForecastResult["loansThisMonth"] = [];
  let loansNetCents = 0;
  for (const loan of loans) {
    if (loan.status !== "pending") continue;
    if (loan.dueDate.slice(0, 7) !== month) continue;
    const conv = toDisplay(loan.amountCents, loan.currency);
    if (conv == null) continue;
    const signed = loanSign(loan) * conv;
    loansThisMonth.push({ loan, displayCents: signed });
    loansNetCents += signed;
  }

  const availableCents = incomeCents - expenseCents - goalCents + loansNetCents + upcomingRegularsCents;
  const dailyGoalCents = Math.round(availableCents / daysLeftInclToday);

  return {
    goalCents,
    incomeCents,
    expenseCents,
    loansNetCents,
    upcomingRegularsCents,
    availableCents,
    daysInMonth: dim,
    todayDay,
    daysLeftInclToday,
    dailyGoalCents,
    feasible: availableCents >= 0,
    regularsThisMonth,
    loansThisMonth,
  };
}

// ── Suggestions (Phase 2) ──────────────────────────────────────────────────
// Normalize a merchant/description into a grouping key: lowercase, drop digits
// and punctuation, collapse whitespace. Prefer payee when present.
export function normalizeKey(description: string, payee?: string): string {
  const raw = (payee && payee.trim()) || description || "";
  return raw
    .toLowerCase()
    .replace(/[0-9]+/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mode<T>(arr: T[]): T | undefined {
  const freq = new Map<T, number>();
  let best: T | undefined;
  let bestN = 0;
  for (const v of arr) {
    const n = (freq.get(v) ?? 0) + 1;
    freq.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

export type SuggestTx = {
  date: string;
  amountCents: number;
  currency: string;
  category: string;
  description: string;
  payee?: string;
};

export type RegularSuggestion = {
  key: string;
  name: string;
  amountCents: number;
  currency: string;
  category: string;
  periodicity: string;
  dayOfMonth: number;
  monthsPresent: number;
};

// Detect likely recurring payments from history: group by normalized
// description, keep groups that recur in ≥ minMonths of the window at about
// once a month, and propose a monthly periodicity on the modal day. Amounts are
// the median monthly total; currency/category are the modal values.
export function suggestRegulars(
  txs: SuggestTx[],
  opts: { windowMonths: string[]; minMonths?: number; maxPerMonth?: number; excludeKeys?: string[] }
): RegularSuggestion[] {
  const minMonths = opts.minMonths ?? 2;
  const maxPerMonth = opts.maxPerMonth ?? 1.5;
  const exclude = new Set(opts.excludeKeys ?? []);
  const monthSet = new Set(opts.windowMonths);

  const groups = new Map<
    string,
    { descs: string[]; currencies: string[]; categories: string[]; days: number[]; perMonth: Map<string, number> }
  >();
  for (const tx of txs) {
    if (tx.amountCents >= 0) continue; // expenses only
    const ym = tx.date.slice(0, 7);
    if (!monthSet.has(ym)) continue;
    // Key by description only (NOT payee): the suggestion is named after the
    // modal description, and the /suggest route excludes already-added payments
    // via normalizeKey(name) — so the group key must be description-derived too,
    // or an accepted payment would keep reappearing and could be added twice.
    const key = normalizeKey(tx.description);
    if (!key || exclude.has(key)) continue;
    let g = groups.get(key);
    if (!g) {
      g = { descs: [], currencies: [], categories: [], days: [], perMonth: new Map() };
      groups.set(key, g);
    }
    g.descs.push(tx.description || key);
    g.currencies.push(tx.currency);
    g.categories.push(tx.category);
    g.days.push(Number(tx.date.slice(8, 10)));
    g.perMonth.set(ym, (g.perMonth.get(ym) ?? 0) + Math.abs(tx.amountCents));
  }

  const out: RegularSuggestion[] = [];
  for (const [key, g] of groups) {
    const monthsPresent = g.perMonth.size;
    if (monthsPresent < minMonths) continue;
    if (g.days.length / monthsPresent > maxPerMonth) continue; // frequent merchant → not a bill
    out.push({
      key,
      name: mode(g.descs) ?? key,
      amountCents: median([...g.perMonth.values()]),
      currency: mode(g.currencies) ?? "",
      category: mode(g.categories) ?? "",
      periodicity: "monthly",
      dayOfMonth: mode(g.days) ?? 1,
      monthsPresent,
    });
  }
  return out.sort((a, b) => b.amountCents - a.amountCents);
}
