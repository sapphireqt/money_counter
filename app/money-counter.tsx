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
import { forecastMonth, type ForecastResult, type ForecastTx } from "../lib/forecast";

type Account = {
  id: number;
  name: string;
  bankName: string;
  currency: string;
  type: string;
  openingBalanceCents: number;
  color: string;
  // Lifetime bounds (null = «всегда»): the opening balance counts from
  // openedAt, and the «Счета» panel hides the account outside the range
  // unless a non-zero balance says otherwise.
  openedAt: string | null;
  closedAt: string | null;
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
  // Shared id of a transfer's two legs («Перемещение» between own accounts);
  // null for ordinary operations. Linked legs count toward balances but not
  // toward income/expense/category aggregates.
  transferGroup: string | null;
  // «Требует внимания» marker; the explanation usually lives in `notes`.
  flagged: boolean;
};

// A row of the operations table: an ordinary transaction, or two loaded legs
// of one transfer collapsed into a single «A → B» line.
type DisplayRow =
  | { kind: "tx"; tx: Transaction }
  | { kind: "transfer"; out: Transaction; incoming: Transaction };

// One side of a detected transfer pair as /api/transfers/detect returns it.
type DetectLeg = {
  id: number;
  accountName: string;
  currency: string;
  date: string;
  description: string;
  amountCents: number;
};
type DetectPair = { out: DetectLeg; incoming: DetectLeg };

type Category = { id: number; name: string; color: string };
type Rule = { id: number; pattern: string; category: string };
type Currency = { code: string; name: string; symbol: string };
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
  openedAt: string;
  closedAt: string;
};

type TransactionForm = {
  accountId: string;
  date: string;
  // "transfer" in ADD mode creates a new linked pair (from/to accounts); in
  // EDIT mode it switches the modal into the pick-a-partner flow (or marks
  // an already linked leg).
  direction: "expense" | "income" | "transfer";
  amount: string;
  description: string;
  category: string;
  // Transfer-only fields: the receiving account and (for cross-currency
  // transfers) the amount that actually arrived, in its currency.
  toAccountId: string;
  amountIn: string;
  // «Требует внимания» + its explanation (persisted in transactions.notes).
  flagged: boolean;
  notes: string;
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

// An account belongs to a period iff its lifetime overlaps it: opened on/before
// the view end and not closed before the view start. The close date is
// authoritative regardless of balance. Shared by the «Счета» panel and the
// start-of-period total so both sum the SAME set — «начало + приход − расход =
// конец» reconciles even when a closed account still carries a residual balance.
function accountInPeriod(
  account: { openedAt: string | null; closedAt: string | null },
  viewStart: string,
  viewEnd: string
) {
  const openedInTime = !account.openedAt || account.openedAt <= viewEnd;
  const notYetClosed = !account.closedAt || account.closedAt >= viewStart;
  return openedInTime && notYetClosed;
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

// Ellipsis-clamped text that shows the fast tooltip ONLY when it is actually
// truncated: measured on mouseenter (before the tooltip's 0.2s delay), so
// fully visible names get no redundant popup.
function ClampedName({ text }: { text: string }) {
  const [clamped, setClamped] = useState(false);
  const spanRef = useRef<HTMLSpanElement>(null);
  return (
    <span
      className="accCellWrap"
      {...(clamped ? { "data-tip": text } : {})}
      onMouseEnter={() => {
        const el = spanRef.current;
        if (el) setClamped(el.scrollWidth > el.clientWidth + 1);
      }}
    >
      <span ref={spanRef} className="accName">
        {text}
      </span>
    </span>
  );
}

// Date field with a GUARANTEED дд.мм.гггг display: native date inputs format
// per the browser locale (Chrome ignores the page lang), so the visible face
// is ours and the hidden native input only supplies the calendar popup and
// the ISO value. value/onChange stay ISO yyyy-mm-dd.
function DateField({
  value,
  onChange,
  required,
  disabled,
}: {
  value: string;
  onChange: (iso: string) => void;
  required?: boolean;
  disabled?: boolean;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  return (
    <span className="dateField">
      <button
        type="button"
        className="dateFieldFace"
        disabled={disabled}
        onClick={() => {
          const picker = pickerRef.current;
          if (!picker) return;
          try {
            picker.showPicker();
          } catch {
            picker.focus();
          }
        }}
      >
        {value ? dmy(value) : <span className="dateFieldEmpty">дд.мм.гггг</span>}
      </button>
      <input
        ref={pickerRef}
        type="date"
        className="dateFieldNative"
        tabIndex={-1}
        aria-hidden="true"
        required={required}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}

// Pencil "edit" icon used by list rows (right-leaning, currentColor stroke).
function EditIcon() {
  return (
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

// Horizontal category bars under the «Счета» panel: the selected period's
// expenses by category, largest first. Bars scale to the largest category (so
// the ranking is readable), the number after each bar is the category's share
// of the period's expenses. No axes on purpose — it's a ranking, not a chart
// to read values off. The 44px term reserves room for the share label, so the
// longest bar's label lands at the panel's right edge.
function CategoryBars({
  items,
  uncategorized,
  currency,
}: {
  items: Array<{ label: string; cents: number; share: number; color: string }>;
  uncategorized: { label: string; cents: number; share: number; color: string } | null;
  currency: string;
}) {
  const all = uncategorized ? [...items, uncategorized] : items;
  if (all.length === 0) {
    return <div className="emptyBars">Нет расходов за период</div>;
  }
  // Bars scale to the single largest value — including «Без категории», so
  // lengths stay comparable across the divider.
  const largest = Math.max(...all.map((item) => item.cents));
  const renderRow = (item: (typeof all)[number]) => (
    <div
      key={item.label}
      className="catBarRow"
      title={`${item.label} — ${formatMoney(item.cents, currency)}`}
    >
      <span className="catBarLabel">{item.label}</span>
      <span className="catBarTrack">
        <span
          className="catBarFill"
          style={{
            width: `calc((100% - 44px) * ${Math.max(item.cents / largest, 0.02).toFixed(4)})`,
            background: item.color,
          }}
        />
        <span className="catBarPct">
          {item.share < 0.5 ? "<1%" : `${Math.round(item.share)}%`}
        </span>
      </span>
    </div>
  );
  return (
    <div className="catBars">
      {items.map(renderRow)}
      {uncategorized ? (
        <>
          {items.length > 0 ? <div className="catBarsDivider" /> : null}
          {renderRow(uncategorized)}
        </>
      ) : null}
    </div>
  );
}

const MONTH_SHORT = [
  "Янв", "Фев", "Мар", "Апр", "Май", "Июн",
  "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек",
];

// Custom month/period picker — a single capsule: prev/next arrows flanking a
// trigger that opens a popover with a 12-month grid and year nav. value/
// onChange are "yyyy-mm" strings. `max` is the newest selectable month (the
// current month): the next-arrow stops there, while going back is unlimited,
// same as the calendar. Month-only — no day selection — so the value stays a
// plain "yyyy-mm" string.
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
      <span className="monthPickerCapsule">
        <button
          type="button"
          className="monthPickerArrow"
          aria-label="Предыдущий месяц"
          title="Предыдущий месяц"
          onClick={() => onChange(addMonths(value, -1))}
        >
          ‹
        </button>
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
        <button
          type="button"
          className="monthPickerArrow"
          aria-label="Следующий месяц"
          title="Следующий месяц"
          disabled={value >= max}
          onClick={() => onChange(addMonths(value, 1))}
        >
          ›
        </button>
      </span>
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
  // The operations LIST (list filters applied)...
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  // ...and the same period WITHOUT list filters: cards, «Траты», and the
  // category bars aggregate over the whole month regardless of filtering.
  const [periodTransactions, setPeriodTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);
  // The server's notion of the current (UTC) month — the boundary past which
  // the UI shows the historical end-of-period view. Kept in sync via
  // /api/periods so a tab left open across a month rollover stays correct.
  const [serverMonth, setServerMonth] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);

  const [mainPeriod, setMainPeriod] = useState(monthKey(today()));
  const [chartFrom, setChartFrom] = useState(addMonths(monthKey(today()), -5));
  const [chartTo, setChartTo] = useState(monthKey(today()));
  const [chartCurrency, setChartCurrency] = useState("");

  // Currency the summary cards are shown in (persisted in localStorage).
  // ONE rate map per view (null = not loaded yet): the last day of the
  // selected past month, or the last day of the PREVIOUS month when the
  // current month is shown — so rates never move during a month and every
  // number of the period (cards, rows, panel) converts at the same date.
  const [displayCurrency, setDisplayCurrency] = useState("");
  const [periodRates, setPeriodRates] = useState<Record<string, number> | null>(null);
  // Per-currency account balances as of the start of the selected period
  // (null = loading), for the "Баланс на начало периода" card.
  const [startTotals, setStartTotals] = useState<Record<string, number> | null>(null);

  // Прогнозирование (budget mode) — PROTOTYPE state, all persisted in
  // localStorage (no DB/schema changes). See lib/forecast.ts for the math.
  const [budgetMode, setBudgetMode] = useState(false); // ops-overlay toggle (card + day tints)
  const [forecastIncome, setForecastIncome] = useState(8500); // expected monthly income, display-currency major units — a FIXED manual field
  const [forecastGoal, setForecastGoal] = useState(0); // savings goal X, display-currency major units
  const [excludedCommitted, setExcludedCommitted] = useState<string[]>([]); // recurring keys the user removed from «committed»
  const [historyTxs, setHistoryTxs] = useState<Transaction[] | null>(null); // prior 6 months, for recurrence detection
  // Historical view of a past period: account balances as of the period end
  // (null = loading or the period is current).
  const [endAccounts, setEndAccounts] = useState<Account[] | null>(null);

  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  // Category name, "Без категории" for uncategorized, "" = no filter.
  const [categoryFilter, setCategoryFilter] = useState("");
  // Show only rows marked «Требует внимания».
  const [flaggedOnly, setFlaggedOnly] = useState(false);
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
    toAccountId: "",
    amountIn: "",
    flagged: false,
    notes: "",
  });
  // Pick-a-partner flow (edit modal, type «Перемещение»): opposite-sign
  // candidates around the edited operation's date, and the chosen partner.
  const [partnerCandidates, setPartnerCandidates] = useState<Transaction[] | null>(null);
  const [partnerId, setPartnerId] = useState("");
  // Inline creation of a missing partner right inside the picker.
  const [partnerCreate, setPartnerCreate] = useState({
    open: false,
    accountId: "",
    amount: "",
    date: "",
  });
  // Per-row «⋮» actions menu: the key of the open one (tx-<id> / transfer-<group>)
  // and whether it opens upward (when the row is near the viewport bottom).
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [rowMenuUp, setRowMenuUp] = useState(false);
  // Viewport-fixed coordinates of the open menu (right/top/bottom in px), so it
  // escapes the `.tableWrap` overflow clip instead of hiding under a short list.
  const [rowMenuPos, setRowMenuPos] = useState<{ right: number; top: number; bottom: number } | null>(null);
  // «Найти переводы»: auto-detected same-amount pairs awaiting confirmation.
  const [detectPairs, setDetectPairs] = useState<DetectPair[] | null>(null);
  const [detectChecked, setDetectChecked] = useState<Set<number>>(new Set());
  const [detectOpen, setDetectOpen] = useState(false);

  const [accountForm, setAccountForm] = useState<AccountForm>({
    name: "",
    bankName: "",
    currency: "EUR",
    type: "checking",
    openingBalance: "",
    color: palette[0],
    openedAt: today(),
    closedAt: "",
  });
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [categoryForm, setCategoryForm] = useState({ name: "", color: palette[1] });
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [ruleForm, setRuleForm] = useState({ pattern: "", category: "" });
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [currencyForm, setCurrencyForm] = useState({ code: "", name: "", symbol: "" });
  const [editingCurrencyCode, setEditingCurrencyCode] = useState<string | null>(null);
  // Настройки sub-navigation + per-list add/edit modals.
  const [settingsTab, setSettingsTab] = useState<"accounts" | "categories" | "currencies">("accounts");
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [currencyModalOpen, setCurrencyModalOpen] = useState(false);

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

  // Newest selectable month for the pickers and the freeze boundary — the
  // current month. Prefer the server's answer (loadPeriods) so a long-lived
  // tab agrees with the API after a UTC month rollover; fall back to the local
  // clock before the first /api/periods response. (monthOptions is
  // newest-first, so [0] is the locally derived current month.)
  const currentMonth = serverMonth || (monthOptions[0] ?? monthKey(today()));

  // A past month gets the historical view: the «Счета» panel and the
  // end-of-period card show balances as they stood at the period's end,
  // converted at the period's last-day rate. Everything stays editable —
  // edits simply recalculate the historical numbers.
  const pastPeriod = mainPeriod < currentMonth;

  // The single conversion-rate date for everything on screen (see the
  // periodRates comment above).
  const periodRateDate = pastPeriod
    ? monthEnd(mainPeriod)
    : monthEnd(addMonths(currentMonth, -1));

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

  // Options for the category filter: the reference book plus any category
  // actually present in the loaded operations (older imports could write
  // names past the book) plus the current selection, so it never vanishes
  // from the list while active. Case-insensitive identity, like everywhere.
  const categoryFilterOptions = useMemo(() => {
    // Reference-book names first, in their manual order; names seen only in
    // the loaded operations follow as an alphabetical tail.
    const names = new Map<string, string>();
    for (const category of categories) {
      names.set(category.name.toLowerCase(), category.name);
    }
    const extras = new Map<string, string>();
    for (const tx of periodTransactions) {
      const name = tx.category.trim();
      if (name && !names.has(name.toLowerCase())) extras.set(name.toLowerCase(), name);
    }
    if (categoryFilter && categoryFilter !== "Без категории") {
      if (!names.has(categoryFilter.toLowerCase())) {
        extras.set(categoryFilter.toLowerCase(), categoryFilter);
      }
    }
    return [
      ...names.values(),
      ...[...extras.values()].sort((a, b) => a.localeCompare(b, "ru")),
    ];
  }, [categories, periodTransactions, categoryFilter]);

  // --- data loading ---------------------------------------------------------
  const loadAccounts = useCallback(async () => {
    const data = await requestJson<{ accounts: Account[] }>("/api/accounts");
    setAccounts(data.accounts);
    // No default account in the new-operation form — the user picks one
    // explicitly, so accountId is left empty ("Выберите счет").
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

  const loadCurrencies = useCallback(async () => {
    const data = await requestJson<{ currencies: Currency[] }>("/api/currencies");
    setCurrencies(data.currencies);
  }, []);

  const loadPeriods = useCallback(async () => {
    const data = await requestJson<{ periods: string[]; currentMonth?: string }>(
      "/api/periods"
    );
    setPeriods(data.periods);
    setServerMonth(data.currentMonth ?? "");
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const { from, to } = monthBounds(mainPeriod);
      const base = new URLSearchParams({ from, to, limit: "500" });
      const filtered = new URLSearchParams(base);
      if (selectedAccountId !== "all") filtered.set("accountId", selectedAccountId);
      if (query.trim()) filtered.set("q", query.trim());
      if (typeFilter !== "all") filtered.set("type", typeFilter);
      if (categoryFilter) filtered.set("category", categoryFilter);
      if (flaggedOnly) filtered.set("flagged", "1");
      const hasListFilters = filtered.toString() !== base.toString();

      const data = await requestJson<{ transactions: Transaction[] }>(
        `/api/transactions?${filtered.toString()}`
      );
      setTransactions(data.transactions);
      // One request when no filters are active; a second, unfiltered one
      // otherwise so the analytics keep covering the whole month.
      if (hasListFilters) {
        const full = await requestJson<{ transactions: Transaction[] }>(
          `/api/transactions?${base.toString()}`
        );
        setPeriodTransactions(full.transactions);
      } else {
        setPeriodTransactions(data.transactions);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось загрузить операции");
    }
  }, [mainPeriod, selectedAccountId, query, typeFilter, categoryFilter, flaggedOnly]);

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
    await Promise.all([
      loadAccounts(),
      loadCategories(),
      loadRules(),
      loadCurrencies(),
      loadPeriods(),
    ]);
  }, [loadAccounts, loadCategories, loadRules, loadCurrencies, loadPeriods]);

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

  // Close the row actions menu on outside click / Escape (same pattern as the
  // month picker popover).
  useEffect(() => {
    if (rowMenu === null) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest(".rowMenuWrap")) setRowMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRowMenu(null);
    };
    // The menu is viewport-fixed, so any scroll (page or a container like
    // `.tableWrap`) detaches it from its row — close it instead. Capture phase
    // catches scrolls that don't bubble.
    const onScroll = () => setRowMenu(null);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [rowMenu]);

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
  // Transfer legs (tx.transferGroup) are movements between own accounts, not
  // income or spending — every aggregate below skips them.
  const periodIncome = useMemo(() => {
    return periodTransactions.reduce<Record<string, number>>((map, tx) => {
      if (tx.amountCents > 0 && !tx.transferGroup) {
        map[tx.accountCurrency] = (map[tx.accountCurrency] ?? 0) + tx.amountCents;
      }
      return map;
    }, {});
  }, [periodTransactions]);

  const periodExpense = useMemo(() => {
    return periodTransactions.reduce<Record<string, number>>((map, tx) => {
      if (tx.amountCents < 0 && !tx.transferGroup) {
        map[tx.accountCurrency] = (map[tx.accountCurrency] ?? 0) + Math.abs(tx.amountCents);
      }
      return map;
    }, {});
  }, [periodTransactions]);

  // The period's expenses per category for the bars under the «Счета» panel,
  // converted to the display currency at the single view rate (same as the
  // cards, so the bar total reconciles with «Расходы периода»), sorted
  // largest-first. Currencies with no rate are collected for a flagged note.
  const categoryBars = useMemo(() => {
    const perCategory = new Map<string, Record<string, number>>();
    for (const tx of periodTransactions) {
      if (tx.amountCents >= 0 || tx.transferGroup) continue;
      const name = tx.category || "Без категории";
      const totals = perCategory.get(name) ?? {};
      totals[tx.accountCurrency] =
        (totals[tx.accountCurrency] ?? 0) + Math.abs(tx.amountCents);
      perCategory.set(name, totals);
    }
    const missing = new Set<string>();
    const rows = [...perCategory.entries()]
      .map(([label, totals]) => {
        const conv = convertTotals(totals, periodRates, displayCurrency);
        for (const code of conv.missing) missing.add(code);
        return { label, cents: conv.cents };
      })
      .filter((row) => row.cents > 0)
      .sort((a, b) => b.cents - a.cents);
    const total = rows.reduce((sum, row) => sum + row.cents, 0);
    const items = rows.map((row, index) => ({
      ...row,
      share: total > 0 ? (row.cents / total) * 100 : 0,
      color:
        row.label === "Без категории"
          ? "#94a3b8"
          : colorByCategory.get(row.label) ?? palette[index % palette.length],
    }));
    // «Без категории» renders below a divider, after the real categories.
    return {
      items: items.filter((item) => item.label !== "Без категории"),
      uncategorized: items.find((item) => item.label === "Без категории") ?? null,
      missing: [...missing],
    };
  }, [periodTransactions, periodRates, displayCurrency, colorByCategory]);

  // The transaction currently being edited in the modal (null while adding).
  const editingTransaction = useMemo(
    () => transactions.find((tx) => tx.id === editingTransactionId) ?? null,
    [transactions, editingTransactionId]
  );

  // Candidates for the pick-a-partner flow: opposite-sign operations on OTHER
  // accounts within ±7 days of the edited one, exact currency+amount matches
  // first, then by date proximity. Fetched from the API (the partner may sit
  // outside the currently loaded month). Late responses are dropped.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPartnerCandidates(null);
      setPartnerId("");
      setPartnerCreate({ open: false, accountId: "", amount: "", date: "" });
      const tx = editingTransaction;
      if (!formOpen || !tx || transactionForm.direction !== "transfer" || tx.transferGroup) {
        return;
      }
      const [year, month, day] = tx.date.split("-").map(Number);
      const base = Date.UTC(year, month - 1, day);
      const iso = (ts: number) => new Date(ts).toISOString().slice(0, 10);
      const dayOf = (date: string) => {
        const [y, m, d] = date.split("-").map(Number);
        return Date.UTC(y, m - 1, d) / 86400000;
      };
      try {
        const params = new URLSearchParams({
          from: iso(base - 7 * 86400000),
          to: iso(base + 7 * 86400000),
          limit: "500",
        });
        const data = await requestJson<{ transactions: Transaction[] }>(
          `/api/transactions?${params}`
        );
        if (cancelled) return;
        const wantIncoming = tx.amountCents < 0;
        const candidates = data.transactions
          .filter(
            (cand) =>
              cand.id !== tx.id &&
              !cand.transferGroup &&
              cand.accountId !== tx.accountId &&
              (wantIncoming ? cand.amountCents > 0 : cand.amountCents < 0)
          )
          .sort((a, b) => {
            const exact = (cand: Transaction) =>
              cand.accountCurrency === tx.accountCurrency &&
              Math.abs(cand.amountCents) === Math.abs(tx.amountCents)
                ? 0
                : 1;
            if (exact(a) !== exact(b)) return exact(a) - exact(b);
            return (
              Math.abs(dayOf(a.date) - dayOf(tx.date)) -
              Math.abs(dayOf(b.date) - dayOf(tx.date))
            );
          });
        setPartnerCandidates(candidates);
      } catch {
        if (!cancelled) setPartnerCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formOpen, editingTransaction, transactionForm.direction]);

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

  // Fetch the view's rate map; late responses are dropped so quick period
  // switches never leave another month's rates applied.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPeriodRates(null);
      if (!displayCurrency) return;
      try {
        const rates = await loadRates(periodRateDate);
        if (!cancelled) setPeriodRates(rates);
      } catch {
        // Loaded-but-empty: conversion flags every non-target currency.
        if (!cancelled) setPeriodRates({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [displayCurrency, periodRateDate, loadRates]);

  // Account balances as of the start of the selected period (opening + every
  // transaction before the 1st). Refetched on period change or after a mutation
  // (accounts reloads), then summed per currency — over the SAME lifetime-
  // filtered set as the «Счета» panel, so the start-of-period card reconciles
  // with the end (a closed account is excluded from both, not just the end).
  useEffect(() => {
    const viewStart = pastPeriod ? `${mainPeriod}-01` : today();
    const viewEnd = pastPeriod ? monthEnd(mainPeriod) : today();
    void (async () => {
      try {
        const data = await requestJson<{ accounts: Account[] }>(
          `/api/accounts?asOf=${mainPeriod}-01`
        );
        setStartTotals(
          data.accounts.reduce<Record<string, number>>((map, account) => {
            if (!accountInPeriod(account, viewStart, viewEnd)) return map;
            map[account.currency] = (map[account.currency] ?? 0) + account.balanceCents;
            return map;
          }, {})
        );
      } catch {
        setStartTotals({});
      }
    })();
  }, [mainPeriod, accounts, pastPeriod]);

  // Historical view data for a past period: balances as of the period end
  // (asOf is exclusive, so the next month's 1st includes every transaction of
  // the period). `accounts` is a dependency so the numbers refresh after any
  // mutation. State is cleared up front and late responses are dropped.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setEndAccounts(null);
      if (!pastPeriod) return;
      try {
        const data = await requestJson<{ accounts: Account[] }>(
          `/api/accounts?asOf=${addMonths(mainPeriod, 1)}-01`
        );
        if (!cancelled) setEndAccounts(data.accounts);
      } catch (error) {
        if (!cancelled) {
          setNotice(
            error instanceof Error ? error.message : "Не удалось загрузить остатки периода"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pastPeriod, mainPeriod, accounts]);

  // The «Счета» panel shows live balances — or, for a past period, the
  // historical end-of-period state. Conversion shares the single view rate.
  // An account is shown only in periods that overlap its lifetime: hidden
  // before it opened and after it closed. The close date is authoritative even
  // with a non-zero balance — a closed account no longer holds live money, so
  // it leaves «Итого» (its residual balance, if any, means the opening balance
  // or a closing transaction is still unset — a data gap, not a reason to show
  // it forever). The opening side needs no balance guard: the asOf balance is
  // already 0 before opened_at, so a not-yet-opened account is naturally empty.
  const panelAccounts = useMemo(() => {
    const source = pastPeriod ? endAccounts ?? [] : accounts;
    const viewStart = pastPeriod ? `${mainPeriod}-01` : today();
    const viewEnd = pastPeriod ? monthEnd(mainPeriod) : today();
    return source.filter((account) => accountInPeriod(account, viewStart, viewEnd));
  }, [pastPeriod, endAccounts, accounts, mainPeriod]);
  const panelRates = periodRates;
  const panelRateDate = periodRateDate;
  const panelTotals = useMemo(() => {
    return panelAccounts.reduce<Record<string, number>>((totals, account) => {
      totals[account.currency] = (totals[account.currency] ?? 0) + account.balanceCents;
      return totals;
    }, {});
  }, [panelAccounts]);
  const panelConverted = useMemo(
    () => convertTotals(panelTotals, panelRates, displayCurrency),
    [panelTotals, panelRates, displayCurrency]
  );
  const startConverted = useMemo(
    () => convertTotals(startTotals ?? {}, periodRates, displayCurrency),
    [startTotals, periodRates, displayCurrency]
  );
  const incomeConverted = useMemo(
    () => convertTotals(periodIncome, periodRates, displayCurrency),
    [periodIncome, periodRates, displayCurrency]
  );
  const expenseConverted = useMemo(
    () => convertTotals(periodExpense, periodRates, displayCurrency),
    [periodExpense, periodRates, displayCurrency]
  );

  // ── Прогнозирование (budget mode) ─────────────────────────────────────────
  // Load persisted settings once. Wrapped in an IIFE so setState isn't called
  // synchronously in the effect body (react-compiler rule).
  useEffect(() => {
    void (async () => {
      const g = window.localStorage.getItem("mc.forecastGoal");
      const inc = window.localStorage.getItem("mc.forecastIncome");
      const ex = window.localStorage.getItem("mc.forecastExcluded");
      const bm = window.localStorage.getItem("mc.budgetMode");
      if (g != null) setForecastGoal(Number(g) || 0);
      if (inc != null) setForecastIncome(Number(inc) || 0);
      if (ex != null) {
        try {
          const parsed = JSON.parse(ex);
          if (Array.isArray(parsed)) setExcludedCommitted(parsed);
        } catch {
          /* ignore corrupt value */
        }
      }
      if (bm != null) setBudgetMode(bm === "1");
    })();
  }, []);
  useEffect(() => {
    window.localStorage.setItem("mc.forecastGoal", String(forecastGoal));
  }, [forecastGoal]);
  useEffect(() => {
    window.localStorage.setItem("mc.forecastIncome", String(forecastIncome));
  }, [forecastIncome]);
  useEffect(() => {
    window.localStorage.setItem("mc.forecastExcluded", JSON.stringify(excludedCommitted));
  }, [excludedCommitted]);
  useEffect(() => {
    window.localStorage.setItem("mc.budgetMode", budgetMode ? "1" : "0");
  }, [budgetMode]);

  // The 6 complete months before the current one — the recurrence-detection
  // window. Forecast is only meaningful for the current month view.
  const forecastWindow = useMemo(() => {
    const months: string[] = [];
    for (let i = 6; i >= 1; i -= 1) months.push(addMonths(currentMonth, -i));
    return months;
  }, [currentMonth]);
  const forecastAvailable = mainPeriod === currentMonth && Boolean(displayCurrency);
  const forecastWanted = forecastAvailable && (budgetMode || activeTab === "forecast");

  // Fetch the detection window (per-month, to dodge the 500-row LIMIT) only
  // while the forecast is on screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!forecastWanted) {
        setHistoryTxs(null);
        return;
      }
      try {
        const monthly = await Promise.all(
          forecastWindow.map((m) =>
            requestJson<{ transactions: Transaction[] }>(
              `/api/transactions?from=${m}-01&to=${monthEnd(m)}&limit=500`
            )
          )
        );
        if (!cancelled) setHistoryTxs(monthly.flatMap((r) => r.transactions));
      } catch {
        if (!cancelled) setHistoryTxs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `accounts` reloads after any mutation — refetch the window so an edit to a
    // prior-month bill re-runs recurrence detection.
  }, [forecastWanted, forecastWindow, accounts]);

  // The forecast itself. All amounts converted to the display currency at the
  // single period rate (same approximation the rest of the view uses).
  const forecastResult = useMemo<ForecastResult | null>(() => {
    if (!forecastWanted || !periodRates || historyTxs === null) return null;
    const rates = periodRates;
    const toFx = (list: Transaction[]): ForecastTx[] => {
      const out: ForecastTx[] = [];
      for (const t of list) {
        let cents: number | null;
        if (t.accountCurrency === displayCurrency) cents = t.amountCents;
        else {
          const rTo = rates[displayCurrency];
          const rFrom = rates[t.accountCurrency];
          cents = rTo != null && rFrom != null ? Math.round((t.amountCents * rTo) / rFrom) : null;
        }
        if (cents === null) continue;
        out.push({
          date: t.date,
          cents,
          category: t.category,
          description: t.description,
          payee: t.payee,
          isTransfer: Boolean(t.transferGroup),
        });
      }
      return out;
    };
    return forecastMonth({
      windowTxs: toFx(historyTxs),
      windowMonths: forecastWindow,
      currentTxs: toFx(periodTransactions),
      currentMonth,
      today: today(),
      goalCents: Math.round(forecastGoal * 100),
      currentBalanceCents: panelConverted.cents,
      manualExpectedIncomeCents: Math.round(forecastIncome * 100),
      excludeKeys: excludedCommitted,
    });
  }, [
    forecastWanted,
    periodRates,
    historyTxs,
    forecastWindow,
    periodTransactions,
    currentMonth,
    forecastGoal,
    forecastIncome,
    excludedCommitted,
    panelConverted,
    displayCurrency,
  ]);
  // The overlay (card + day tints) shows only with the toggle on.
  const budgetOverlay = budgetMode && forecastResult !== null ? forecastResult : null;

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
  // instead of a per-row column. When both legs of a transfer are loaded they
  // collapse into a single «A → B» row at the newer leg's position; a leg
  // whose partner is filtered out (other account/period) stays a lone row
  // with a «перемещение» badge.
  const dayGroups = useMemo(() => {
    const legsByGroup = new Map<string, Transaction[]>();
    for (const tx of transactions) {
      if (!tx.transferGroup) continue;
      const legs = legsByGroup.get(tx.transferGroup) ?? [];
      legs.push(tx);
      legsByGroup.set(tx.transferGroup, legs);
    }
    const placed = new Set<string>();
    const groups: { date: string; items: DisplayRow[] }[] = [];
    for (const tx of transactions) {
      let row: DisplayRow | null = null;
      if (tx.transferGroup) {
        if (placed.has(tx.transferGroup)) continue;
        const partner = (legsByGroup.get(tx.transferGroup) ?? []).find(
          (leg) => leg.id !== tx.id
        );
        if (partner) {
          placed.add(tx.transferGroup);
          const out = tx.amountCents < 0 ? tx : partner;
          const incoming = tx.amountCents < 0 ? partner : tx;
          row = { kind: "transfer", out, incoming };
        }
      }
      if (!row) row = { kind: "tx", tx };
      const last = groups[groups.length - 1];
      if (last && last.date === tx.date) last.items.push(row);
      else groups.push({ date: tx.date, items: [row] });
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
  // Conversion uses the single view rate (periodRates), so rows reconcile
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
      return <Flagged reason={`Нет курса ${account} на ${dmy(periodRateDate)}`}>—</Flagged>;
    }
    return <Money cents={Math.round((cents * rateTo) / rateFrom)} currency={displayCurrency} />;
  };

  // Per-account balance for the "Счета" panel, in the display currency. Balances
  // are signed (an account can go negative). Uses panelRates — the current
  // month's 1st for the current period, the period end for a past one — so the
  // rows always reconcile with the panel total.
  const renderAccountBalance = (account: Account): ReactNode => {
    const cents = account.balanceCents;
    const code = account.currency;
    if (!displayCurrency || code === displayCurrency) {
      return <Money cents={cents} currency={code} />;
    }
    if (panelRates === null) return "…";
    const rateTo = panelRates[displayCurrency];
    const rateFrom = panelRates[code];
    if (rateTo == null || rateFrom == null) {
      return <Flagged reason={`Нет курса ${code} на ${dmy(panelRateDate)}`}>—</Flagged>;
    }
    return <Money cents={Math.round((cents * rateTo) / rateFrom)} currency={displayCurrency} />;
  };

  // Easter-egg popup on the native-currency figure: just the exact rate it
  // converts at. Plain text line; empty string = nothing to show.
  const rateInfo = (code: string): string => {
    if (!displayCurrency || periodRates === null) return "";
    const rateTo = periodRates[displayCurrency];
    const rateFrom = periodRates[code];
    if (rateTo == null || rateFrom == null) {
      return `нет курса ${code}`;
    }
    const rate = (rateTo / rateFrom).toLocaleString("ru-RU", {
      maximumSignificantDigits: 5,
    });
    return `1 ${code} = ${rate} ${displayCurrency}`;
  };

  // Per-account SPENDING over the loaded period, per currency. Transfer legs
  // are excluded — the «Траты» column tracks real spending only, so its total
  // matches the «Расходы периода» card.
  const accountSpend = useMemo(() => {
    const map = new Map<number, Record<string, number>>();
    for (const tx of periodTransactions) {
      if (tx.amountCents >= 0 || tx.transferGroup) continue;
      const totals = map.get(tx.accountId) ?? {};
      totals[tx.accountCurrency] =
        (totals[tx.accountCurrency] ?? 0) + Math.abs(tx.amountCents);
      map.set(tx.accountId, totals);
    }
    return map;
  }, [periodTransactions]);

  // A «Траты» cell of the panel: the spend converted at the view rate; muted
  // dash when the account had no spending in the period.
  const renderFlowCell = (totals: Record<string, number> | undefined): ReactNode => {
    if (!totals || Object.keys(totals).length === 0) {
      return <span className="flowZero">—</span>;
    }
    if (!displayCurrency || periodRates === null) return "…";
    const conv = convertTotals(totals, periodRates, displayCurrency);
    if (conv.missing.length > 0) {
      return (
        <Flagged reason={`Нет курса ${conv.missing.join(", ")} на ${dmy(periodRateDate)}`}>
          —
        </Flagged>
      );
    }
    return <Money cents={conv.cents} currency={displayCurrency} />;
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
      if (!editingTransactionId && transactionForm.direction === "transfer") {
        // Add mode: create both linked legs in one atomic server call.
        await requestJson("/api/transfers", {
          method: "POST",
          body: JSON.stringify({
            create: {
              fromAccountId: transactionForm.accountId,
              toAccountId: transactionForm.toAccountId,
              date: transactionForm.date,
              amount: transactionForm.amount,
              amountIn: transactionForm.amountIn,
              description: transactionForm.description,
            },
          }),
        });
        setNotice("Перевод добавлен");
      } else if (
        editingTransactionId &&
        transactionForm.direction === "transfer" &&
        !editingTransaction?.transferGroup
      ) {
        // Link mode: the edited operation plus the chosen opposite-sign
        // partner become one «Перемещение».
        const partner = partnerCandidates?.find(
          (cand) => String(cand.id) === partnerId
        );
        if (!editingTransaction || !partner) {
          setNotice("Выберите операцию-напарника");
          return;
        }
        const outId =
          editingTransaction.amountCents < 0 ? editingTransaction.id : partner.id;
        const inId =
          editingTransaction.amountCents < 0 ? partner.id : editingTransaction.id;
        await requestJson("/api/transfers", {
          method: "POST",
          body: JSON.stringify({ outId, inId }),
        });
        setNotice("Операции связаны в перемещение");
      } else {
        const method = editingTransactionId ? "PATCH" : "POST";
        const url = editingTransactionId
          ? `/api/transactions?id=${editingTransactionId}`
          : "/api/transactions";
        // For a leg that STAYS a transfer only date/description are editable —
        // amount/category fields are hidden and the account is locked.
        const body =
          transactionForm.direction === "transfer"
            ? {
                date: transactionForm.date,
                description: transactionForm.description,
                notes: transactionForm.notes,
                flagged: transactionForm.flagged,
              }
            : transactionForm;
        await requestJson(url, { method, body: JSON.stringify(body) });
        // A linked leg switched back to Расход/Поступление: split the pair
        // AFTER the field edits landed — a failed PATCH (e.g. bad amount)
        // must not silently destroy the transfer.
        if (
          editingTransaction?.transferGroup &&
          transactionForm.direction !== "transfer"
        ) {
          await requestJson(
            `/api/transfers?group=${encodeURIComponent(editingTransaction.transferGroup)}`,
            { method: "DELETE" }
          );
        }
        setNotice(editingTransactionId ? "Операция обновлена" : "Операция добавлена");
      }
      setEditingTransactionId(null);
      setFormOpen(false);
      setTransactionForm({
        accountId: "",
        date: today(),
        direction: "expense",
        amount: "",
        description: "",
        category: "",
        toAccountId: "",
        amountIn: "",
        flagged: false,
        notes: "",
      });
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Операция не сохранена");
      // A multi-step save (PATCH + unlink) can fail half-way — resync the
      // list with the DB instead of showing stale merged rows.
      await refreshAfterMutation();
    } finally {
      setSaving(false);
    }
  }

  function openAddTransaction() {
    setEditingTransactionId(null);
    setTransactionForm({
      accountId: "",
      date: today(),
      direction: "expense",
      amount: "",
      description: "",
      category: "",
      toAccountId: "",
      amountIn: "",
      flagged: false,
      notes: "",
    });
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingTransactionId(null);
    setTransactionForm({
      accountId: "",
      date: today(),
      direction: "expense",
      amount: "",
      description: "",
      category: "",
      toAccountId: "",
      amountIn: "",
      flagged: false,
      notes: "",
    });
  }

  function startEditTransaction(transaction: Transaction) {
    setEditingTransactionId(transaction.id);
    setTransactionForm({
      accountId: String(transaction.accountId),
      date: transaction.date,
      direction: transaction.transferGroup
        ? "transfer"
        : transaction.amountCents < 0
          ? "expense"
          : "income",
      amount: centsToInputValue(Math.abs(transaction.amountCents)),
      description: transaction.description,
      category: transaction.category,
      toAccountId: "",
      amountIn: "",
      flagged: transaction.flagged,
      notes: transaction.notes,
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

  // Split a «Перемещение» back into two ordinary operations (their categories
  // stay empty — re-categorize by hand or with rules).
  async function unlinkTransfer(group: string) {
    if (!window.confirm("Разъединить перемещение на две обычные операции?")) return;
    try {
      await requestJson(`/api/transfers?group=${encodeURIComponent(group)}`, {
        method: "DELETE",
      });
      setNotice("Перемещение разъединено");
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось разъединить");
    }
  }

  // Create the missing partner right from the picker and link the pair in one
  // go: the new operation gets the OPPOSITE sign of the edited one.
  async function createAndLinkPartner() {
    const tx = editingTransaction;
    if (!tx || !partnerCreate.accountId || !partnerCreate.amount) return;
    setSaving(true);
    try {
      const created = await requestJson<{ transaction: Transaction }>("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          accountId: partnerCreate.accountId,
          date: partnerCreate.date,
          amount: partnerCreate.amount,
          direction: tx.amountCents < 0 ? "income" : "expense",
          description: tx.description || "Перевод",
        }),
      });
      const partner = created.transaction;
      const outId = tx.amountCents < 0 ? tx.id : partner.id;
      const inId = tx.amountCents < 0 ? partner.id : tx.id;
      await requestJson("/api/transfers", {
        method: "POST",
        body: JSON.stringify({ outId, inId }),
      });
      setNotice("Операция создана и связана в перемещение");
      closeForm();
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось создать напарника");
      await refreshAfterMutation();
    } finally {
      setSaving(false);
    }
  }

  // «Найти переводы»: fetch conservative same-amount pair candidates and let
  // the user confirm which to link.
  async function openDetectTransfers() {
    setSaving(true);
    try {
      const data = await requestJson<{ pairs: DetectPair[] }>("/api/transfers/detect");
      setDetectPairs(data.pairs);
      setDetectChecked(new Set(data.pairs.map((_, index) => index)));
      setDetectOpen(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Поиск переводов не удался");
    } finally {
      setSaving(false);
    }
  }

  function toggleDetect(index: number) {
    setDetectChecked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function linkDetected() {
    const pairs = (detectPairs ?? [])
      .filter((_, index) => detectChecked.has(index))
      .map((pair) => ({ outId: pair.out.id, inId: pair.incoming.id }));
    if (pairs.length === 0) {
      setDetectOpen(false);
      return;
    }
    setSaving(true);
    try {
      // Chunked: the server caps one batch at 200 pairs, and a multi-year
      // history can detect more than that. Per-pair failures are surfaced,
      // not swallowed.
      let linked = 0;
      const reasons: string[] = [];
      for (let offset = 0; offset < pairs.length; offset += 100) {
        const result = await requestJson<{
          linked: number;
          errors: Array<{ reason: string }>;
        }>("/api/transfers", {
          method: "POST",
          body: JSON.stringify({ pairs: pairs.slice(offset, offset + 100) }),
        });
        linked += result.linked;
        for (const err of result.errors ?? []) reasons.push(err.reason);
      }
      setNotice(
        `Связано перемещений: ${linked}` +
          (reasons.length > 0
            ? `, пропущено ${reasons.length}: ${[...new Set(reasons)].join(", ")}`
            : "")
      );
      setDetectOpen(false);
      setDetectPairs(null);
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось связать");
      await refreshAfterMutation();
    } finally {
      setSaving(false);
    }
  }

  // --- manual ordering (Настройки, drag-and-drop) -------------------------
  const [dragAccountId, setDragAccountId] = useState<number | null>(null);
  const [dragCategoryId, setDragCategoryId] = useState<number | null>(null);

  function movedList<T extends { id: number }>(list: T[], draggedId: number, targetId: number): T[] {
    const fromIndex = list.findIndex((item) => item.id === draggedId);
    const toIndex = list.findIndex((item) => item.id === targetId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return list;
    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  }

  // Optimistic: the list reorders immediately, the server persists indices;
  // on failure the lists reload from the DB. The order drives every account/
  // category dropdown and the «Счета» panel.
  async function persistOrder(kind: "accounts" | "categories", ids: number[]) {
    try {
      await requestJson(`/api/${kind}/reorder`, {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить порядок");
      await reloadMeta();
    }
  }

  function dropAccount(targetId: number) {
    if (dragAccountId === null || dragAccountId === targetId) return;
    const next = movedList(accounts, dragAccountId, targetId);
    setAccounts(next);
    setDragAccountId(null);
    void persistOrder("accounts", next.map((account) => account.id));
  }

  function dropCategory(targetId: number) {
    if (dragCategoryId === null || dragCategoryId === targetId) return;
    const next = movedList(categories, dragCategoryId, targetId);
    setCategories(next);
    setDragCategoryId(null);
    void persistOrder("categories", next.map((category) => category.id));
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
      // New accounts default to «открыт сегодня» — so a March-created account
      // does not leak its opening balance into January's history.
      openedAt: today(),
      closedAt: "",
    });
  }

  function openAddAccount() {
    resetAccountForm();
    setAccountModalOpen(true);
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
      openedAt: account.openedAt ?? "",
      closedAt: account.closedAt ?? "",
    });
    setAccountModalOpen(true);
  }

  function closeAccountModal() {
    setAccountModalOpen(false);
    resetAccountForm();
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
      closeAccountModal();
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

  function openAddCategory() {
    setEditingCategoryId(null);
    setCategoryForm({ name: "", color: palette[(categories.length + 1) % palette.length] });
    setCategoryModalOpen(true);
  }

  function startEditCategory(category: Category) {
    setEditingCategoryId(category.id);
    setCategoryForm({ name: category.name, color: category.color });
    setCategoryModalOpen(true);
  }

  function closeCategoryModal() {
    setCategoryModalOpen(false);
    setEditingCategoryId(null);
  }

  async function handleSubmitCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      if (editingCategoryId !== null) {
        await requestJson("/api/categories", {
          method: "PATCH",
          body: JSON.stringify({ id: editingCategoryId, ...categoryForm }),
        });
        setNotice("Категория обновлена");
      } else {
        await requestJson("/api/categories", { method: "POST", body: JSON.stringify(categoryForm) });
        setNotice("Категория добавлена");
      }
      closeCategoryModal();
      await loadCategories();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Категория не сохранена");
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

  function openAddRule() {
    setEditingRuleId(null);
    setRuleForm({ pattern: "", category: "" });
    setRuleModalOpen(true);
  }

  function startEditRule(rule: Rule) {
    setEditingRuleId(rule.id);
    setRuleForm({ pattern: rule.pattern, category: rule.category });
    setRuleModalOpen(true);
  }

  function closeRuleModal() {
    setRuleModalOpen(false);
    setEditingRuleId(null);
  }

  async function handleSubmitRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      if (editingRuleId !== null) {
        await requestJson("/api/rules", {
          method: "PATCH",
          body: JSON.stringify({ id: editingRuleId, ...ruleForm }),
        });
        setNotice("Правило обновлено");
      } else {
        await requestJson("/api/rules", { method: "POST", body: JSON.stringify(ruleForm) });
        setNotice("Правило добавлено");
      }
      closeRuleModal();
      await Promise.all([loadRules(), loadCategories()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Правило не сохранено");
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

  function openAddCurrency() {
    setEditingCurrencyCode(null);
    setCurrencyForm({ code: "", name: "", symbol: "" });
    setCurrencyModalOpen(true);
  }

  function startEditCurrency(currency: Currency) {
    setEditingCurrencyCode(currency.code);
    setCurrencyForm({ code: currency.code, name: currency.name, symbol: currency.symbol });
    setCurrencyModalOpen(true);
  }

  function closeCurrencyModal() {
    setCurrencyModalOpen(false);
    setEditingCurrencyCode(null);
  }

  async function handleSubmitCurrency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      if (editingCurrencyCode !== null) {
        await requestJson("/api/currencies", { method: "PATCH", body: JSON.stringify(currencyForm) });
        setNotice("Валюта обновлена");
      } else {
        await requestJson("/api/currencies", { method: "POST", body: JSON.stringify(currencyForm) });
        setNotice("Валюта добавлена");
      }
      closeCurrencyModal();
      await loadCurrencies();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Валюта не сохранена");
    } finally {
      setSaving(false);
    }
  }

  async function removeCurrency(currency: Currency) {
    if (!window.confirm(`Удалить валюту ${currency.code}?`)) return;
    try {
      await requestJson(`/api/currencies?code=${encodeURIComponent(currency.code)}`, { method: "DELETE" });
      setNotice("Валюта удалена");
      await loadCurrencies();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Валюта не удалена");
    }
  }

  async function applyRules(overwrite: boolean) {
    setSaving(true);
    try {
      const result = await requestJson<{ updated: number }>(
        `/api/rules/apply${overwrite ? "?overwrite=1" : ""}`,
        { method: "POST" }
      );
      setNotice(`Категории проставлены: ${result.updated}`);
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось применить правила");
    } finally {
      setSaving(false);
    }
  }

  // Apply ONE rule to every operation (overwriting categories where its
  // pattern matches) — точечная переразметка without re-running all rules.
  async function applyOneRule(rule: Rule) {
    if (
      !window.confirm(
        `Применить правило «${rule.pattern}» → «${rule.category}» ко всем операциям? ` +
          "Категория будет перезаписана везде, где совпадает шаблон."
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      const result = await requestJson<{ updated: number }>(
        `/api/rules/apply?ruleId=${rule.id}`,
        { method: "POST" }
      );
      setNotice(`Правило применено, обновлено операций: ${result.updated}`);
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось применить правило");
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
              <span>Баланс на начало периода</span>
              <strong>
                {startTotals === null
                  ? "…"
                  : renderConverted(startConverted, periodRates, periodRateDate)}
              </strong>
            </article>
            <article className="metric">
              <span>Поступления периода</span>
              <strong>{renderConverted(incomeConverted, periodRates, periodRateDate)}</strong>
            </article>
            <article className="metric">
              <span>Расходы периода</span>
              <strong>{renderConverted(expenseConverted, periodRates, periodRateDate)}</strong>
            </article>
            <article className="metric">
              {/* Past months: total as it stood at the period's end, at the
                  period-end rate (same numbers as the «Счета» panel total).
                  The current month simply shows the live total. */}
              <span>{pastPeriod ? "Баланс на конец периода" : "Текущий баланс"}</span>
              <strong>
                {pastPeriod && endAccounts === null
                  ? "…"
                  : renderConverted(panelConverted, panelRates, panelRateDate)}
              </strong>
            </article>
          </section>

          <div className="workspace twoCol">
            <section className="mainColumn">
              <section className="surface">
                {/* Title lifted above the toolbar; the period picker takes the
                    title's old spot (left), and the primary action sits where
                    the picker used to be (top-right). */}
                <h2 className="opsTitle">Операции</h2>
                <div className="opsToolbar">
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
                  <label className="filterField">
                    Поиск
                    <input
                      placeholder="Описание, категория, счёт…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                  <label className="filterField">
                    Счёт
                    <select
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
                  </label>
                  <label className="filterField">
                    Категория
                    <select
                      value={categoryFilter}
                      onChange={(event) => setCategoryFilter(event.target.value)}
                    >
                      <option value="">Все категории</option>
                      <option value="Без категории">Без категории</option>
                      {categoryFilterOptions.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="filterField">
                    Тип операции
                    <select
                      value={typeFilter}
                      onChange={(event) => setTypeFilter(event.target.value)}
                    >
                      <option value="all">Все</option>
                      <option value="expense">Расходы</option>
                      <option value="income">Поступления</option>
                      <option value="transfer">Перемещения</option>
                    </select>
                  </label>
                  <button
                    className={`secondaryButton flagToggle ${flaggedOnly ? "on" : ""}`}
                    type="button"
                    aria-pressed={flaggedOnly}
                    onClick={() => setFlaggedOnly((current) => !current)}
                    title="Показать только операции с пометкой «Требует внимания»"
                  >
                    ⚠️
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={saving}
                    onClick={() => void openDetectTransfers()}
                    title="Найти пары расход+поступление, похожие на переводы между счетами"
                  >
                    Найти переводы
                  </button>
                  <button
                    className={`secondaryButton budgetToggle ${budgetMode ? "on" : ""}`}
                    type="button"
                    aria-pressed={budgetMode}
                    disabled={!forecastAvailable}
                    onClick={() => setBudgetMode((current) => !current)}
                    title={
                      forecastAvailable
                        ? "Режим бюджета: дневной таргет и раскраска дней"
                        : "Бюджет доступен только для текущего месяца с выбранной валютой отображения"
                    }
                  >
                    ◎ Бюджет
                  </button>
                </div>
                </div>

                <div className="tableWrap">
                  <table className="opsTable">
                    <thead>
                      <tr>
                        <th className="markCol" aria-label="Пометки" />
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
                          <td colSpan={7} className="emptyTable">
                            {loading ? "Загрузка" : "Нет операций за период"}
                          </td>
                        </tr>
                      ) : (
                        dayGroups.map((group) => {
                          // Budget-mode day tint: discretionary spend of the day
                          // (whole-month figure, filter-independent) vs the flat
                          // daily allowance. Only past+today; future days stay plain.
                          const dayDisc = budgetOverlay
                            ? budgetOverlay.perDayDiscretionaryCents[group.date] ?? 0
                            : 0;
                          const tinted = Boolean(budgetOverlay) && group.date <= today();
                          const over = tinted && dayDisc > Math.max(0, budgetOverlay!.dailyAllowanceCents);
                          return (
                          <Fragment key={group.date}>
                            <tr className={`dayGroup ${tinted ? (over ? "overBudget" : "underBudget") : ""}`}>
                              <td colSpan={7}>
                                <span>{formatDayHeader(group.date)}</span>
                                {tinted ? (
                                  <span className={`dayBudget ${over ? "over" : "under"}`}>
                                    {over ? "⚠" : "✓"}{" "}
                                    <Money cents={dayDisc} currency={displayCurrency} />
                                    {" / "}
                                    <Money cents={budgetOverlay!.dailyAllowanceCents} currency={displayCurrency} />
                                  </span>
                                ) : null}
                              </td>
                            </tr>
                            {group.items.map((row) =>
                              row.kind === "transfer" ? (
                                <tr key={`transfer-${row.out.transferGroup}`} className="transferRow">
                                  <td className="markCol">
                                    <span className="markTransfer" data-tip="Перемещение между счетами">⇄</span>
                                    {row.out.flagged || row.incoming.flagged ? (
                                      <span
                                        className="markFlag"
                                        data-tip={row.out.notes || row.incoming.notes || "Требует внимания"}
                                      >
                                        ⚠️
                                      </span>
                                    ) : null}
                                  </td>
                                  <td>
                                    <ClampedName
                                      text={`${row.out.accountName} → ${row.incoming.accountName}`}
                                    />
                                  </td>
                                  <td>{row.out.description}</td>
                                  <td>—</td>
                                  <td className="amountCell">{renderDisplayAmount(row.out)}</td>
                                  <td className="amountCell">
                                    <span className="altAmount">
                                      {row.out.accountCurrency === row.incoming.accountCurrency ? (
                                        renderAccountAmount(row.out)
                                      ) : (
                                        <>
                                          <Money
                                            cents={Math.abs(row.out.amountCents)}
                                            currency={row.out.accountCurrency}
                                          />
                                          {" → "}
                                          <Money
                                            cents={Math.abs(row.incoming.amountCents)}
                                            currency={row.incoming.accountCurrency}
                                          />
                                        </>
                                      )}
                                    </span>
                                  </td>
                                  <td className="rowActions">
                                    <span className="rowMenuWrap">
                                      <button
                                        className="iconButton small"
                                        type="button"
                                        aria-label="Действия"
                                        aria-haspopup="menu"
                                        aria-expanded={rowMenu === `transfer-${row.out.transferGroup}`}
                                        onClick={(event) => {
                                          const rect = event.currentTarget.getBoundingClientRect();
                                          setRowMenuUp(window.innerHeight - rect.bottom < 140);
                                          setRowMenuPos({
                                            right: Math.max(8, window.innerWidth - rect.right),
                                            top: rect.bottom + 4,
                                            bottom: window.innerHeight - rect.top + 4,
                                          });
                                          setRowMenu((current) =>
                                            current === `transfer-${row.out.transferGroup}`
                                              ? null
                                              : `transfer-${row.out.transferGroup}`
                                          );
                                        }}
                                      >
                                        ⋮
                                      </button>
                                      {rowMenu === `transfer-${row.out.transferGroup}` ? (
                                        <span
                                          className={`rowMenu ${rowMenuUp ? "up" : ""}`}
                                          role="menu"
                                          style={
                                            rowMenuUp
                                              ? { right: rowMenuPos?.right, bottom: rowMenuPos?.bottom }
                                              : { right: rowMenuPos?.right, top: rowMenuPos?.top }
                                          }
                                        >
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setRowMenu(null);
                                              startEditTransaction(row.out);
                                            }}
                                          >
                                            Править
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setRowMenu(null);
                                              void unlinkTransfer(row.out.transferGroup ?? "");
                                            }}
                                          >
                                            Разъединить
                                          </button>
                                        </span>
                                      ) : null}
                                    </span>
                                  </td>
                                </tr>
                              ) : (
                                <tr key={row.tx.id}>
                                  <td className="markCol">
                                    {row.tx.transferGroup ? (
                                      <span className="markTransfer" data-tip="Перемещение между счетами (второе плечо вне фильтра)">⇄</span>
                                    ) : null}
                                    {row.tx.flagged ? (
                                      <span className="markFlag" data-tip={row.tx.notes || "Требует внимания"}>⚠️</span>
                                    ) : null}
                                  </td>
                                  <td>
                                    <ClampedName text={row.tx.accountName} />
                                  </td>
                                  <td>{row.tx.description}</td>
                                  <td>{row.tx.category || "—"}</td>
                                  <td
                                    className={`amountCell ${
                                      row.tx.amountCents > 0 && !row.tx.transferGroup
                                        ? "positive"
                                        : ""
                                    }`}
                                  >
                                    {/* Expenses are plain black and shown without a
                                        leading minus; only income is coloured (green). */}
                                    {renderDisplayAmount(row.tx)}
                                  </td>
                                  <td className="amountCell">
                                    <span className="altAmount">{renderAccountAmount(row.tx)}</span>
                                  </td>
                                  <td className="rowActions">
                                    <span className="rowMenuWrap">
                                      <button
                                        className="iconButton small"
                                        type="button"
                                        aria-label="Действия"
                                        aria-haspopup="menu"
                                        aria-expanded={rowMenu === `tx-${row.tx.id}`}
                                        onClick={(event) => {
                                          const rect = event.currentTarget.getBoundingClientRect();
                                          setRowMenuUp(window.innerHeight - rect.bottom < 140);
                                          setRowMenuPos({
                                            right: Math.max(8, window.innerWidth - rect.right),
                                            top: rect.bottom + 4,
                                            bottom: window.innerHeight - rect.top + 4,
                                          });
                                          setRowMenu((current) =>
                                            current === `tx-${row.tx.id}` ? null : `tx-${row.tx.id}`
                                          );
                                        }}
                                      >
                                        ⋮
                                      </button>
                                      {rowMenu === `tx-${row.tx.id}` ? (
                                        <span
                                          className={`rowMenu ${rowMenuUp ? "up" : ""}`}
                                          role="menu"
                                          style={
                                            rowMenuUp
                                              ? { right: rowMenuPos?.right, bottom: rowMenuPos?.bottom }
                                              : { right: rowMenuPos?.right, top: rowMenuPos?.top }
                                          }
                                        >
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setRowMenu(null);
                                              startEditTransaction(row.tx);
                                            }}
                                          >
                                            Править
                                          </button>
                                          <button
                                            type="button"
                                            className="danger"
                                            onClick={() => {
                                              setRowMenu(null);
                                              void removeTransaction(row.tx);
                                            }}
                                          >
                                            Удалить
                                          </button>
                                        </span>
                                      ) : null}
                                    </span>
                                  </td>
                                </tr>
                              )
                            )}
                          </Fragment>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </section>

            <aside className="rightRail">
            {budgetOverlay ? (
              <section className="surface forecastPanel" aria-label="Прогноз">
                <h2>Прогноз</h2>
                {!budgetOverlay.feasible ? (
                  <p className="forecastWarn">
                    Цель недостижима: не хватает{" "}
                    <Money cents={budgetOverlay.shortfallCents} currency={displayCurrency} />
                  </p>
                ) : null}
                <div className="forecastTarget">
                  <span className="forecastTargetLabel">Таргет на день</span>
                  <span className="forecastTargetValue">
                    <Money cents={budgetOverlay.rollingTargetCents} currency={displayCurrency} />
                  </span>
                </div>
                <p className={`forecastToday ${budgetOverlay.remainingTodayCents < 0 ? "over" : "under"}`}>
                  Сегодня ещё можно{" "}
                  <b>
                    <Money cents={budgetOverlay.remainingTodayCents} currency={displayCurrency} />
                  </b>
                  <span className="forecastMuted">
                    {" "}
                    · потрачено <Money cents={budgetOverlay.todayDiscretionaryCents} currency={displayCurrency} />
                  </span>
                </p>
                <table className="forecastMini">
                  <tbody>
                    <tr>
                      <td>Доход (месяц)</td>
                      <td><Money cents={budgetOverlay.expectedIncomeCents} currency={displayCurrency} /></td>
                    </tr>
                    <tr>
                      <td>− Обязательные</td>
                      <td><Money cents={budgetOverlay.committedTotalCents} currency={displayCurrency} /></td>
                    </tr>
                    <tr className="forecastGoalRow">
                      <td>− Отложить</td>
                      <td>
                        <span className="goalInput">
                          <input
                            type="number"
                            min={0}
                            step={100}
                            value={forecastGoal}
                            onChange={(event) =>
                              setForecastGoal(Math.max(0, Number(event.target.value) || 0))
                            }
                          />
                          {displayCurrency}
                        </span>
                      </td>
                    </tr>
                    <tr className="forecastBudgetRow">
                      <td>= Свободно</td>
                      <td><Money cents={budgetOverlay.discretionaryBudgetCents} currency={displayCurrency} /></td>
                    </tr>
                  </tbody>
                </table>
                <p className="panelNote">
                  Ровный лимит <Money cents={budgetOverlay.dailyAllowanceCents} currency={displayCurrency} />/день красит дни.
                  Прогноз на {dmy(monthEnd(mainPeriod))}:{" "}
                  <Money cents={budgetOverlay.projectedEndCents} currency={displayCurrency} />
                </p>
              </section>
            ) : null}
            <section className="surface accountsPanel" aria-label="Баланс по счетам">
              <h2>Счета</h2>
              {pastPeriod ? (
                <p className="panelNote">
                  Остатки на {dmy(monthEnd(mainPeriod))}
                </p>
              ) : null}
              <table className="balanceTable">
                <thead>
                  <tr className="balHead">
                    <th />
                    <th>Остаток</th>
                    <th>В валюте счёта</th>
                    <th>Траты</th>
                  </tr>
                </thead>
                <tbody>
                  {panelAccounts.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="emptyTable">
                        {pastPeriod && endAccounts === null ? "Загрузка" : "Нет счетов"}
                      </td>
                    </tr>
                  ) : (
                    panelAccounts.map((account) => (
                      <tr key={account.id}>
                        <td className="balName">{account.name}</td>
                        <td className="amountCell">{renderAccountBalance(account)}</td>
                        <td className="amountCell">
                          {/* Easter egg: hovering the native figure reveals the
                              exact conversion rate. */}
                          <span className="ratesPeek">
                            <span className="altAmount">
                              {displayCurrency && account.currency !== displayCurrency ? (
                                <Money
                                  cents={account.balanceCents}
                                  currency={account.currency}
                                />
                              ) : (
                                "—"
                              )}
                            </span>
                            {displayCurrency &&
                            account.currency !== displayCurrency &&
                            rateInfo(account.currency) ? (
                              <span className="ratesPop">{rateInfo(account.currency)}</span>
                            ) : null}
                          </span>
                        </td>
                        <td className="amountCell flowCell">
                          {renderFlowCell(accountSpend.get(account.id))}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {panelAccounts.length > 0 ? (
                  <tfoot>
                    <tr className="balTotal">
                      <td>Итого</td>
                      <td className="amountCell">
                        {renderConverted(panelConverted, panelRates, panelRateDate)}
                      </td>
                      <td />
                      <td className="amountCell flowCell">
                        {renderFlowCell(periodExpense)}
                      </td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </section>

            <section className="surface categoryPanel" aria-label="Расходы по категориям">
              <h2>Расходы по категориям</h2>
              {categoryBars.missing.length > 0 ? (
                <p className="panelNote">
                  <Flagged
                    reason={`Без учёта ${categoryBars.missing.join(", ")} — нет курса на ${dmy(periodRateDate)}`}
                  >
                    учтены не все валюты
                  </Flagged>
                </p>
              ) : null}
              {periodRates === null ? (
                <div className="emptyBars">…</div>
              ) : (
                <CategoryBars
                  items={categoryBars.items}
                  uncategorized={categoryBars.uncategorized}
                  currency={displayCurrency}
                />
              )}
            </section>

            </aside>
          </div>

          {detectOpen ? (
            <div
              className="modalOverlay"
              role="dialog"
              aria-modal="true"
              aria-label="Найденные переводы"
              onClick={() => setDetectOpen(false)}
            >
              <div className="modalCard" onClick={(event) => event.stopPropagation()}>
                <div className="modalHead">
                  <h2>
                    Похоже на переводы{" "}
                    <span className="countBadge">{detectPairs?.length ?? 0}</span>
                  </h2>
                  <button
                    className="iconButton small"
                    type="button"
                    onClick={() => setDetectOpen(false)}
                    title="Закрыть"
                  >
                    ×
                  </button>
                </div>
                <p className="importHint">
                  Пары «расход + поступление» с одинаковой суммой и валютой на разных
                  счетах в пределах трёх дней. Отмеченные станут перемещениями и
                  перестанут учитываться в доходах, расходах и категориях.
                </p>
                {(detectPairs ?? []).length === 0 ? (
                  <p className="mutedBlock">Ничего похожего на переводы не нашлось.</p>
                ) : (
                  <ul className="partnerList detectList">
                    {(detectPairs ?? []).map((pair, index) => (
                      <li key={pair.out.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={detectChecked.has(index)}
                            onChange={() => toggleDetect(index)}
                          />
                          <span className="partnerMain">
                            <b>
                              {pair.out.accountName} → {pair.incoming.accountName}
                            </b>
                            <small>
                              {dmy(pair.out.date)}
                              {pair.incoming.date !== pair.out.date
                                ? ` → ${dmy(pair.incoming.date)}`
                                : ""}{" "}
                              · {pair.out.description || "—"}
                            </small>
                          </span>
                          <span className="partnerAmount">
                            <Money
                              cents={Math.abs(pair.out.amountCents)}
                              currency={pair.out.currency}
                            />
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {(detectPairs ?? []).length > 0 ? (
                  <div className="applyRow">
                    <button
                      className="primaryButton"
                      type="button"
                      disabled={saving || detectChecked.size === 0}
                      onClick={() => void linkDetected()}
                    >
                      Связать выбранные ({detectChecked.size})
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

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

                {/* Two-column grid; the field set and pairing follow the type:
                    ordinary — [Тип|Счёт][Дата|Сумма][Описание][Категория],
                    transfer — [Тип|Дата][Со счёта|На счёт][Сумма|Зачислено]. */}
                <form className="transactionForm" onSubmit={handleSubmitTransaction}>
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
                      {/* Add mode creates a new linked pair; edit mode links
                          two EXISTING operations (e.g. imported statements). */}
                      <option value="transfer">Перемещение между счетами</option>
                    </select>
                  </label>
                  {transactionForm.direction === "transfer" && !editingTransactionId ? (
                    <>
                      <label>
                        Дата
                        <DateField
                          required
                          value={transactionForm.date}
                          onChange={(iso) => setTransactionForm({ ...transactionForm, date: iso })}
                        />
                      </label>
                      <label>
                        Со счёта
                        <select
                          required
                          disabled={accounts.length === 0}
                          value={transactionForm.accountId}
                          onChange={(event) =>
                            setTransactionForm({
                              ...transactionForm,
                              accountId: event.target.value,
                            })
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
                        На счёт
                        <select
                          required
                          value={transactionForm.toAccountId}
                          onChange={(event) =>
                            setTransactionForm({
                              ...transactionForm,
                              toAccountId: event.target.value,
                            })
                          }
                        >
                          <option value="">Выберите счет</option>
                          {accounts
                            .filter((account) => String(account.id) !== transactionForm.accountId)
                            .map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      {(() => {
                        const fromCurrency = accounts.find(
                          (account) => String(account.id) === transactionForm.accountId
                        )?.currency;
                        const toCurrency = accounts.find(
                          (account) => String(account.id) === transactionForm.toAccountId
                        )?.currency;
                        const crossCurrency = Boolean(
                          fromCurrency && toCurrency && fromCurrency !== toCurrency
                        );
                        return (
                          <>
                            <label>
                              Сумма{fromCurrency ? ` (${fromCurrency})` : ""}
                              <input
                                required
                                inputMode="decimal"
                                value={transactionForm.amount}
                                onChange={(event) =>
                                  setTransactionForm({
                                    ...transactionForm,
                                    amount: event.target.value,
                                  })
                                }
                              />
                            </label>
                            {/* Cross-currency: the user says how much actually
                                arrived — the app never invents an FX rate for
                                real money. */}
                            {crossCurrency ? (
                              <label>
                                Зачислено ({toCurrency})
                                <input
                                  required
                                  inputMode="decimal"
                                  value={transactionForm.amountIn}
                                  onChange={(event) =>
                                    setTransactionForm({
                                      ...transactionForm,
                                      amountIn: event.target.value,
                                    })
                                  }
                                />
                              </label>
                            ) : null}
                          </>
                        );
                      })()}
                      <label className="wideField">
                        Описание
                        <input
                          placeholder="Перевод между счетами"
                          value={transactionForm.description}
                          onChange={(event) =>
                            setTransactionForm({
                              ...transactionForm,
                              description: event.target.value,
                            })
                          }
                        />
                      </label>
                    </>
                  ) : transactionForm.direction === "transfer" ? (
                    <>
                      <label>
                        Дата
                        {/* Locked while PICKING a partner (linking does not
                            save field edits); editable on a linked leg. */}
                        <DateField
                          required
                          disabled={!editingTransaction?.transferGroup}
                          value={transactionForm.date}
                          onChange={(iso) => setTransactionForm({ ...transactionForm, date: iso })}
                        />
                      </label>
                      <label>
                        Счет
                        {/* Locked: linking never moves a leg to another
                            account, an edit here would be discarded. */}
                        <select required disabled value={transactionForm.accountId}>
                          <option value="">Выберите счет</option>
                          {accounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {editingTransaction?.transferGroup ? (
                        <>
                          <p className="importHint wideField">
                            Операция уже входит в перемещение: счёт и сумма фиксированы.
                            Разъединить — кнопкой ✂ в списке, или выберите тип
                            «Расход»/«Поступление» и сохраните.
                          </p>
                          <label className="wideField">
                            Описание
                            <input
                              value={transactionForm.description}
                              onChange={(event) =>
                                setTransactionForm({
                                  ...transactionForm,
                                  description: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label className="wideField">
                            Заметка
                            <input
                              placeholder="Почему помечено / что проверить"
                              value={transactionForm.notes}
                              onChange={(event) =>
                                setTransactionForm({ ...transactionForm, notes: event.target.value })
                              }
                            />
                          </label>
                          <label className="flagCheck wideField">
                            <input
                              type="checkbox"
                              checked={transactionForm.flagged}
                              onChange={(event) =>
                                setTransactionForm({
                                  ...transactionForm,
                                  flagged: event.target.checked,
                                })
                              }
                            />
                            ⚠️ Требует внимания
                          </label>
                        </>
                      ) : (
                        <div className="wideField partnerPicker">
                        <p className="importHint">
                          Выберите вторую операцию (другого знака, с другого счёта) —
                          вместе они станут перемещением и уйдут из доходов, расходов
                          и категорий. Кандидаты — в пределах ±7 дней; точные
                          совпадения по сумме показаны первыми.
                        </p>
                        {partnerCandidates === null ? (
                          <p className="mutedBlock">Загрузка…</p>
                        ) : partnerCandidates.length === 0 ? (
                          <p className="mutedBlock">
                            Подходящих операций не нашлось (±7 дней от даты)
                          </p>
                        ) : (
                          <ul className="partnerList">
                            {partnerCandidates.map((cand) => (
                              <li key={cand.id}>
                                <label>
                                  <input
                                    type="radio"
                                    name="transferPartner"
                                    value={cand.id}
                                    checked={partnerId === String(cand.id)}
                                    onChange={() => setPartnerId(String(cand.id))}
                                  />
                                  <span className="partnerMain">
                                    <b>{cand.accountName}</b>
                                    <small>
                                      {dmy(cand.date)} · {cand.description || "—"}
                                    </small>
                                  </span>
                                  <span
                                    className={`partnerAmount ${
                                      cand.amountCents > 0 ? "positive" : ""
                                    }`}
                                  >
                                    <Money
                                      cents={Math.abs(cand.amountCents)}
                                      currency={cand.accountCurrency}
                                    />
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        )}

                        {/* Missing counterpart? Create it right here and link
                            in one action instead of closing the modal. */}
                        <div className="partnerCreate">
                          {!partnerCreate.open ? (
                            <button
                              type="button"
                              className="textButton"
                              onClick={() =>
                                setPartnerCreate({
                                  open: true,
                                  accountId: "",
                                  amount: centsToInputValue(
                                    Math.abs(editingTransaction?.amountCents ?? 0)
                                  ),
                                  date: editingTransaction?.date ?? today(),
                                })
                              }
                            >
                              + Создать операцию-напарника
                            </button>
                          ) : (
                            <>
                              <p className="importHint">
                                Будет создано{" "}
                                {editingTransaction && editingTransaction.amountCents < 0
                                  ? "поступление"
                                  : "расход"}{" "}
                                и сразу связано с этой операцией.
                              </p>
                              <div className="partnerCreateGrid">
                                <label>
                                  Счёт
                                  <select
                                    value={partnerCreate.accountId}
                                    onChange={(event) =>
                                      setPartnerCreate({
                                        ...partnerCreate,
                                        accountId: event.target.value,
                                      })
                                    }
                                  >
                                    <option value="">Выберите счет</option>
                                    {accounts
                                      .filter(
                                        (account) =>
                                          String(account.id) !== transactionForm.accountId
                                      )
                                      .map((account) => (
                                        <option key={account.id} value={account.id}>
                                          {account.name}
                                        </option>
                                      ))}
                                  </select>
                                </label>
                                <label>
                                  Дата
                                  <DateField
                                    value={partnerCreate.date}
                                    onChange={(iso) =>
                                      setPartnerCreate({ ...partnerCreate, date: iso })
                                    }
                                  />
                                </label>
                                <label>
                                  Сумма
                                  {(() => {
                                    const currency = accounts.find(
                                      (account) =>
                                        String(account.id) === partnerCreate.accountId
                                    )?.currency;
                                    return currency ? ` (${currency})` : "";
                                  })()}
                                  <input
                                    inputMode="decimal"
                                    value={partnerCreate.amount}
                                    onChange={(event) =>
                                      setPartnerCreate({
                                        ...partnerCreate,
                                        amount: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                              </div>
                              <button
                                type="button"
                                className="secondaryButton"
                                disabled={
                                  saving || !partnerCreate.accountId || !partnerCreate.amount
                                }
                                onClick={() => void createAndLinkPartner()}
                              >
                                Создать и связать
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      )}
                    </>
                  ) : (
                    <>
                      <label>
                        Счет
                        <select
                          required
                          disabled={accounts.length === 0}
                          value={transactionForm.accountId}
                          onChange={(event) =>
                            setTransactionForm({
                              ...transactionForm,
                              accountId: event.target.value,
                            })
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
                        <DateField
                          required
                          value={transactionForm.date}
                          onChange={(iso) => setTransactionForm({ ...transactionForm, date: iso })}
                        />
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
                      <label className="wideField">
                        Заметка
                        <input
                          placeholder="Почему помечено / что проверить"
                          value={transactionForm.notes}
                          onChange={(event) =>
                            setTransactionForm({ ...transactionForm, notes: event.target.value })
                          }
                        />
                      </label>
                      <label className="flagCheck wideField">
                        <input
                          type="checkbox"
                          checked={transactionForm.flagged}
                          onChange={(event) =>
                            setTransactionForm({ ...transactionForm, flagged: event.target.checked })
                          }
                        />
                        ⚠️ Требует внимания
                      </label>
                    </>
                  )}
                  <button
                    className="primaryButton"
                    disabled={
                      saving ||
                      accounts.length === 0 ||
                      (transactionForm.direction === "transfer" &&
                        editingTransactionId !== null &&
                        !editingTransaction?.transferGroup &&
                        !partnerId)
                    }
                    type="submit"
                  >
                    <span>{editingTransactionId ? "✓" : "+"}</span>
                    {transactionForm.direction === "transfer" &&
                    editingTransactionId !== null &&
                    !editingTransaction?.transferGroup
                      ? "Связать"
                      : editingTransactionId
                        ? "Сохранить"
                        : "Добавить"}
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
        <>
          <div className="subNav" aria-label="Справочники">
            {(
              [
                { id: "accounts", label: "Счета" },
                { id: "categories", label: "Категории" },
                { id: "currencies", label: "Валюты" },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`subNavButton ${settingsTab === t.id ? "active" : ""}`}
                onClick={() => setSettingsTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {settingsTab === "accounts" ? (
            <div className="workspace oneCol">
              <section className="surface">
                <div className="sectionHead">
                  <h2>
                    Счета <span className="countBadge">{accounts.length}</span>
                  </h2>
                  <button className="primaryButton" type="button" onClick={openAddAccount}>
                    <span>+</span> Добавить
                  </button>
                </div>
                {accounts.length === 0 ? (
                  <div className="mutedBlock">Пока нет счетов</div>
                ) : (
                  <ul className="settingsList">
                    {accounts.map((account) => (
                      <li
                        key={account.id}
                        draggable
                        onDragStart={() => setDragAccountId(account.id)}
                        onDragEnd={() => setDragAccountId(null)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => dropAccount(account.id)}
                        className={dragAccountId === account.id ? "dragging" : ""}
                      >
                        <span className="dragHandle" title="Перетащите, чтобы изменить порядок">⠿</span>
                        <span className="accountDot" style={{ background: account.color }} />
                        <span className="settingsListMain">
                          <b>{account.name}</b>
                          <small>
                            {account.currency} ·{" "}
                            <Money cents={account.balanceCents} currency={account.currency} /> ·{" "}
                            {account.transactionCount} оп.
                            {account.openedAt ? ` · с ${dmy(account.openedAt)}` : ""}
                            {account.closedAt ? ` · по ${dmy(account.closedAt)}` : ""}
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
                            <EditIcon />
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
              </section>
            </div>
          ) : null}

          {settingsTab === "categories" ? (
            <div className="workspace twoCol">
              <section className="mainColumn">
                <section className="surface">
                  <div className="sectionHead">
                    <h2>
                      Категории <span className="countBadge">{categories.length}</span>
                    </h2>
                    <button className="primaryButton" type="button" onClick={openAddCategory}>
                      <span>+</span> Добавить
                    </button>
                  </div>
                  {categories.length === 0 ? (
                    <div className="mutedBlock">Пока нет категорий</div>
                  ) : (
                    <ul className="settingsList">
                      {categories.map((category) => (
                        <li
                          key={category.id}
                          draggable
                          onDragStart={() => setDragCategoryId(category.id)}
                          onDragEnd={() => setDragCategoryId(null)}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={() => dropCategory(category.id)}
                          className={dragCategoryId === category.id ? "dragging" : ""}
                        >
                          <span className="dragHandle" title="Перетащите, чтобы изменить порядок">⠿</span>
                          <span className="accountDot" style={{ background: category.color }} />
                          <span className="settingsListMain">
                            <b>{category.name}</b>
                          </span>
                          <span className="rowActions">
                            <button
                              className="iconButton small"
                              type="button"
                              title="Изменить"
                              aria-label="Изменить"
                              onClick={() => startEditCategory(category)}
                            >
                              <EditIcon />
                            </button>
                            <button
                              className="iconButton small danger"
                              type="button"
                              title="Удалить"
                              onClick={() => removeCategory(category)}
                            >
                              ×
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </section>

              <aside className="rightRail">
                <section className="surface">
                  <div className="sectionHead">
                    <h2>
                      Автокатегории <span className="countBadge">{rules.length}</span>
                    </h2>
                    <button className="primaryButton" type="button" onClick={openAddRule}>
                      <span>+</span> Добавить
                    </button>
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
                          <span className="rowActions">
                            <button
                              className="textButton ruleApplyButton"
                              type="button"
                              disabled={saving}
                              title="Применить это правило ко всем операциям, включая уже размеченные"
                              onClick={() => void applyOneRule(rule)}
                            >
                              ко всем
                            </button>
                            <button
                              className="iconButton small"
                              type="button"
                              title="Изменить"
                              aria-label="Изменить"
                              onClick={() => startEditRule(rule)}
                            >
                              <EditIcon />
                            </button>
                            <button
                              className="iconButton small danger"
                              type="button"
                              title="Удалить"
                              onClick={() => removeRule(rule)}
                            >
                              ×
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="applyRow">
                    <button
                      className="secondaryButton"
                      type="button"
                      disabled={saving || rules.length === 0}
                      onClick={() => void applyRules(false)}
                    >
                      Применить к операциям без категории
                    </button>
                    <button
                      className="secondaryButton"
                      type="button"
                      disabled={saving || rules.length === 0}
                      onClick={() => void applyRules(true)}
                    >
                      Применить ко всем (перезаписать)
                    </button>
                  </div>
                </section>
              </aside>
            </div>
          ) : null}

          {settingsTab === "currencies" ? (
            <div className="workspace oneCol">
              <section className="surface">
                <div className="sectionHead">
                  <h2>
                    Валюты <span className="countBadge">{currencies.length}</span>
                  </h2>
                  <button className="primaryButton" type="button" onClick={openAddCurrency}>
                    <span>+</span> Добавить
                  </button>
                </div>
                {currencies.length === 0 ? (
                  <div className="mutedBlock">Пока нет валют</div>
                ) : (
                  <ul className="settingsList">
                    {currencies.map((currency) => (
                      <li key={currency.code}>
                        <span className="settingsListMain">
                          <b>
                            {currency.code}
                            {currency.symbol ? ` · ${currency.symbol}` : ""}
                          </b>
                          <small>{currency.name || "—"}</small>
                        </span>
                        <span className="rowActions">
                          <button
                            className="iconButton small"
                            type="button"
                            title="Изменить"
                            aria-label="Изменить"
                            onClick={() => startEditCurrency(currency)}
                          >
                            <EditIcon />
                          </button>
                          <button
                            className="iconButton small danger"
                            type="button"
                            title="Удалить"
                            onClick={() => removeCurrency(currency)}
                          >
                            ×
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          ) : null}

          {accountModalOpen ? (
            <div
              className="modalOverlay"
              role="dialog"
              aria-modal="true"
              aria-label={editingAccountId !== null ? "Правка счёта" : "Новый счёт"}
              onClick={closeAccountModal}
            >
              <div className="modalCard" onClick={(event) => event.stopPropagation()}>
                <div className="modalHead">
                  <h2>{editingAccountId !== null ? "Правка счёта" : "Новый счёт"}</h2>
                  <button className="iconButton small" type="button" onClick={closeAccountModal} title="Закрыть">
                    ×
                  </button>
                </div>
                <form className="stackForm" onSubmit={handleSubmitAccount}>
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
                      <select
                        value={accountForm.currency}
                        onChange={(event) => setAccountForm({ ...accountForm, currency: event.target.value })}
                      >
                        {accountForm.currency &&
                        !currencies.some((c) => c.code === accountForm.currency) ? (
                          <option value={accountForm.currency}>{accountForm.currency}</option>
                        ) : null}
                        {currencies.map((currency) => (
                          <option key={currency.code} value={currency.code}>
                            {currency.code}
                            {currency.name ? ` — ${currency.name}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
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
                  </div>
                  <label>
                    Начальный баланс
                    <input
                      inputMode="decimal"
                      value={accountForm.openingBalance}
                      onChange={(event) => setAccountForm({ ...accountForm, openingBalance: event.target.value })}
                    />
                  </label>
                  <div className="formGrid two lifetimeGrid">
                    <label>
                      Открыт
                      <DateField
                        value={accountForm.openedAt}
                        onChange={(iso) => setAccountForm({ ...accountForm, openedAt: iso })}
                      />
                    </label>
                    <label>
                      Закрыт
                      <DateField
                        value={accountForm.closedAt}
                        onChange={(iso) => setAccountForm({ ...accountForm, closedAt: iso })}
                      />
                    </label>
                  </div>
                  <p className="importHint">
                    Пустая дата — «всегда». Начальный баланс появляется с даты
                    открытия; вне этих дат счёт скрыт из «Счетов», а операции
                    с датами вне периода отклоняются.
                  </p>
                  <label>
                    Цвет
                    <span className="colorField">
                      <input
                        type="color"
                        className="colorSwatch"
                        aria-label="Выбрать цвет"
                        value={accountForm.color}
                        onChange={(event) => setAccountForm({ ...accountForm, color: event.target.value })}
                      />
                      <input
                        placeholder="#2563eb"
                        value={accountForm.color}
                        onChange={(event) => setAccountForm({ ...accountForm, color: event.target.value })}
                      />
                    </span>
                  </label>
                  <button className="primaryButton" disabled={saving || currencies.length === 0} type="submit">
                    <span>{editingAccountId !== null ? "✓" : "+"}</span>
                    {editingAccountId !== null ? "Сохранить" : "Добавить"}
                  </button>
                </form>
              </div>
            </div>
          ) : null}

          {categoryModalOpen ? (
            <div
              className="modalOverlay"
              role="dialog"
              aria-modal="true"
              aria-label={editingCategoryId !== null ? "Правка категории" : "Новая категория"}
              onClick={closeCategoryModal}
            >
              <div className="modalCard" onClick={(event) => event.stopPropagation()}>
                <div className="modalHead">
                  <h2>{editingCategoryId !== null ? "Правка категории" : "Новая категория"}</h2>
                  <button className="iconButton small" type="button" onClick={closeCategoryModal} title="Закрыть">
                    ×
                  </button>
                </div>
                <form className="stackForm" onSubmit={handleSubmitCategory}>
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
                    <span className="colorField">
                      <input
                        type="color"
                        className="colorSwatch"
                        aria-label="Выбрать цвет"
                        value={categoryForm.color}
                        onChange={(event) => setCategoryForm({ ...categoryForm, color: event.target.value })}
                      />
                      <input
                        placeholder="#2563eb"
                        value={categoryForm.color}
                        onChange={(event) => setCategoryForm({ ...categoryForm, color: event.target.value })}
                      />
                    </span>
                  </label>
                  <button className="primaryButton" disabled={saving} type="submit">
                    <span>{editingCategoryId !== null ? "✓" : "+"}</span>
                    {editingCategoryId !== null ? "Сохранить" : "Добавить"}
                  </button>
                </form>
              </div>
            </div>
          ) : null}

          {currencyModalOpen ? (
            <div
              className="modalOverlay"
              role="dialog"
              aria-modal="true"
              aria-label={editingCurrencyCode !== null ? "Правка валюты" : "Новая валюта"}
              onClick={closeCurrencyModal}
            >
              <div className="modalCard" onClick={(event) => event.stopPropagation()}>
                <div className="modalHead">
                  <h2>{editingCurrencyCode !== null ? "Правка валюты" : "Новая валюта"}</h2>
                  <button className="iconButton small" type="button" onClick={closeCurrencyModal} title="Закрыть">
                    ×
                  </button>
                </div>
                <form className="stackForm" onSubmit={handleSubmitCurrency}>
                  <label>
                    Код валюты
                    <input
                      required
                      maxLength={5}
                      disabled={editingCurrencyCode !== null}
                      placeholder="USD"
                      value={currencyForm.code}
                      onChange={(event) =>
                        setCurrencyForm({ ...currencyForm, code: event.target.value.toUpperCase() })
                      }
                    />
                  </label>
                  <label>
                    Название
                    <input
                      placeholder="US Dollar"
                      value={currencyForm.name}
                      onChange={(event) => setCurrencyForm({ ...currencyForm, name: event.target.value })}
                    />
                  </label>
                  <label>
                    Символ
                    <input
                      placeholder="$"
                      value={currencyForm.symbol}
                      onChange={(event) => setCurrencyForm({ ...currencyForm, symbol: event.target.value })}
                    />
                  </label>
                  <button className="primaryButton" disabled={saving} type="submit">
                    <span>{editingCurrencyCode !== null ? "✓" : "+"}</span>
                    {editingCurrencyCode !== null ? "Сохранить" : "Добавить"}
                  </button>
                </form>
              </div>
            </div>
          ) : null}

          {ruleModalOpen ? (
            <div
              className="modalOverlay"
              role="dialog"
              aria-modal="true"
              aria-label={editingRuleId !== null ? "Правка правила" : "Новое правило"}
              onClick={closeRuleModal}
            >
              <div className="modalCard" onClick={(event) => event.stopPropagation()}>
                <div className="modalHead">
                  <h2>{editingRuleId !== null ? "Правка правила" : "Новое правило"}</h2>
                  <button className="iconButton small" type="button" onClick={closeRuleModal} title="Закрыть">
                    ×
                  </button>
                </div>
                <form className="stackForm" onSubmit={handleSubmitRule}>
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
                  <button className="primaryButton" disabled={saving} type="submit">
                    <span>{editingRuleId !== null ? "✓" : "+"}</span>
                    {editingRuleId !== null ? "Сохранить" : "Добавить"}
                  </button>
                </form>
              </div>
            </div>
          ) : null}
        </>
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

            <div className="forecastConfig">
              <label className="filterField">
                Ожидаемый доход в месяц
                <span className="goalInput">
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={forecastIncome}
                    onChange={(event) => setForecastIncome(Math.max(0, Number(event.target.value) || 0))}
                  />
                  {displayCurrency || "—"}
                </span>
              </label>
              <label className="filterField">
                Отложить к концу месяца (X)
                <span className="goalInput">
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={forecastGoal}
                    onChange={(event) => setForecastGoal(Math.max(0, Number(event.target.value) || 0))}
                  />
                  {displayCurrency || "—"}
                </span>
              </label>
            </div>

            {!forecastAvailable ? (
              <div className="mutedBlock">
                Прогноз считается для текущего месяца ({currentMonth}) в выбранной валюте.
                Открой текущий месяц на вкладке «Операции»
                {displayCurrency ? "" : " и выбери валюту в переключателе «В валюте»"}.
              </div>
            ) : forecastResult === null ? (
              <div className="mutedBlock">Загрузка истории…</div>
            ) : (
              <>
                <table className="forecastBreak">
                  <tbody>
                    <tr>
                      <td>Ожидаемый доход</td>
                      <td><Money cents={forecastResult.expectedIncomeCents} currency={displayCurrency} /></td>
                    </tr>
                    <tr>
                      <td>
                        − Обязательные{" "}
                        <span className="forecastMuted">
                          (оплачено <Money cents={forecastResult.committedPaidCents} currency={displayCurrency} /> +
                          предстоит <Money cents={forecastResult.committedUpcomingCents} currency={displayCurrency} />)
                        </span>
                      </td>
                      <td>−<Money cents={forecastResult.committedTotalCents} currency={displayCurrency} /></td>
                    </tr>
                    <tr>
                      <td>− Отложить (X)</td>
                      <td>−<Money cents={forecastResult.goalCents} currency={displayCurrency} /></td>
                    </tr>
                    <tr className="forecastBudgetRow">
                      <td>= Свободно на месяц</td>
                      <td><Money cents={forecastResult.discretionaryBudgetCents} currency={displayCurrency} /></td>
                    </tr>
                    <tr>
                      <td>Ровный лимит в день (раскраска)</td>
                      <td><Money cents={forecastResult.dailyAllowanceCents} currency={displayCurrency} /></td>
                    </tr>
                    <tr>
                      <td>Таргет на сегодня (скользящий)</td>
                      <td><Money cents={forecastResult.rollingTargetCents} currency={displayCurrency} /></td>
                    </tr>
                    <tr>
                      <td>Прогноз денег на конец месяца</td>
                      <td><Money cents={forecastResult.projectedEndCents} currency={displayCurrency} /></td>
                    </tr>
                  </tbody>
                </table>
                {!forecastResult.feasible ? (
                  <p className="forecastWarn">
                    Цель недостижима: не хватает{" "}
                    <Money cents={forecastResult.shortfallCents} currency={displayCurrency} />
                  </p>
                ) : null}

                <h3 className="recurHead">Обязательные (must-pay)</h3>
                <p className="panelNote">
                  Вся категория «B (must-pay)» считается обязательной целиком (аренда, ЖКХ, связь — независимо от
                  описания). Ожидаемый размер — медиана по последним месяцам.
                </p>
                <ul className="recurList">
                  <li>
                    <span className="recurName">B (must-pay) — вся категория</span>
                    <span className="recurMeta">
                      оплачено <Money cents={forecastResult.mustPayPaidCents} currency={displayCurrency} />
                    </span>
                    <span className="recurAmt">
                      <Money cents={forecastResult.mustPayCommittedCents} currency={displayCurrency} />/мес
                    </span>
                  </li>
                </ul>

                <h3 className="recurHead">Подписки ({forecastResult.recurring.length})</h3>
                <p className="panelNote">
                  Определены по повторяемости в «LS (apps)» (≥2 месяцев). Лишнее можно исключить — тогда оно
                  вернётся в дневные траты.
                </p>
                <ul className="recurList">
                  {forecastResult.recurring.map((item) => (
                    <li key={item.key}>
                      <span className="recurName">{item.label}</span>
                      <span className="recurMeta">{item.monthsPresent}/6 мес</span>
                      <span className="recurAmt">
                        <Money cents={item.expectedMonthlyCents} currency={displayCurrency} />/мес
                      </span>
                      <button
                        type="button"
                        className="textButton"
                        title="Исключить из обязательных"
                        onClick={() => setExcludedCommitted((current) => [...current, item.key])}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                {forecastResult.excludedRecurring.length > 0 ? (
                  <>
                    <h3 className="recurHead muted">Исключено ({forecastResult.excludedRecurring.length})</h3>
                    <ul className="recurList excluded">
                      {forecastResult.excludedRecurring.map((item) => (
                        <li key={item.key}>
                          <span className="recurName">{item.label}</span>
                          <span className="recurAmt">
                            <Money cents={item.expectedMonthlyCents} currency={displayCurrency} />/мес
                          </span>
                          <button
                            type="button"
                            className="textButton"
                            onClick={() =>
                              setExcludedCommitted((current) => current.filter((k) => k !== item.key))
                            }
                          >
                            вернуть
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                <p className="panelNote forecastAssume">
                  Прототип: конвертация в {displayCurrency} по курсу на {dmy(periodRateDate)}; доход — фиксированное поле;
                  крупные разовые траты считаются как есть; прогноз конца месяца — по среднему дневному темпу трат.
                </p>
              </>
            )}
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
