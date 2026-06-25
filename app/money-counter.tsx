"use client";

import {
  Fragment,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  accountTypes,
  centsToInputValue,
  formatDayHeader,
  formatMoney,
  formatMoneyParts,
} from "../lib/finance";
import {
  analyzeImport,
  buildRows,
  detectAmountSigned,
  FIELD_DEFS,
  type AnalyzeResult,
  type ColumnMapping,
  type FieldKey,
  type ParsedRow,
} from "../lib/import";
import { analyzePdf, type PdfPage } from "../lib/pdf";

type Account = {
  id: number;
  name: string;
  bankName: string;
  currency: string;
  type: string;
  openingBalanceCents: number;
  color: string;
  balanceCents: number;
  transactionCount: number;
};

type Transaction = {
  id: number;
  accountId: number;
  accountName: string;
  accountCurrency: string;
  date: string;
  description: string;
  category: string;
  payee: string;
  amountCents: number;
  status: string;
  notes: string;
};

type Category = { id: number; name: string; color: string };
type Rule = { id: number; pattern: string; category: string };
type Stats = {
  monthly: Array<{ month: string; income: number; expense: number }>;
  byCategory: Array<{ category: string; total: number }>;
  totals: { income: number; expense: number };
};

type AccountForm = {
  name: string;
  bankName: string;
  currency: string;
  type: string;
  openingBalance: string;
  color: string;
};

type TransactionForm = {
  accountId: string;
  date: string;
  direction: "expense" | "income";
  amount: string;
  description: string;
  category: string;
};

type ImportPayloadRow = {
  currency: string;
  date: string;
  amount: string;
  direction: string;
  description: string;
  category: string;
  payee: string;
  notes: string;
};

type Tab = "main" | "settings" | "charts" | "forecast" | "pending";

const DELIMITER_LABELS: Record<string, string> = {
  ",": "запятая",
  ";": "точка с запятой",
  "\t": "табуляция",
  "|": "вертикальная черта",
};

const palette = [
  "#2563eb",
  "#0f766e",
  "#b45309",
  "#be123c",
  "#6d28d9",
  "#0369a1",
  "#4d7c0f",
  "#c2410c",
  "#0891b2",
  "#7c3aed",
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(date: string) {
  return date.slice(0, 7);
}

function ymParts(ym: string) {
  const [year, month] = ym.split("-").map(Number);
  return { year, month };
}

function addMonths(ym: string, delta: number) {
  const { year, month } = ymParts(ym);
  const index = year * 12 + (month - 1) + delta;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

// Real last day of the month as an ISO date. Must be a VALID calendar day —
// "YYYY-MM-31" is rejected by the date validator for 30-day months / February,
// which would silently drop the upper bound of a range query.
function monthEnd(ym: string) {
  const { year, month } = ymParts(ym);
  const day = new Date(year, month, 0).getDate();
  return `${ym}-${String(day).padStart(2, "0")}`;
}

function monthBounds(ym: string) {
  return { from: `${ym}-01`, to: monthEnd(ym) };
}

function formatMonthLabel(ym: string) {
  const { year, month } = ymParts(ym);
  const label = new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, 1));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? "Запрос не выполнен");
  }
  return data as T;
}

// Render a money value with the currency symbol greyed out. The number keeps
// whatever colour its container sets; only the symbol is muted (#DDDDDD, via
// the .currencySymbol class). formatToParts keeps symbol placement correct for
// any locale/currency instead of assuming a trailing symbol.
function Money({ cents, currency }: { cents: number; currency: string }) {
  return (
    <>
      {formatMoneyParts(cents, currency).map((part, index) =>
        part.type === "currency" ? (
          <span key={index} className="currencySymbol">
            {part.value}
          </span>
        ) : (
          <Fragment key={index}>{part.value}</Fragment>
        )
      )}
    </>
  );
}

// Reusable error/attention marker: renders its content red + dotted-underlined
// with a hover tooltip explaining why. Intended to be reused for other soft
// errors, not just missing FX rates.
function Flagged({ reason, children }: { reason: string; children: ReactNode }) {
  return (
    <span className="flagged" title={reason}>
      {children}
    </span>
  );
}

// Convert a per-currency map of cents into a single target currency using a
// USD-based rate map (1 USD = rates[c] units of c). Amounts already in the
// target need no rate. Currencies with no available rate are summed-out and
// reported in `missing` so the caller can flag the result.
function convertTotals(
  totals: Record<string, number>,
  rates: Record<string, number> | null,
  target: string
): { cents: number; missing: string[] } {
  let cents = 0;
  const missing: string[] = [];
  for (const [currency, amount] of Object.entries(totals)) {
    if (amount === 0) continue;
    if (currency === target) {
      cents += amount;
      continue;
    }
    const rateTo = rates?.[target];
    const rateFrom = rates?.[currency];
    if (rateTo != null && rateFrom != null) {
      cents += Math.round((amount * rateTo) / rateFrom);
    } else if (!missing.includes(currency)) {
      missing.push(currency);
    }
  }
  return { cents, missing };
}

// "2024-12-01" -> "01.12.2024" for human-readable tooltips.
function dmy(isoDate: string) {
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

// Donut segment path (outer radius r, inner radius ir, angles in radians).
function donutPath(
  cx: number,
  cy: number,
  r: number,
  ir: number,
  a0: number,
  a1: number
) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const xi1 = cx + ir * Math.cos(a1);
  const yi1 = cy + ir * Math.sin(a1);
  const xi0 = cx + ir * Math.cos(a0);
  const yi0 = cy + ir * Math.sin(a0);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${ir} ${ir} 0 ${large} 0 ${xi0} ${yi0} Z`;
}

function CategoryPie({
  slices,
  currency,
}: {
  slices: Array<{ label: string; value: number; color: string }>;
  currency: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) {
    return <div className="emptyBars">Нет расходов за период</div>;
  }

  const cx = 90;
  const cy = 90;
  const r = 84;
  const ir = 50;
  const start = -Math.PI / 2;
  const arcs = slices.map((slice, index) => {
    const prior = slices.slice(0, index).reduce((sum, item) => sum + item.value, 0);
    const frac = slice.value / total;
    const a0 = start + (prior / total) * Math.PI * 2;
    // Cap sweep just under a full turn so a single 100% slice still renders.
    const a1 = a0 + Math.min(frac, 0.9999) * Math.PI * 2;
    return { ...slice, frac, d: donutPath(cx, cy, r, ir, a0, a1) };
  });

  return (
    <div className="pieWrap">
      <svg viewBox="0 0 180 180" className="pieSvg" role="img" aria-label="Расходы по категориям">
        {arcs.map((arc) => (
          <path key={arc.label} d={arc.d} fill={arc.color} />
        ))}
      </svg>
      <ul className="pieLegend">
        {arcs.map((arc) => (
          <li key={arc.label}>
            <span className="legendDot" style={{ background: arc.color }} />
            <span className="legendName">{arc.label}</span>
            <span className="legendValue">
              <Money cents={arc.value} currency={currency} /> · {Math.round(arc.frac * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MONTH_SHORT = [
  "Янв", "Фев", "Мар", "Апр", "Май", "Июн",
  "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек",
];

// Custom month/period picker — a popover with a 12-month grid and year nav.
// value/onChange are "yyyy-mm" strings. `max` is the newest selectable month
// (the current month): any earlier month is freely selectable (unlimited
// navigation into the past), future months are disabled. Month-only — no day
// selection — so the value stays a plain "yyyy-mm" string.
function MonthPicker({
  value,
  onChange,
  max,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  max: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => ymParts(value).year);
  const containerRef = useRef<HTMLDivElement>(null);

  const maxYear = ymParts(max).year;

  // Close on outside click / Escape while open (client-only, like the modal).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { year: selectedYear, month: selectedMonth } = ymParts(value);

  function toggle() {
    // Always reopen on the selected month's year.
    if (!open) setViewYear(selectedYear);
    setOpen((current) => !current);
  }

  function pick(month: number) {
    const ym = `${viewYear}-${String(month).padStart(2, "0")}`;
    if (ym > max) return;
    onChange(ym);
    setOpen(false);
  }

  return (
    <div className="monthPicker" ref={containerRef}>
      <button
        type="button"
        className="monthPickerTrigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <span>{formatMonthLabel(value)}</span>
        <span className="monthPickerCaret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="monthPickerPanel" role="dialog" aria-label={ariaLabel}>
          <div className="monthPickerHead">
            <button
              type="button"
              className="iconButton small"
              onClick={() => setViewYear((y) => y - 1)}
              aria-label="Предыдущий год"
            >
              ‹
            </button>
            <b>{viewYear}</b>
            <button
              type="button"
              className="iconButton small"
              onClick={() => setViewYear((y) => y + 1)}
              disabled={viewYear >= maxYear}
              aria-label="Следующий год"
            >
              ›
            </button>
          </div>
          <div className="monthPickerGrid">
            {MONTH_SHORT.map((label, index) => {
              const month = index + 1;
              const ym = `${viewYear}-${String(month).padStart(2, "0")}`;
              const isSelected = viewYear === selectedYear && month === selectedMonth;
              return (
                <button
                  key={month}
                  type="button"
                  className={`monthPickerMonth ${isSelected ? "selected" : ""}`}
                  disabled={ym > max}
                  aria-pressed={isSelected}
                  onClick={() => pick(month)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function MoneyCounter() {
  const [activeTab, setActiveTab] = useState<Tab>("main");

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);

  const [mainPeriod, setMainPeriod] = useState(monthKey(today()));
  const [chartFrom, setChartFrom] = useState(addMonths(monthKey(today()), -5));
  const [chartTo, setChartTo] = useState(monthKey(today()));
  const [chartCurrency, setChartCurrency] = useState("");

  // Currency the summary cards are shown in (persisted in localStorage). The
  // balance uses the current month's first-day rate; period income/expense use
  // the selected period's first-day rate. null rate map = not loaded yet.
  const [displayCurrency, setDisplayCurrency] = useState("");
  const [balanceRates, setBalanceRates] = useState<Record<string, number> | null>(null);
  const [periodRates, setPeriodRates] = useState<Record<string, number> | null>(null);

  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const [editingTransactionId, setEditingTransactionId] = useState<number | null>(null);
  // The add/edit form + statement import now live in a single modal dialog,
  // opened from the "Добавить" button or the row edit (pencil) action.
  const [formOpen, setFormOpen] = useState(false);
  const [transactionForm, setTransactionForm] = useState<TransactionForm>({
    accountId: "",
    date: today(),
    direction: "expense",
    amount: "",
    description: "",
    category: "",
  });

  const [accountForm, setAccountForm] = useState<AccountForm>({
    name: "",
    bankName: "",
    currency: "EUR",
    type: "checking",
    openingBalance: "",
    color: palette[0],
  });
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [categoryForm, setCategoryForm] = useState({ name: "", color: palette[1] });
  const [ruleForm, setRuleForm] = useState({ pattern: "", category: "" });

  const [importAnalysis, setImportAnalysis] = useState<AnalyzeResult | null>(null);
  const [importMapping, setImportMapping] = useState<ColumnMapping | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importFlip, setImportFlip] = useState(false);
  const [importEditorOpen, setImportEditorOpen] = useState(false);
  // Non-null when the picked file was a PDF: rows are parsed directly (the sign
  // comes from the running balance), bypassing the CSV column-mapping machinery.
  const [pdfRows, setPdfRows] = useState<ParsedRow[] | null>(null);

  const activeCurrency = accounts[0]?.currency ?? "EUR";

  const monthOptions = useMemo(() => {
    const current = monthKey(today());
    let earliest = current;
    for (const period of periods) {
      if (period && period < earliest) earliest = period;
    }
    const windowStart = addMonths(current, -11);
    if (windowStart < earliest) earliest = windowStart;

    const list: string[] = [];
    let cursor = current;
    while (cursor >= earliest) {
      list.push(cursor);
      cursor = addMonths(cursor, -1);
    }
    return list; // newest first
  }, [periods]);

  // Newest selectable month for the pickers — the current month. (monthOptions
  // is newest-first, so [0] is the current month.)
  const currentMonth = monthOptions[0] ?? monthKey(today());

  const currencyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const account of accounts) set.add(account.currency);
    return [...set];
  }, [accounts]);

  const colorByCategory = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories) map.set(category.name, category.color);
    return map;
  }, [categories]);

  // --- data loading ---------------------------------------------------------
  const loadAccounts = useCallback(async () => {
    const data = await requestJson<{ accounts: Account[] }>("/api/accounts");
    setAccounts(data.accounts);
    setTransactionForm((current) => ({
      ...current,
      accountId: current.accountId || (data.accounts[0] ? String(data.accounts[0].id) : ""),
    }));
    // Keep the chart currency valid: keep the current one if an account still
    // uses it, otherwise fall back to the first account's currency.
    setChartCurrency((current) =>
      data.accounts.some((account) => account.currency === current)
        ? current
        : data.accounts[0]?.currency ?? ""
    );
  }, []);

  const loadCategories = useCallback(async () => {
    const data = await requestJson<{ categories: Category[] }>("/api/categories");
    setCategories(data.categories);
  }, []);

  const loadRules = useCallback(async () => {
    const data = await requestJson<{ rules: Rule[] }>("/api/rules");
    setRules(data.rules);
  }, []);

  const loadPeriods = useCallback(async () => {
    const data = await requestJson<{ periods: string[] }>("/api/periods");
    setPeriods(data.periods);
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      const { from, to } = monthBounds(mainPeriod);
      params.set("from", from);
      params.set("to", to);
      if (selectedAccountId !== "all") params.set("accountId", selectedAccountId);
      if (query.trim()) params.set("q", query.trim());
      if (typeFilter !== "all") params.set("type", typeFilter);
      params.set("limit", "500");

      const data = await requestJson<{ transactions: Transaction[] }>(
        `/api/transactions?${params.toString()}`
      );
      setTransactions(data.transactions);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось загрузить операции");
    }
  }, [mainPeriod, selectedAccountId, query, typeFilter]);

  const loadStats = useCallback(async () => {
    if (!chartCurrency) {
      setStats(null);
      return;
    }
    try {
      const lo = chartFrom <= chartTo ? chartFrom : chartTo;
      const hi = chartFrom <= chartTo ? chartTo : chartFrom;
      const params = new URLSearchParams({
        from: `${lo}-01`,
        to: monthEnd(hi),
        currency: chartCurrency,
      });
      const data = await requestJson<Stats>(`/api/stats?${params.toString()}`);
      setStats(data);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось загрузить статистику");
    }
  }, [chartFrom, chartTo, chartCurrency]);

  const reloadMeta = useCallback(async () => {
    await Promise.all([loadAccounts(), loadCategories(), loadRules(), loadPeriods()]);
  }, [loadAccounts, loadCategories, loadRules, loadPeriods]);

  useEffect(() => {
    void (async () => {
      try {
        await reloadMeta();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Не удалось загрузить данные");
      } finally {
        setLoading(false);
      }
    })();
  }, [reloadMeta]);

  useEffect(() => {
    void (async () => {
      await loadTransactions();
    })();
  }, [loadTransactions]);

  useEffect(() => {
    if (activeTab !== "charts") return;
    void (async () => {
      await loadStats();
    })();
  }, [activeTab, loadStats]);

  // While the modal is open: close on Escape and lock background scrolling.
  useEffect(() => {
    if (!formOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFormOpen(false);
        setEditingTransactionId(null);
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [formOpen]);

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([reloadMeta(), loadTransactions()]);
    if (activeTab === "charts") await loadStats();
  }, [reloadMeta, loadTransactions, loadStats, activeTab]);

  // --- derived --------------------------------------------------------------
  const totalsByCurrency = useMemo(() => {
    return accounts.reduce<Record<string, number>>((totals, account) => {
      totals[account.currency] = (totals[account.currency] ?? 0) + account.balanceCents;
      return totals;
    }, {});
  }, [accounts]);

  const periodIncome = useMemo(() => {
    return transactions.reduce<Record<string, number>>((map, tx) => {
      if (tx.amountCents > 0) {
        map[tx.accountCurrency] = (map[tx.accountCurrency] ?? 0) + tx.amountCents;
      }
      return map;
    }, {});
  }, [transactions]);

  const periodExpense = useMemo(() => {
    return transactions.reduce<Record<string, number>>((map, tx) => {
      if (tx.amountCents < 0) {
        map[tx.accountCurrency] = (map[tx.accountCurrency] ?? 0) + Math.abs(tx.amountCents);
      }
      return map;
    }, {});
  }, [transactions]);

  // --- currency conversion (summary cards) ----------------------------------
  const loadRates = useCallback(
    async (date: string): Promise<Record<string, number>> => {
      const currencies = [...new Set([...currencyOptions, displayCurrency])].filter(Boolean);
      if (currencies.length === 0) return {};
      const params = new URLSearchParams({ date, currencies: currencies.join(",") });
      const data = await requestJson<{ rates: Record<string, number> }>(`/api/rates?${params}`);
      return data.rates ?? {};
    },
    [currencyOptions, displayCurrency]
  );

  // Resolve the display currency once account currencies are known: keep a
  // valid current choice, else the persisted one, else the first available.
  useEffect(() => {
    const first = currencyOptions[0];
    if (!first) return;
    void (async () => {
      const saved = window.localStorage.getItem("mc.displayCurrency");
      setDisplayCurrency((current) => {
        if (current && currencyOptions.includes(current)) return current;
        return saved && currencyOptions.includes(saved) ? saved : first;
      });
    })();
  }, [currencyOptions]);

  // Persist the choice so it survives reloads.
  useEffect(() => {
    if (displayCurrency) window.localStorage.setItem("mc.displayCurrency", displayCurrency);
  }, [displayCurrency]);

  // Fetch the two rate maps: current month's 1st (balance) and the selected
  // period's 1st (income/expense). A single request when the dates coincide.
  useEffect(() => {
    if (!displayCurrency) return;
    const balanceDate = `${currentMonth}-01`;
    const periodDate = `${mainPeriod}-01`;
    void (async () => {
      try {
        const balance = await loadRates(balanceDate);
        setBalanceRates(balance);
        setPeriodRates(periodDate === balanceDate ? balance : await loadRates(periodDate));
      } catch {
        // Loaded-but-empty: conversion flags every non-target currency.
        setBalanceRates({});
        setPeriodRates({});
      }
    })();
  }, [displayCurrency, currentMonth, mainPeriod, loadRates]);

  const balanceConverted = useMemo(
    () => convertTotals(totalsByCurrency, balanceRates, displayCurrency),
    [totalsByCurrency, balanceRates, displayCurrency]
  );
  const incomeConverted = useMemo(
    () => convertTotals(periodIncome, periodRates, displayCurrency),
    [periodIncome, periodRates, displayCurrency]
  );
  const expenseConverted = useMemo(
    () => convertTotals(periodExpense, periodRates, displayCurrency),
    [periodExpense, periodRates, displayCurrency]
  );

  // A summary value in displayCurrency: "…" until rates load, the converted
  // amount otherwise, flagged (red, with a tooltip) if some currency had no rate.
  const renderConverted = (
    conv: { cents: number; missing: string[] },
    rates: Record<string, number> | null,
    dateIso: string
  ): ReactNode => {
    if (!displayCurrency || rates === null) return "…";
    const value = <Money cents={conv.cents} currency={displayCurrency} />;
    if (conv.missing.length === 0) return value;
    return (
      <Flagged reason={`Без учёта ${conv.missing.join(", ")} — нет курса на ${dmy(dateIso)}`}>
        {value}
      </Flagged>
    );
  };

  // Operations grouped by day. The list is one month, sorted date DESC, so
  // same-date rows are already consecutive; the date becomes a group header
  // instead of a per-row column.
  const dayGroups = useMemo(() => {
    const groups: { date: string; items: Transaction[] }[] = [];
    for (const tx of transactions) {
      const last = groups[groups.length - 1];
      if (last && last.date === tx.date) last.items.push(tx);
      else groups.push({ date: tx.date, items: [tx] });
    }
    return groups;
  }, [transactions]);

  // The account-currency amount in its own column, next to the display-currency
  // "Сумма". Empty (—) when the account currency already equals the display
  // currency, since the display column then shows the same value.
  const renderAccountAmount = (transaction: Transaction): ReactNode => {
    const account = transaction.accountCurrency;
    if (!displayCurrency || account === displayCurrency) return "—";
    return <Money cents={Math.abs(transaction.amountCents)} currency={account} />;
  };

  // The operation amount in the display currency (the constant selector choice).
  // Conversion uses the period's first-day rate (periodRates), so rows reconcile
  // with the summary cards. Falls back to the raw amount when no display currency
  // is set, to "…" while rates load, and to a flagged "—" when no rate exists.
  const renderDisplayAmount = (transaction: Transaction): ReactNode => {
    const account = transaction.accountCurrency;
    const cents = Math.abs(transaction.amountCents);
    if (!displayCurrency || account === displayCurrency) {
      return <Money cents={cents} currency={account} />;
    }
    if (periodRates === null) return "…";
    const rateTo = periodRates[displayCurrency];
    const rateFrom = periodRates[account];
    if (rateTo == null || rateFrom == null) {
      return <Flagged reason={`Нет курса ${account} на ${dmy(`${mainPeriod}-01`)}`}>—</Flagged>;
    }
    return <Money cents={Math.round((cents * rateTo) / rateFrom)} currency={displayCurrency} />;
  };

  // Per-account balance for the "Счета" panel, in the display currency. Balances
  // are signed (an account can go negative). Uses balanceRates (current month's
  // 1st), so the rows reconcile with the "Баланс (все счета)" card / panel total.
  const renderAccountBalance = (account: Account): ReactNode => {
    const cents = account.balanceCents;
    const code = account.currency;
    if (!displayCurrency || code === displayCurrency) {
      return <Money cents={cents} currency={code} />;
    }
    if (balanceRates === null) return "…";
    const rateTo = balanceRates[displayCurrency];
    const rateFrom = balanceRates[code];
    if (rateTo == null || rateFrom == null) {
      return <Flagged reason={`Нет курса ${code} на ${dmy(`${currentMonth}-01`)}`}>—</Flagged>;
    }
    return <Money cents={Math.round((cents * rateTo) / rateFrom)} currency={displayCurrency} />;
  };

  // The same balance in the account's own currency (secondary column); empty
  // when it already equals the display currency.
  const renderAccountBalanceNative = (account: Account): ReactNode => {
    if (!displayCurrency || account.currency === displayCurrency) return "—";
    return <Money cents={account.balanceCents} currency={account.currency} />;
  };

  const chartBars = useMemo(() => {
    const monthly = stats?.monthly ?? [];
    const largest = Math.max(1, ...monthly.flatMap((m) => [m.income, m.expense]));
    return { monthly, largest };
  }, [stats]);

  const pieSlices = useMemo(() => {
    const data = stats?.byCategory ?? [];
    const top = data.slice(0, 8);
    const restValue = data.slice(8).reduce((sum, item) => sum + item.total, 0);
    const slices = top.map((item, index) => ({
      label: item.category,
      value: item.total,
      color:
        item.category === "Без категории"
          ? "#94a3b8"
          : colorByCategory.get(item.category) ?? palette[index % palette.length],
    }));
    if (restValue > 0) {
      slices.push({ label: "Остальное", value: restValue, color: "#cbd5e1" });
    }
    return slices;
  }, [stats, colorByCategory]);

  // --- import ---------------------------------------------------------------
  // The import always targets the account selected in the modal's "Счет" field;
  // there is no separate destination picker and no on-the-fly account creation.
  const importAccount = accounts.find(
    (account) => String(account.id) === transactionForm.accountId
  );
  const importCurrency =
    importAccount?.currency ??
    importAnalysis?.detectedCurrency ??
    pdfRows?.[0]?.currency ??
    activeCurrency;

  const importRows = useMemo<ParsedRow[]>(() => {
    // PDF rows are already fully resolved (signed amount, currency) by analyzePdf.
    if (pdfRows) return pdfRows;
    if (!importAnalysis || !importMapping) return [];
    const amountIsSigned = detectAmountSigned(importAnalysis.dataRows, importMapping.amount);
    return buildRows(importAnalysis.dataRows, importMapping, {
      amountIsSigned,
      directionIndex: importAnalysis.directionIndex,
      flipSign: importFlip,
      defaultCurrency: importCurrency,
    });
  }, [pdfRows, importAnalysis, importMapping, importCurrency, importFlip]);

  const importNeedsMapping = Boolean(
    importMapping &&
      (importMapping.date < 0 ||
        (importMapping.amount < 0 && importMapping.debit < 0 && importMapping.credit < 0))
  );
  const importValidRows = useMemo(() => importRows.filter((row) => !row.skip), [importRows]);
  const importTotal = useMemo(
    () => importValidRows.reduce((sum, row) => sum + (row.amountCents ?? 0), 0),
    [importValidRows]
  );
  const importSkipReasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of importRows) {
      if (row.skip) counts.set(row.skip, (counts.get(row.skip) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [importRows]);

  function resetImport() {
    setImportAnalysis(null);
    setImportMapping(null);
    setPdfRows(null);
    setImportFileName("");
    setImportFlip(false);
    setImportEditorOpen(false);
  }

  async function handleImportFile(file: File | null) {
    if (!file) return;
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf) {
      await handlePdfFile(file);
      return;
    }
    try {
      const text = await file.text();
      const analysis = analyzeImport(text, { defaultCurrency: activeCurrency });
      if (analysis.headers.length === 0 || analysis.rows.length === 0) {
        setNotice("Не удалось распознать строки в файле");
        return;
      }
      const hasAmount =
        analysis.mapping.amount >= 0 ||
        analysis.mapping.debit >= 0 ||
        analysis.mapping.credit >= 0;
      const needsMapping = analysis.mapping.date < 0 || !hasAmount;

      setPdfRows(null);
      setImportAnalysis(analysis);
      setImportMapping(analysis.mapping);
      setImportFileName(file.name);
      setImportFlip(false);
      setImportEditorOpen(needsMapping);
      setNotice(
        `Файл распознан: ${analysis.valid} строк к импорту` +
          (analysis.skipped ? `, ${analysis.skipped} пропущено` : "")
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Файл не прочитан");
    }
  }

  // PDF path: pdfjs is loaded lazily (only when a PDF is picked) so it stays out
  // of the main bundle. It extracts positioned text in the browser; the pure
  // analyzePdf (lib/pdf.ts) reconstructs the table into ParsedRow[].
  async function handlePdfFile(file: File) {
    setNotice("Читаю PDF…");
    try {
      const pdfjs = await import("pdfjs-dist");
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

      const data = await file.arrayBuffer();
      const doc = await pdfjs.getDocument({ data }).promise;
      const pages: PdfPage[] = [];
      for (let p = 1; p <= doc.numPages; p += 1) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const items: PdfPage["items"] = [];
        for (const item of content.items) {
          if ("str" in item && typeof item.str === "string") {
            items.push({ str: item.str, x: item.transform[4], y: item.transform[5] });
          }
        }
        pages.push({ items });
      }

      const result = analyzePdf(pages);
      if (!result.bank || result.valid === 0) {
        setNotice(
          "Формат PDF не распознан — поддерживается выписка K PLUS / KBank (THB)"
        );
        return;
      }

      setImportAnalysis(null);
      setImportMapping(null);
      setPdfRows(result.rows);
      setImportFileName(file.name);
      setImportFlip(false);
      setImportEditorOpen(false);
      setNotice(
        `PDF распознан (${result.bank}): ${result.valid} операций к импорту` +
          (result.skipped ? `, ${result.skipped} пропущено` : "")
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PDF не прочитан");
    }
  }

  function updateMapping(field: FieldKey, index: number) {
    setImportMapping((current) => (current ? { ...current, [field]: index } : current));
  }

  async function handleImport() {
    if (importValidRows.length === 0) return;
    // Always import into the account selected in the modal — never create one.
    const accountId = Number(transactionForm.accountId);
    if (!accountId) {
      setNotice("Выберите счёт для импорта");
      return;
    }
    setSaving(true);
    try {
      const rows: ImportPayloadRow[] = importValidRows.map((row) => ({
        currency: row.currency,
        date: row.date ?? "",
        amount: ((row.amountCents ?? 0) / 100).toFixed(2),
        direction: "",
        description: row.description,
        category: row.category,
        payee: row.payee,
        notes: "",
      }));

      const result = await requestJson<{
        createdTransactions: number;
        duplicates: number;
        rejected: Array<{ row: number; reason: string }>;
      }>("/api/import", {
        method: "POST",
        body: JSON.stringify({ rows, accountId }),
      });

      setNotice(
        `Импортировано: ${result.createdTransactions}` +
          (result.duplicates ? `, дублей пропущено: ${result.duplicates}` : "") +
          (result.rejected.length ? `, ошибок: ${result.rejected.length}` : "")
      );
      resetImport();
      setFormOpen(false);
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Импорт не выполнен");
    } finally {
      setSaving(false);
    }
  }

  // --- mutations ------------------------------------------------------------
  async function handleSubmitTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const method = editingTransactionId ? "PATCH" : "POST";
      const url = editingTransactionId
        ? `/api/transactions?id=${editingTransactionId}`
        : "/api/transactions";
      await requestJson(url, { method, body: JSON.stringify(transactionForm) });
      setNotice(editingTransactionId ? "Операция обновлена" : "Операция добавлена");
      setEditingTransactionId(null);
      setFormOpen(false);
      setTransactionForm({
        accountId: transactionForm.accountId || (accounts[0] ? String(accounts[0].id) : ""),
        date: today(),
        direction: "expense",
        amount: "",
        description: "",
        category: "",
      });
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Операция не сохранена");
    } finally {
      setSaving(false);
    }
  }

  function openAddTransaction() {
    setEditingTransactionId(null);
    setTransactionForm({
      accountId: transactionForm.accountId || (accounts[0] ? String(accounts[0].id) : ""),
      date: today(),
      direction: "expense",
      amount: "",
      description: "",
      category: "",
    });
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingTransactionId(null);
    setTransactionForm({
      accountId: transactionForm.accountId || (accounts[0] ? String(accounts[0].id) : ""),
      date: today(),
      direction: "expense",
      amount: "",
      description: "",
      category: "",
    });
  }

  function startEditTransaction(transaction: Transaction) {
    setEditingTransactionId(transaction.id);
    setTransactionForm({
      accountId: String(transaction.accountId),
      date: transaction.date,
      direction: transaction.amountCents < 0 ? "expense" : "income",
      amount: centsToInputValue(Math.abs(transaction.amountCents)),
      description: transaction.description,
      category: transaction.category,
    });
    setActiveTab("main");
    setFormOpen(true);
  }

  async function removeTransaction(transaction: Transaction) {
    if (!window.confirm("Удалить операцию?")) return;
    try {
      await requestJson(`/api/transactions?id=${transaction.id}`, { method: "DELETE" });
      setNotice("Операция удалена");
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Операция не удалена");
    }
  }

  function resetAccountForm() {
    setEditingAccountId(null);
    setAccountForm({
      name: "",
      bankName: "",
      currency: accountForm.currency,
      type: "checking",
      openingBalance: "",
      color: palette[accounts.length % palette.length],
    });
  }

  function startEditAccount(account: Account) {
    setEditingAccountId(account.id);
    setAccountForm({
      name: account.name,
      bankName: account.bankName,
      currency: account.currency,
      type: account.type,
      openingBalance: centsToInputValue(account.openingBalanceCents),
      color: account.color,
    });
  }

  async function handleSubmitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      if (editingAccountId !== null) {
        await requestJson("/api/accounts", {
          method: "PATCH",
          body: JSON.stringify({ id: editingAccountId, ...accountForm }),
        });
        setNotice("Счёт обновлён");
      } else {
        await requestJson("/api/accounts", { method: "POST", body: JSON.stringify(accountForm) });
        setNotice("Счет добавлен");
      }
      resetAccountForm();
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Счёт не сохранён");
    } finally {
      setSaving(false);
    }
  }

  async function removeAccount(account: Account) {
    if (!window.confirm(`Удалить счёт «${account.name}»? Его операции тоже скроются.`)) return;
    try {
      await requestJson(`/api/accounts?id=${account.id}`, { method: "DELETE" });
      setNotice("Счёт удалён");
      if (selectedAccountId === String(account.id)) setSelectedAccountId("all");
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Счёт не удалён");
    }
  }

  async function handleCreateCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await requestJson("/api/categories", { method: "POST", body: JSON.stringify(categoryForm) });
      setNotice("Категория добавлена");
      setCategoryForm({ name: "", color: palette[(categories.length + 1) % palette.length] });
      await loadCategories();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Категория не добавлена");
    } finally {
      setSaving(false);
    }
  }

  async function removeCategory(category: Category) {
    if (!window.confirm(`Удалить категорию «${category.name}»?`)) return;
    try {
      await requestJson(`/api/categories?id=${category.id}`, { method: "DELETE" });
      setNotice("Категория удалена");
      await loadCategories();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Категория не удалена");
    }
  }

  async function handleCreateRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await requestJson("/api/rules", { method: "POST", body: JSON.stringify(ruleForm) });
      setNotice("Правило добавлено");
      setRuleForm({ pattern: "", category: "" });
      await Promise.all([loadRules(), loadCategories()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Правило не добавлено");
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(rule: Rule) {
    try {
      await requestJson(`/api/rules?id=${rule.id}`, { method: "DELETE" });
      setNotice("Правило удалено");
      await loadRules();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Правило не удалено");
    }
  }

  async function applyRules() {
    setSaving(true);
    try {
      const result = await requestJson<{ updated: number }>("/api/rules/apply", {
        method: "POST",
      });
      setNotice(`Категории проставлены: ${result.updated}`);
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось применить правила");
    } finally {
      setSaving(false);
    }
  }

  // --- render ---------------------------------------------------------------
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "main", label: "Операции" },
    { id: "settings", label: "Настройки" },
    { id: "charts", label: "Визуализация" },
    { id: "forecast", label: "Прогнозирование" },
    { id: "pending", label: "Займы" },
  ];

  return (
    <main className="appShell">
      <aside className="sidebar">
        <nav className="sidebarNav" aria-label="Разделы">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`navButton ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="appMain">
        {notice ? <div className="notice">{notice}</div> : null}

      <datalist id="categoryOptions">
        {categories.map((category) => (
          <option key={category.id} value={category.name} />
        ))}
      </datalist>

      {activeTab === "main" ? (
        <>
          {currencyOptions.length > 0 ? (
            <div className="summaryBar">
              <label className="currencyPick">
                В валюте
                <select
                  aria-label="Валюта сводки"
                  value={displayCurrency}
                  onChange={(event) => setDisplayCurrency(event.target.value)}
                >
                  {currencyOptions.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <section className="summaryGrid" aria-label="Сводка">
            <article className="metric">
              <span>Баланс (все счета)</span>
              <strong>{renderConverted(balanceConverted, balanceRates, `${currentMonth}-01`)}</strong>
            </article>
            <article className="metric">
              <span>Поступления периода</span>
              <strong>{renderConverted(incomeConverted, periodRates, `${mainPeriod}-01`)}</strong>
            </article>
            <article className="metric">
              <span>Расходы периода</span>
              <strong>{renderConverted(expenseConverted, periodRates, `${mainPeriod}-01`)}</strong>
            </article>
          </section>

          <div className="workspace twoCol">
            <section className="mainColumn">
              <section className="surface">
                {/* Title lifted above the toolbar; the period picker takes the
                    title's old spot (left), and the primary action sits where
                    the picker used to be (top-right). */}
                <h2 className="opsTitle">Операции</h2>
                <div className="sectionHead">
                  <MonthPicker
                    ariaLabel="Период"
                    value={mainPeriod}
                    onChange={setMainPeriod}
                    max={currentMonth}
                  />
                  <button
                    className="primaryButton"
                    type="button"
                    onClick={openAddTransaction}
                    disabled={saving}
                  >
                    <span>+</span> Добавить
                  </button>
                </div>
                <div className="filters">
                  <input
                    aria-label="Поиск"
                    placeholder="Поиск"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <select
                    aria-label="Счёт"
                    value={selectedAccountId}
                    onChange={(event) => setSelectedAccountId(event.target.value)}
                  >
                    <option value="all">Все счета</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Тип операций"
                    value={typeFilter}
                    onChange={(event) => setTypeFilter(event.target.value)}
                  >
                    <option value="all">Все</option>
                    <option value="expense">Расходы</option>
                    <option value="income">Поступления</option>
                  </select>
                </div>

                <div className="tableWrap">
                  <table className="opsTable">
                    <thead>
                      <tr>
                        <th>Счет</th>
                        <th>Описание</th>
                        <th>Категория</th>
                        <th className="amountCell">Сумма</th>
                        <th className="amountCell">В валюте счёта</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="emptyTable">
                            {loading ? "Загрузка" : "Нет операций за период"}
                          </td>
                        </tr>
                      ) : (
                        dayGroups.map((group) => (
                          <Fragment key={group.date}>
                            <tr className="dayGroup">
                              <td colSpan={6}>{formatDayHeader(group.date)}</td>
                            </tr>
                            {group.items.map((transaction) => (
                              <tr key={transaction.id}>
                                <td>{transaction.accountName}</td>
                                <td>{transaction.description}</td>
                                <td>{transaction.category || "—"}</td>
                                <td
                                  className={`amountCell ${
                                    transaction.amountCents > 0 ? "positive" : ""
                                  }`}
                                >
                                  {/* Expenses are plain black and shown without a
                                      leading minus; only income is coloured (green). */}
                                  {renderDisplayAmount(transaction)}
                                </td>
                                <td className="amountCell">
                                  <span className="altAmount">{renderAccountAmount(transaction)}</span>
                                </td>
                                <td className="rowActions">
                                  <button
                                    className="iconButton small"
                                    type="button"
                                    onClick={() => startEditTransaction(transaction)}
                                    title="Править"
                                    aria-label="Править"
                                  >
                                    <svg
                                      viewBox="0 0 24 24"
                                      width="15"
                                      height="15"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      aria-hidden="true"
                                    >
                                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                                    </svg>
                                  </button>
                                  <button
                                    className="iconButton small danger"
                                    type="button"
                                    onClick={() => removeTransaction(transaction)}
                                    title="Удалить"
                                  >
                                    ×
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </section>

            <section className="surface accountsPanel" aria-label="Баланс по счетам">
              <h2>Счета</h2>
              <table className="balanceTable">
                <tbody>
                  {accounts.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="emptyTable">Нет счетов</td>
                    </tr>
                  ) : (
                    accounts.map((account) => (
                      <tr key={account.id}>
                        <td className="balName">{account.name}</td>
                        <td className="amountCell">{renderAccountBalance(account)}</td>
                        <td className="amountCell">
                          <span className="altAmount">{renderAccountBalanceNative(account)}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {accounts.length > 0 ? (
                  <tfoot>
                    <tr className="balTotal">
                      <td>Итого</td>
                      <td className="amountCell">
                        {renderConverted(balanceConverted, balanceRates, `${currentMonth}-01`)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </section>
          </div>

          {formOpen ? (
            <div
              className="modalOverlay"
              role="dialog"
              aria-modal="true"
              aria-label={editingTransactionId ? "Правка операции" : "Новая операция"}
              onClick={closeForm}
            >
              <div className="modalCard" onClick={(event) => event.stopPropagation()}>
                <div className="modalHead">
                  <h2>{editingTransactionId ? "Правка операции" : "Новая операция"}</h2>
                  <button className="iconButton small" type="button" onClick={closeForm} title="Закрыть">
                    ×
                  </button>
                </div>

                <form className="transactionForm" onSubmit={handleSubmitTransaction}>
                  <label>
                    Счет
                    <select
                      required
                      disabled={accounts.length === 0}
                      value={transactionForm.accountId}
                      onChange={(event) =>
                        setTransactionForm({ ...transactionForm, accountId: event.target.value })
                      }
                    >
                      <option value="">Выберите счет</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Дата
                    <input
                      required
                      type="date"
                      value={transactionForm.date}
                      onChange={(event) =>
                        setTransactionForm({ ...transactionForm, date: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Тип
                    <select
                      value={transactionForm.direction}
                      onChange={(event) =>
                        setTransactionForm({
                          ...transactionForm,
                          direction: event.target.value as TransactionForm["direction"],
                        })
                      }
                    >
                      <option value="expense">Расход</option>
                      <option value="income">Поступление</option>
                    </select>
                  </label>
                  <label>
                    Сумма
                    <input
                      required
                      inputMode="decimal"
                      value={transactionForm.amount}
                      onChange={(event) =>
                        setTransactionForm({ ...transactionForm, amount: event.target.value })
                      }
                    />
                  </label>
                  <label className="wideField">
                    Описание
                    <input
                      value={transactionForm.description}
                      onChange={(event) =>
                        setTransactionForm({ ...transactionForm, description: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Категория
                    <select
                      value={transactionForm.category}
                      onChange={(event) =>
                        setTransactionForm({ ...transactionForm, category: event.target.value })
                      }
                    >
                      <option value="">— без категории —</option>
                      {transactionForm.category &&
                      !categories.some((c) => c.name === transactionForm.category) ? (
                        <option value={transactionForm.category}>
                          {transactionForm.category}
                        </option>
                      ) : null}
                      {categories.map((category) => (
                        <option key={category.id} value={category.name}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primaryButton" disabled={saving || accounts.length === 0} type="submit">
                    <span>{editingTransactionId ? "✓" : "+"}</span>
                    {editingTransactionId ? "Сохранить" : "Добавить"}
                  </button>
                </form>

                {/* Import is only for adding new operations; the edit modal
                    omits it so it differs from the "add" modal. */}
                {!editingTransactionId ? (
                  <div className="modalImport">
                    <div className="sectionHead">
                      <h2>Импорт выписки</h2>
                      <span>{importValidRows.length}</span>
                    </div>
                    <label className="fileDrop">
                      <input
                        type="file"
                        accept=".csv,.tsv,.txt,.pdf,text/csv,text/tab-separated-values,text/plain,application/pdf"
                        onChange={(event) => {
                          const file = event.target.files?.[0] ?? null;
                          event.target.value = "";
                          void handleImportFile(file);
                        }}
                      />
                      <span>{importFileName || "Выбрать файл · CSV, TSV, TXT или PDF"}</span>
                    </label>

                    {(importAnalysis && importMapping) || pdfRows ? (
                      <>
                        <p className="importHint">
                          Импортируется в счёт{" "}
                          <b>
                            {importAccount
                              ? `«${importAccount.name}»`
                              : "— сначала выберите счёт в поле «Счет» выше"}
                          </b>
                        </p>

                        {/* Column mapping + sign flip are CSV-only. PDF rows are
                            already resolved by analyzePdf, so this block is hidden
                            for PDF imports (importAnalysis is null then). */}
                        {importAnalysis && importMapping ? (
                          <>
                            {importNeedsMapping ? (
                              <p className="importWarning">
                                Не найдена колонка даты или суммы — укажите её в разделе «Колонки» ниже.
                              </p>
                            ) : null}

                            <details
                              className="mappingEditor"
                              open={importEditorOpen}
                              onToggle={(event) => setImportEditorOpen(event.currentTarget.open)}
                            >
                              <summary>
                                Колонки · разделитель «
                                {DELIMITER_LABELS[importAnalysis.delimiter] ?? importAnalysis.delimiter}»
                              </summary>
                              <div className="mappingGrid">
                                {FIELD_DEFS.map((field) => (
                                  <label key={field.key}>
                                    {field.label}
                                    <select
                                      value={importMapping[field.key]}
                                      onChange={(event) => updateMapping(field.key, Number(event.target.value))}
                                    >
                                      <option value={-1}>—</option>
                                      {importAnalysis.headers.map((header, index) => (
                                        <option key={index} value={index}>
                                          {header || `Колонка ${index + 1}`}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                ))}
                              </div>
                            </details>

                            <label className="flipToggle">
                              <input
                                type="checkbox"
                                checked={importFlip}
                                onChange={(event) => setImportFlip(event.target.checked)}
                              />
                              Инвертировать знак (выписки по карте: траты как «+»)
                            </label>
                          </>
                        ) : null}

                        <div className="tableWrap importPreview">
                          <table>
                            <thead>
                              <tr>
                                <th>Дата</th>
                                <th>Описание</th>
                                <th className="amountCell">Сумма</th>
                              </tr>
                            </thead>
                            <tbody>
                              {importRows.slice(0, 8).map((row, index) => (
                                <tr key={index} className={row.skip ? "skippedRow" : ""}>
                                  <td>{row.date ?? "—"}</td>
                                  <td>
                                    <b>{row.description || "—"}</b>
                                    {row.skip ? <small>пропуск: {row.skip}</small> : null}
                                  </td>
                                  <td
                                    className={`amountCell ${
                                      (row.amountCents ?? 0) < 0 ? "negative" : "positive"
                                    }`}
                                  >
                                    {row.amountCents === null ? (
                                      "—"
                                    ) : (
                                      <Money
                                        cents={row.amountCents}
                                        currency={row.currency || importCurrency}
                                      />
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div className="importStats">
                          <span>К импорту</span>
                          <b>{importValidRows.length}</b>
                          <span>Пропущено</span>
                          <b>{importRows.length - importValidRows.length}</b>
                          <span>Сумма</span>
                          <b><Money cents={importTotal} currency={importCurrency} /></b>
                        </div>

                        {importSkipReasons.length ? (
                          <p className="importHint">
                            Пропущены:{" "}
                            {importSkipReasons.map(([reason, count]) => `${reason} (${count})`).join(", ")}
                          </p>
                        ) : null}

                        <button
                          className="primaryButton"
                          type="button"
                          disabled={saving || importValidRows.length === 0 || !importAccount}
                          onClick={handleImport}
                        >
                          <span>↓</span> Импортировать {importValidRows.length}
                        </button>
                      </>
                    ) : (
                      <p className="importHint">
                        Поддерживаются выписки банков в CSV и TSV (разделитель, колонки и валюта
                        определяются автоматически) и PDF-выписка K PLUS / KBank. Перед загрузкой
                        можно всё проверить; категории проставятся по правилам из «Настроек».
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {activeTab === "settings" ? (
        <div className="workspace twoCol">
          <section className="mainColumn">
            <section className="surface">
              <div className="sectionHead">
                <h2>Счета</h2>
                <span>{accounts.length}</span>
              </div>
              {accounts.length === 0 ? (
                <div className="mutedBlock">Пока нет счетов</div>
              ) : (
                <ul className="settingsList">
                  {accounts.map((account) => (
                    <li key={account.id}>
                      <span className="accountDot" style={{ background: account.color }} />
                      <span className="settingsListMain">
                        <b>{account.name}</b>
                        <small>
                          {account.currency} · <Money cents={account.balanceCents} currency={account.currency} /> ·{" "}
                          {account.transactionCount} оп.
                        </small>
                      </span>
                      <span className="rowActions">
                        <button
                          className="iconButton small"
                          type="button"
                          title="Изменить"
                          aria-label="Изменить"
                          onClick={() => startEditAccount(account)}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            width="15"
                            height="15"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                          </svg>
                        </button>
                        <button
                          className="iconButton small danger"
                          type="button"
                          title="Удалить"
                          onClick={() => removeAccount(account)}
                        >
                          ×
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <form className="stackForm settingsForm" onSubmit={handleSubmitAccount}>
                <h3>{editingAccountId !== null ? "Правка счёта" : "Новый счёт"}</h3>
                <label>
                  Название
                  <input
                    required
                    value={accountForm.name}
                    onChange={(event) => setAccountForm({ ...accountForm, name: event.target.value })}
                  />
                </label>
                <label>
                  Банк
                  <input
                    value={accountForm.bankName}
                    onChange={(event) => setAccountForm({ ...accountForm, bankName: event.target.value })}
                  />
                </label>
                <div className="formGrid two">
                  <label>
                    Валюта
                    <input
                      maxLength={3}
                      value={accountForm.currency}
                      onChange={(event) =>
                        setAccountForm({ ...accountForm, currency: event.target.value.toUpperCase() })
                      }
                    />
                  </label>
                  <label>
                    Цвет
                    <input
                      className="colorInput"
                      type="color"
                      value={accountForm.color}
                      onChange={(event) => setAccountForm({ ...accountForm, color: event.target.value })}
                    />
                  </label>
                </div>
                <label>
                  Тип
                  <select
                    value={accountForm.type}
                    onChange={(event) => setAccountForm({ ...accountForm, type: event.target.value })}
                  >
                    {accountTypes.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Начальный баланс
                  <input
                    inputMode="decimal"
                    value={accountForm.openingBalance}
                    onChange={(event) =>
                      setAccountForm({ ...accountForm, openingBalance: event.target.value })
                    }
                  />
                </label>
                <button className="primaryButton" disabled={saving} type="submit">
                  <span>{editingAccountId !== null ? "✓" : "+"}</span>
                  {editingAccountId !== null ? "Сохранить" : "Добавить счёт"}
                </button>
                {editingAccountId !== null ? (
                  <button className="textButton" type="button" onClick={resetAccountForm}>
                    Отмена
                  </button>
                ) : null}
              </form>
            </section>
          </section>

          <aside className="rightRail">
            <section className="surface">
              <div className="sectionHead">
                <h2>Категории</h2>
                <span>{categories.length}</span>
              </div>
              {categories.length === 0 ? (
                <div className="mutedBlock">Пока нет категорий</div>
              ) : (
                <ul className="settingsList chips">
                  {categories.map((category) => (
                    <li key={category.id} className="chip">
                      <span className="legendDot" style={{ background: category.color }} />
                      <span>{category.name}</span>
                      <button
                        className="chipRemove"
                        type="button"
                        title="Удалить"
                        onClick={() => removeCategory(category)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form className="stackForm settingsForm" onSubmit={handleCreateCategory}>
                <div className="formGrid two">
                  <label>
                    Название
                    <input
                      required
                      value={categoryForm.name}
                      onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })}
                    />
                  </label>
                  <label>
                    Цвет
                    <input
                      className="colorInput"
                      type="color"
                      value={categoryForm.color}
                      onChange={(event) => setCategoryForm({ ...categoryForm, color: event.target.value })}
                    />
                  </label>
                </div>
                <button className="primaryButton" disabled={saving} type="submit">
                  <span>+</span> Добавить категорию
                </button>
              </form>
            </section>

            <section className="surface">
              <div className="sectionHead">
                <h2>Автокатегории</h2>
                <span>{rules.length}</span>
              </div>
              <p className="importHint">
                Если описание операции содержит текст из правила, ей автоматически ставится
                категория. Например: «EasyPark» → «Transport».
              </p>
              {rules.length > 0 ? (
                <ul className="settingsList">
                  {rules.map((rule) => (
                    <li key={rule.id}>
                      <span className="settingsListMain">
                        <b>{rule.pattern}</b>
                        <small>→ {rule.category}</small>
                      </span>
                      <button
                        className="iconButton small danger"
                        type="button"
                        title="Удалить"
                        onClick={() => removeRule(rule)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <form className="stackForm settingsForm" onSubmit={handleCreateRule}>
                <div className="formGrid two">
                  <label>
                    Текст в описании
                    <input
                      required
                      placeholder="EasyPark"
                      value={ruleForm.pattern}
                      onChange={(event) => setRuleForm({ ...ruleForm, pattern: event.target.value })}
                    />
                  </label>
                  <label>
                    Категория
                    <input
                      required
                      list="categoryOptions"
                      placeholder="Transport"
                      value={ruleForm.category}
                      onChange={(event) => setRuleForm({ ...ruleForm, category: event.target.value })}
                    />
                  </label>
                </div>
                <button className="primaryButton" disabled={saving} type="submit">
                  <span>+</span> Добавить правило
                </button>
              </form>
              <button
                className="secondaryButton"
                type="button"
                disabled={saving || rules.length === 0}
                onClick={() => void applyRules()}
              >
                Применить к операциям без категории
              </button>
            </section>
          </aside>
        </div>
      ) : null}

      {activeTab === "charts" ? (
        <>
          <section className="surface chartToolbar">
            <div className="rangeControls">
              <label>
                С
                <MonthPicker ariaLabel="Начало периода" value={chartFrom} onChange={setChartFrom} max={currentMonth} />
              </label>
              <label>
                По
                <MonthPicker ariaLabel="Конец периода" value={chartTo} onChange={setChartTo} max={currentMonth} />
              </label>
              <label>
                Валюта
                <select
                  aria-label="Валюта"
                  value={chartCurrency}
                  onChange={(event) => setChartCurrency(event.target.value)}
                >
                  {currencyOptions.length === 0 ? <option value="">—</option> : null}
                  {currencyOptions.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="chartTotals">
              <span>
                Поступления <b className="positive"><Money cents={stats?.totals.income ?? 0} currency={chartCurrency || "EUR"} /></b>
              </span>
              <span>
                Расходы <b className="negative"><Money cents={stats?.totals.expense ?? 0} currency={chartCurrency || "EUR"} /></b>
              </span>
            </div>
          </section>

          <div className="workspace twoCol">
            <section className="surface">
              <div className="sectionHead">
                <h2>Движение по месяцам</h2>
                <span>{chartCurrency}</span>
              </div>
              <div className="flowBars" aria-label="Помесячное движение">
                {chartBars.monthly.length === 0 ? (
                  <div className="emptyBars">Нет данных за период</div>
                ) : (
                  chartBars.monthly.map((bar) => (
                    <div className="flowBar" key={bar.month}>
                      <div className="barPair">
                        <span
                          className="incomeBar"
                          style={{ height: `${Math.max(4, (bar.income / chartBars.largest) * 100)}%` }}
                          title={formatMoney(bar.income, chartCurrency || "EUR")}
                        />
                        <span
                          className="expenseBar"
                          style={{ height: `${Math.max(4, (bar.expense / chartBars.largest) * 100)}%` }}
                          title={formatMoney(bar.expense, chartCurrency || "EUR")}
                        />
                      </div>
                      <small>{bar.month.slice(5)}.{bar.month.slice(2, 4)}</small>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="surface">
              <div className="sectionHead">
                <h2>Расходы по категориям</h2>
              </div>
              <CategoryPie slices={pieSlices} currency={chartCurrency || "EUR"} />
            </section>
          </div>
        </>
      ) : null}

      {activeTab === "forecast" ? (
        <div className="workspace oneCol">
          <section className="surface">
            <div className="sectionHead">
              <h2>Прогнозирование</h2>
            </div>
            <div className="mutedBlock">Раздел в разработке.</div>
          </section>
        </div>
      ) : null}

      {activeTab === "pending" ? (
        <div className="workspace oneCol">
          <section className="surface">
            <div className="sectionHead">
              <h2>Займы</h2>
            </div>
            <div className="mutedBlock">Раздел в разработке.</div>
          </section>
        </div>
      ) : null}
      </div>
    </main>
  );
}
