// Pure, framework-free forecasting engine for the «Прогнозирование» (budget)
// mode. All money is integer cents already converted to ONE display currency by
// the caller (via the app's rate logic); this module never touches FX.
//
// Model (locked with the user):
//  • Recurring "committed" items (bills + subscriptions) are detected by
//    RECURRENCE over the prior complete months — appears in ≥ minMonths of the
//    window and lands ~once a month (avgPerMonth ≤ maxPerMonth), so frequent
//    merchants (groceries) stay discretionary.
//  • The savings goal X is met strictly from THIS MONTH'S income; the current
//    balance is NOT part of the daily-target math.
//  • Daily target t is rolling (budget left ÷ days left incl. today); the day
//    colouring uses a FLAT allowance a = B / daysInMonth.
//  • Income, when not yet received, is the median of the window months.

export type ForecastTx = {
  date: string; // YYYY-MM-DD
  cents: number; // signed, DISPLAY currency: + income, − expense
  category: string;
  description: string;
  payee?: string;
  isTransfer: boolean;
};

export type RecurringItem = {
  key: string;
  label: string; // human sample label (first seen description)
  monthsPresent: number;
  avgPerMonth: number;
  expectedMonthlyCents: number; // median of monthly sums (magnitude)
};

export type ForecastResult = {
  recurring: RecurringItem[];
  excludedRecurring: RecurringItem[]; // detected but manually removed from «committed»
  incomeMedianCents: number;
  incomeSoFarCents: number;
  expectedIncomeCents: number;
  committedPaidCents: number;
  committedUpcomingCents: number;
  committedTotalCents: number;
  goalCents: number;
  discretionaryBudgetCents: number; // B = expectedIncome − committedTotal − goal
  feasible: boolean;
  shortfallCents: number; // >0 when B < 0
  daysInMonth: number;
  dayOfMonth: number;
  daysLeftInclToday: number;
  dailyAllowanceCents: number; // a = B / daysInMonth (colouring line)
  discretionarySpentCents: number;
  discretionaryBeforeTodayCents: number;
  todayDiscretionaryCents: number;
  rollingTargetCents: number; // t = (B − spentBeforeToday) / daysLeftInclToday
  remainingTodayCents: number; // t − todayDiscretionary
  projectedEndCents: number; // point 1: total money at month end, current pace
  perDayDiscretionaryCents: Record<string, number>; // date → discretionary spend
};

export function ymOf(date: string): string {
  return date.slice(0, 7);
}

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

// Detect recurring committed items over the window months.
// Only these categories can hold committed items. Bills live in «B (must-pay)»
// and subscriptions in «LS (apps)»; everything else (groceries, fuel, diapers,
// haircut, investment interest…) is discretionary by nature even when it recurs
// ~monthly. Validated against real data — the allowlist drops all false
// positives that a category-agnostic recurrence scan produced.
export const COMMITTED_CATEGORIES = ["B (must-pay)", "LS (apps)"];

export function detectRecurring(
  windowTxs: ForecastTx[],
  windowMonths: string[],
  opts: { minMonths?: number; maxPerMonth?: number; committedCategories?: string[] } = {}
): RecurringItem[] {
  const minMonths = opts.minMonths ?? 3;
  const maxPerMonth = opts.maxPerMonth ?? 1.5;
  const allow = new Set(
    (opts.committedCategories ?? COMMITTED_CATEGORIES).map((c) => c.toLowerCase().trim())
  );
  const monthSet = new Set(windowMonths);

  // key → { label, perMonth: Map<ym, {count, sum}> }
  const groups = new Map<
    string,
    { label: string; perMonth: Map<string, { count: number; sum: number }> }
  >();
  for (const tx of windowTxs) {
    if (tx.isTransfer || tx.cents >= 0) continue; // expenses only
    if (!allow.has((tx.category ?? "").toLowerCase().trim())) continue; // only bill/subscription categories
    const ym = ymOf(tx.date);
    if (!monthSet.has(ym)) continue;
    const key = normalizeKey(tx.description, tx.payee);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { label: (tx.payee?.trim() || tx.description || key), perMonth: new Map() };
      groups.set(key, g);
    }
    const cell = g.perMonth.get(ym) ?? { count: 0, sum: 0 };
    cell.count += 1;
    cell.sum += Math.abs(tx.cents);
    g.perMonth.set(ym, cell);
  }

  const items: RecurringItem[] = [];
  for (const [key, g] of groups) {
    const monthsPresent = g.perMonth.size;
    if (monthsPresent < minMonths) continue;
    const totalCount = [...g.perMonth.values()].reduce((s, c) => s + c.count, 0);
    const avgPerMonth = totalCount / monthsPresent;
    if (avgPerMonth > maxPerMonth) continue; // frequent merchant (e.g. groceries) → discretionary
    const monthlySums = [...g.perMonth.values()].map((c) => c.sum);
    items.push({
      key,
      label: g.label,
      monthsPresent,
      avgPerMonth,
      expectedMonthlyCents: median(monthlySums),
    });
  }
  return items.sort((a, b) => b.expectedMonthlyCents - a.expectedMonthlyCents);
}

export function forecastMonth(input: {
  windowTxs: ForecastTx[];
  windowMonths: string[];
  currentTxs: ForecastTx[];
  currentMonth: string;
  today: string; // YYYY-MM-DD
  goalCents: number;
  currentBalanceCents: number;
  manualExpectedIncomeCents?: number | null; // user-set monthly income; overrides the noisy auto-median
  excludeKeys?: string[]; // recurring keys the user manually removed from «committed»
}): ForecastResult {
  const { windowTxs, windowMonths, currentTxs, currentMonth, today, goalCents, currentBalanceCents } = input;
  const manualExpectedIncomeCents = input.manualExpectedIncomeCents ?? null;
  const excludeSet = new Set(input.excludeKeys ?? []);
  // Same category allowlist the detector uses — the current-month matcher must
  // apply it too, or a discretionary-category purchase whose payee/description
  // collides with a committed key (e.g. an Amazon order vs Amazon Prime) would
  // be misbooked as the month's bill payment.
  const committedCatSet = new Set(COMMITTED_CATEGORIES.map((c) => c.toLowerCase().trim()));

  const allDetected = detectRecurring(windowTxs, windowMonths);
  const recurring = allDetected.filter((r) => !excludeSet.has(r.key));
  const excludedRecurring = allDetected.filter((r) => excludeSet.has(r.key));
  const recurringKeys = new Set(recurring.map((r) => r.key));
  const expectedByKey = new Map(recurring.map((r) => [r.key, r.expectedMonthlyCents]));

  // Income median over the window (per-month income totals).
  const incomeByMonth = new Map<string, number>();
  for (const tx of windowTxs) {
    if (tx.isTransfer || tx.cents <= 0) continue;
    const ym = ymOf(tx.date);
    incomeByMonth.set(ym, (incomeByMonth.get(ym) ?? 0) + tx.cents);
  }
  const incomeMedianCents = median(windowMonths.map((m) => incomeByMonth.get(m) ?? 0));

  // Current month.
  let incomeSoFarCents = 0;
  let committedPaidCents = 0;
  let discretionarySpentCents = 0;
  let discretionaryBeforeTodayCents = 0;
  let todayDiscretionaryCents = 0;
  const seenKeys = new Set<string>();
  const perDayDiscretionaryCents: Record<string, number> = {};

  for (const tx of currentTxs) {
    if (tx.isTransfer) continue;
    if (tx.cents > 0) {
      incomeSoFarCents += tx.cents;
      continue;
    }
    const mag = Math.abs(tx.cents);
    const key = normalizeKey(tx.description, tx.payee);
    if (recurringKeys.has(key) && committedCatSet.has((tx.category ?? "").toLowerCase().trim())) {
      committedPaidCents += mag;
      seenKeys.add(key);
      continue;
    }
    // discretionary
    discretionarySpentCents += mag;
    perDayDiscretionaryCents[tx.date] = (perDayDiscretionaryCents[tx.date] ?? 0) + mag;
    if (tx.date < today) discretionaryBeforeTodayCents += mag;
    else if (tx.date === today) todayDiscretionaryCents += mag;
  }

  // Committed still upcoming this month = recurring groups not yet seen.
  let committedUpcomingCents = 0;
  for (const r of recurring) {
    if (!seenKeys.has(r.key)) committedUpcomingCents += expectedByKey.get(r.key) ?? 0;
  }
  const committedTotalCents = committedPaidCents + committedUpcomingCents;

  // Manual income (if set) is authoritative — the auto-median lumps salary with
  // one-off refunds, crypto moves and bank corrections and reads too high.
  const expectedIncomeCents =
    manualExpectedIncomeCents != null ? manualExpectedIncomeCents : Math.max(incomeSoFarCents, incomeMedianCents);

  const discretionaryBudgetCents = expectedIncomeCents - committedTotalCents - goalCents;
  const feasible = discretionaryBudgetCents >= 0;
  const shortfallCents = feasible ? 0 : -discretionaryBudgetCents;

  const dim = daysInMonth(currentMonth);
  const dayOfMonth = Number(today.slice(8, 10));
  const daysLeftInclToday = Math.max(1, dim - dayOfMonth + 1);

  const dailyAllowanceCents = Math.round(discretionaryBudgetCents / dim);

  // Budget still available from today onward: subtract discretionary spent on
  // ANY non-today day this month (incl. future-dated manual entries), not just
  // strictly-earlier days.
  const budgetLeftFromTodayCents =
    discretionaryBudgetCents - (discretionarySpentCents - todayDiscretionaryCents);
  const rollingTargetCents = Math.round(budgetLeftFromTodayCents / daysLeftInclToday);
  const remainingTodayCents = rollingTargetCents - todayDiscretionaryCents;

  // Projected end-of-month total money (point 1). Remaining discretionary is
  // extrapolated from the AVERAGE daily spend so far. (A median over elapsed
  // days collapses to 0 whenever most days have no spend — typical — so it
  // badly under-predicts; the mean is the honest "at current pace" estimate.)
  const expectedRemainingIncomeCents = Math.max(0, expectedIncomeCents - incomeSoFarCents);
  const futureDays = dim - dayOfMonth;
  const paceDailyCents = dayOfMonth > 0 ? discretionarySpentCents / dayOfMonth : 0;
  const projectedRemainingDiscCents = Math.round(paceDailyCents * futureDays);
  const projectedEndCents =
    currentBalanceCents +
    expectedRemainingIncomeCents -
    committedUpcomingCents -
    projectedRemainingDiscCents;

  return {
    recurring,
    excludedRecurring,
    incomeMedianCents,
    incomeSoFarCents,
    expectedIncomeCents,
    committedPaidCents,
    committedUpcomingCents,
    committedTotalCents,
    goalCents,
    discretionaryBudgetCents,
    feasible,
    shortfallCents,
    daysInMonth: dim,
    dayOfMonth,
    daysLeftInclToday,
    dailyAllowanceCents,
    discretionarySpentCents,
    discretionaryBeforeTodayCents,
    todayDiscretionaryCents,
    rollingTargetCents,
    remainingTodayCents,
    projectedEndCents,
    perDayDiscretionaryCents,
  };
}
