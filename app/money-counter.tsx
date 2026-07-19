"use client";

import {
  Fragment,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
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
  parseMoneyInputToCents,
} from "../lib/finance";
import { selectAccountPanelItems } from "../lib/accounts-panel";
import {
  buildCategoryPresentation,
  buildTransferRowPresentation,
  groupOperationItemsByDate,
  groupOperationItemsByYear,
  hasOperationListFilters,
  selectActiveAccountsOn,
  shouldLoadOperationHistory,
  sortOperationItems,
  type OperationListScope,
} from "../lib/phase1";
import {
  analyzeImport,
  type AnalyzeResult,
  type ParsedRow,
} from "../lib/import";
import { analyzePdf, type PdfPage } from "../lib/pdf";
import {
  attachDuplicateCandidates,
  formatAmountWithType,
  formatDateRangeRu,
  guessPhase2Columns,
  hasIssues,
  normalizePdfOperations,
  normalizeTextOperations,
  orderByAttention,
  pluralRu,
  summarizeOperations,
  type ExistingTransaction,
  type ImportIssue,
  type NormalizedOperation,
  type Phase2Columns,
} from "../lib/import-preview";
import type { DescriptionSuggestion } from "../lib/operations";
import {
  forecastMonth,
  type ForecastResult,
  type Loan,
  type RegularPayment,
  type RegularSuggestion,
} from "../lib/forecast";

type Goal = { month: string; amountCents: number; currency: string };
type LoanSuggestion = {
  name: string;
  amountCents: number;
  currency: string;
  direction: string;
  sourceDate: string;
};

function regularPeriodLabel(rp: RegularPayment): string {
  const day = rp.dayOfMonth;
  if (rp.periodicity === "yearly") {
    return `раз в год · ${String(day).padStart(2, "0")}.${String(rp.month ?? 1).padStart(2, "0")}`;
  }
  if (rp.periodicity === "every_n_months") {
    return `раз в ${rp.intervalMonths ?? 3} мес. · ${day}-е`;
  }
  return `каждый месяц · ${day}-е`;
}

const LOAN_DIR_LABEL: Record<string, string> = {
  owe: "мы отдаём",
  owed: "нам вернут",
  reimbursement: "возмещение",
};

type Account = {
  id: number;
  name: string;
  bankName: string;
  currency: string;
  type: string;
  openingBalanceCents: number;
  color: string;
  // Lifetime bounds (null = «всегда»): the opening balance counts from
  // openedAt, and the «Счета» panel hides the account outside the range.
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

const ACCOUNT_PANEL_SKELETON_WIDTHS = [
  ["72%", "62%", "78%"],
  ["88%", "55%", "66%"],
  ["80%", "69%", "74%"],
  ["61%", "48%", "81%"],
  ["76%", "63%", "70%"],
  ["84%", "51%", "75%"],
  ["65%", "58%", "68%"],
  ["90%", "44%", "82%"],
  ["73%", "60%", "72%"],
] as const;

const OPERATION_TABLE_SKELETON_WIDTHS = [
  ["0", "72%", "84%", "74%", "70%", "0"],
  ["0", "61%", "92%", "66%", "58%", "0"],
  ["0", "79%", "70%", "82%", "76%", "0"],
  ["0", "68%", "88%", "71%", "63%", "0"],
  ["0", "57%", "77%", "84%", "70%", "0"],
  ["0", "83%", "63%", "68%", "81%", "0"],
] as const;

// A row of the operations table: an ordinary transaction, or two loaded legs
// of one transfer collapsed into a single «A → B» line.
type DisplayRow =
  | { kind: "tx"; tx: Transaction }
  | { kind: "transfer"; out: Transaction; incoming: Transaction };

type OperationSort = "date" | "amount-desc" | "amount-asc";

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
  descriptionIn: string;
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

type PrimaryNavTab = Exclude<Tab, "pending">;

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

// Numeric px value of a :root CSS custom property (e.g. --metrics-h). Keeps
// the stylesheet the single source of layout offsets that JS also needs.
function readCssVarPx(name: string, fallback: number) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

// «Июль 2026» — prototype format, without the Intl «г.» suffix.
function formatMonthLabel(ym: string) {
  const { year, month } = ymParts(ym);
  const label = new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
  })
    .format(new Date(year, month - 1, 1))
    .replace(/\s*г\.\s*$/, "");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// «июль» — the bare month name used by forecast titles («Прогноз на июль»).
function formatMonthName(ym: string) {
  const { year, month } = ymParts(ym);
  return new Intl.DateTimeFormat("ru-RU", { month: "long" }).format(
    new Date(year, month - 1, 1)
  );
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

// The single shared money renderer. Wraps the value in .money, which enforces
// the two non-negotiable invariants (white-space: nowrap + tabular numerals) at
// the component level, so a number and its currency can never be separated by
// a line break regardless of the container. The currency symbol is greyed out
// (#DDDDDD via .currencySymbol). `secondary` offers the smaller companion
// style (12px/400) for callers without container-level sizing; existing
// secondary amounts keep their container styles.
function Money({
  cents,
  currency,
  secondary = false,
}: {
  cents: number;
  currency: string;
  secondary?: boolean;
}) {
  return (
    <span className={secondary ? "money moneySecondary" : "money"}>
      {formatMoneyParts(cents, currency).map((part, index) =>
        part.type === "currency" ? (
          <span key={index} className="currencySymbol">
            {part.value}
          </span>
        ) : (
          <Fragment key={index}>{part.value}</Fragment>
        )
      )}
    </span>
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
function ClampedName({ text, phase1 = false }: { text: string; phase1?: boolean }) {
  const [clamped, setClamped] = useState(false);
  const spanRef = useRef<HTMLSpanElement>(null);
  return (
    <span
      className={phase1 ? "p1ClampWrap" : "accCellWrap"}
      {...(clamped ? (phase1 ? { "data-p1-tip": text } : { "data-tip": text }) : {})}
      onMouseEnter={() => {
        const el = spanRef.current;
        if (el) setClamped(el.scrollWidth > el.clientWidth + 1);
      }}
    >
      <span ref={spanRef} className={phase1 ? "p1ClampText" : "accName"}>
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
  phase1 = false,
}: {
  value: string;
  onChange: (iso: string) => void;
  required?: boolean;
  disabled?: boolean;
  phase1?: boolean;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  return (
    <span className={phase1 ? "p1DateField" : "dateField"}>
      <button
        type="button"
        className={phase1 ? "p1DateFieldFace" : "dateFieldFace"}
        aria-label={`Дата: ${value ? dmy(value) : "не выбрана"}`}
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
        {value ? dmy(value) : (
          <span className={phase1 ? "p1DateFieldEmpty" : "dateFieldEmpty"}>дд.мм.гггг</span>
        )}
      </button>
      <input
        ref={pickerRef}
        type="date"
        className={phase1 ? "p1DateFieldNative" : "dateFieldNative"}
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

function NavIcon({ tab }: { tab: PrimaryNavTab }) {
  if (tab === "main") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M4 12h16M4 17h10" />
      </svg>
    );
  }
  if (tab === "forecast") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m3 17 5-5 4 3 7-8" />
        <path d="M14 7h5v5" />
      </svg>
    );
  }
  if (tab === "charts") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3A1.7 1.7 0 0 0 14 21v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14h-.2v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
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

const TABLE_MONTH_SHORT = [
  "янв", "фев", "мар", "апр", "мая", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

function shortOperationDate(isoDate: string, withYear = false) {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return `${day} ${TABLE_MONTH_SHORT[month - 1]}${withYear ? ` ${year}` : ""}`;
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

function CategoryDonut({
  items,
  currency,
}: {
  items: Array<{ label: string; cents: number; color: string }>;
  currency: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const { slices: allItems, legend, totalCents: total } = buildCategoryPresentation(items);
  if (total <= 0) return <div className="categoryEmpty">Нет расходов за период</div>;

  const cx = 140;
  const cy = 140;
  // Prototype v34 uses a 56px ring centred on radius 100. Expressing the
  // same geometry as a filled path gives an outer radius of 128 and an inner
  // radius of 72.
  const r = 128;
  const ir = 72;
  const start = -Math.PI / 2;
  const slices = allItems.map((item, index) => {
    const prior = allItems.slice(0, index).reduce((sum, row) => sum + row.cents, 0);
    const share = item.cents / total;
    const a0 = start + (prior / total) * Math.PI * 2;
    const a1 = a0 + Math.min(share, 0.9999) * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    return {
      ...item,
      share,
      d: donutPath(cx, cy, r, ir, a0, a1),
      labelX: cx + Math.cos(mid) * 104,
      labelY: cy + Math.sin(mid) * 104,
    };
  });
  const active = activeIndex === null ? null : slices[activeIndex];

  return (
    <div className="categoryDonut">
      <div className="categoryDonutVisual">
        <svg viewBox="0 0 280 280" role="group" aria-label="Расходы по категориям">
          <circle
            className="categoryDonutTrack"
            cx="140"
            cy="140"
            r="100"
            fill="none"
            stroke="#ececf1"
            strokeWidth="56"
          />
          {slices.map((slice, index) => (
            <path
              key={`${slice.label}-${index}`}
              d={slice.d}
              fill={slice.color}
              tabIndex={0}
              role="img"
              aria-label={`${slice.label}: ${formatMoney(slice.cents, currency)}`}
              className={activeIndex !== null && activeIndex !== index ? "dimmed" : ""}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
            />
          ))}
          {slices
            .filter((slice) => slice.share >= 0.075)
            .map((slice) => (
              <text
                key={`${slice.label}-${slice.labelX}-label`}
                x={slice.labelX}
                y={slice.labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                className="categoryDonutLabel"
              >
                {Math.round(slice.share * 100)}%
              </text>
            ))}
          <text x="140" y="144" textAnchor="middle" className="categoryDonutTotal">
            {formatMoney(total, currency)}
          </text>
        </svg>
        {active ? (
          <div className="categoryTooltip" role="status">
            <strong>{active.label}</strong>
            <div className="categoryTooltipMeta">
              <span><Money cents={active.cents} currency={currency} /></span>
              <span>{(active.share * 100).toFixed(1)}%</span>
            </div>
          </div>
        ) : null}
        <div className="categoryLegend">
          {legend.map((item) => {
            const index = slices.findIndex((slice) => slice.label === item.label);
            const slice = slices[index];
            return (
            <button
              type="button"
              key={slice.label}
              className={activeIndex === index ? "active" : ""}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <span className="categoryLegendDot" style={{ background: slice.color }} />
              <span className="categoryLegendName">{slice.label}</span>
              <span className="categoryLegendValue"><Money cents={slice.cents} currency={currency} /></span>
            </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function OperationTableState({
  kind,
  onAction,
}: {
  kind: "error" | "empty" | "no-results";
  onAction: () => void;
}) {
  const content =
    kind === "error"
      ? {
          icon: "!",
          title: "Не удалось загрузить операции",
          text: "Попробуйте загрузить список ещё раз.",
          action: "Повторить",
        }
      : kind === "no-results"
        ? {
            icon: "⌕",
            title: "Ничего не найдено",
            text: "Попробуйте изменить поисковый запрос или выбранные фильтры.",
            action: "Сбросить поиск и фильтры",
          }
        : {
            icon: "＋",
            title: "В этом периоде пока нет операций",
            text: "Добавьте первую операцию, чтобы начать вести учёт за выбранный период.",
            action: "+ Добавить операцию",
          };

  return (
    <td colSpan={6} className={`operationState ${kind}`}>
      <div className="operationStateInner">
        <span className="operationStateIcon" aria-hidden="true">{content.icon}</span>
        <h3>{content.title}</h3>
        <p>{content.text}</p>
        <button type="button" onClick={onAction}>{content.action}</button>
      </div>
    </td>
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
  phase1 = false,
}: {
  value: string;
  onChange: (value: string) => void;
  max: string;
  ariaLabel: string;
  phase1?: boolean;
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
    <div className={phase1 ? "p1MonthPicker" : "monthPicker"} ref={containerRef}>
      <span className={phase1 ? "p1MonthPickerCapsule" : "monthPickerCapsule"}>
        <button
          type="button"
          className={phase1 ? "p1MonthPickerArrow" : "monthPickerArrow"}
          aria-label="Предыдущий месяц"
          title="Предыдущий месяц"
          onClick={() => onChange(addMonths(value, -1))}
        >
          ‹
        </button>
        <button
          type="button"
          className={phase1 ? "p1MonthPickerTrigger" : "monthPickerTrigger"}
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggle}
        >
          <span>{formatMonthLabel(value)}</span>
          <span className={phase1 ? "p1MonthPickerCaret" : "monthPickerCaret"} aria-hidden="true">▾</span>
        </button>
        <button
          type="button"
          className={phase1 ? "p1MonthPickerArrow" : "monthPickerArrow"}
          aria-label="Следующий месяц"
          title="Следующий месяц"
          disabled={value >= max}
          onClick={() => onChange(addMonths(value, 1))}
        >
          ›
        </button>
      </span>
      {open ? (
        <div className={phase1 ? "p1MonthPickerPanel" : "monthPickerPanel"} role="dialog" aria-label={ariaLabel}>
          <div className={phase1 ? "p1MonthPickerHead" : "monthPickerHead"}>
            <button
              type="button"
              className={phase1 ? "p1MonthPickerYearButton" : "iconButton small"}
              onClick={() => setViewYear((y) => y - 1)}
              aria-label="Предыдущий год"
            >
              ‹
            </button>
            <b>{viewYear}</b>
            <button
              type="button"
              className={phase1 ? "p1MonthPickerYearButton" : "iconButton small"}
              onClick={() => setViewYear((y) => y + 1)}
              disabled={viewYear >= maxYear}
              aria-label="Следующий год"
            >
              ›
            </button>
          </div>
          <div className={phase1 ? "p1MonthPickerGrid" : "monthPickerGrid"}>
            {MONTH_SHORT.map((label, index) => {
              const month = index + 1;
              const ym = `${viewYear}-${String(month).padStart(2, "0")}`;
              const isSelected = viewYear === selectedYear && month === selectedMonth;
              return (
                <button
                  key={month}
                  type="button"
                  className={`${phase1 ? "p1MonthPickerMonth" : "monthPickerMonth"} ${
                    isSelected ? "selected" : ""
                  }`}
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

// --- Phase 2: bank-statement import modal -----------------------------------
// A self-contained 3-step flow (Файл и счёт → Сопоставление → Проверка) that
// converges 1:1 with prototype v34.1. Parsing (lib/import, lib/pdf), preview
// normalization + duplicate search (lib/import-preview) and the final write
// (POST /api/import) are kept separated so the deferred UX patch can redesign
// the interim states without touching the pipeline.

type ImportDecision =
  | { type: "keep" }
  | { type: "exclude" }
  | { type: "fixDate"; value: string }
  | { type: "fixAmount"; cents: number };

type ImportFileStatus = "idle" | "loading" | "ready" | "error" | "empty";

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const probe = new Date(0);
  probe.setUTCFullYear(y, m - 1, d + days);
  return probe.toISOString().slice(0, 10);
}

// pdfjs is loaded lazily (only when a PDF is picked) so it stays out of the
// main bundle; it extracts positioned text in the browser for lib/pdf.
async function extractPdfPages(file: File): Promise<PdfPage[]> {
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
  return pages;
}

const OPERATION_FORMS: [string, string, string] = ["операция", "операции", "операций"];

function ImportModal({
  accounts,
  activeCurrency,
  notify,
  onClose,
  onImported,
}: {
  accounts: Account[];
  activeCurrency: string;
  notify: (message: string) => void;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [status, setStatus] = useState<ImportFileStatus>("idle");
  const [fileName, setFileName] = useState("");
  const [fileFormat, setFileFormat] = useState<"tsv" | "csv" | "pdf">("tsv");
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [pdfRows, setPdfRows] = useState<ParsedRow[] | null>(null);
  const [columns, setColumns] = useState<Phase2Columns | null>(null);
  const [accountId, setAccountId] = useState("");
  const [openEditor, setOpenEditor] = useState<"date" | "description" | "amount" | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ImportDecision>>({});
  const [existing, setExisting] = useState<ExistingTransaction[] | null>(null);
  // True when the duplicate-search read failed: we then keep the server's
  // exact-fingerprint dedupe as a safety net (skipDedupe=false) instead of
  // blindly creating rows the preview never got to check.
  const [dupFailed, setDupFailed] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const [fullSearch, setFullSearch] = useState("");
  const [fullFilter, setFullFilter] = useState<"all" | "attention" | "expense" | "income">("all");
  const [submitting, setSubmitting] = useState(false);

  const dialogRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const account = accounts.find((item) => String(item.id) === accountId) ?? null;

  const rawOps = useMemo<NormalizedOperation[]>(() => {
    if (fileFormat === "pdf" && pdfRows) {
      return normalizePdfOperations(pdfRows, {
        currency: pdfRows[0]?.currency ?? activeCurrency,
      });
    }
    if (analysis && columns) {
      return normalizeTextOperations(analysis, {
        columns,
        defaultCurrency: analysis.detectedCurrency,
        sourceFormat: fileFormat,
      });
    }
    return [];
  }, [fileFormat, pdfRows, analysis, columns, activeCurrency]);

  const summary = useMemo(() => summarizeOperations(rawOps), [rawOps]);
  const fileCurrency = summary.currency;
  const currencyMismatch = Boolean(
    account && rawOps.length > 0 && account.currency !== fileCurrency
  );

  // Duplicate issues attach only once the account's existing operations have
  // been read (a read-only fetch — never a write). Re-running is idempotent.
  const ops = useMemo<NormalizedOperation[]>(
    () => (existing ? attachDuplicateCandidates(rawOps, existing) : rawOps),
    [rawOps, existing]
  );

  // Existing account operations for the duplicate window (file dates ±3 days).
  // Keyed on the stable accountId (not the per-render `account` object) so it
  // fetches once per account/step, never on every render. Read-only — no write.
  const minDate = summary.minDate;
  const maxDate = summary.maxDate;
  useEffect(() => {
    if (step !== 3 || !accountId || rawOps.length === 0 || !minDate || !maxDate) return;
    let cancelled = false;
    void (async () => {
      try {
        const from = addDaysIso(minDate, -3);
        const to = addDaysIso(maxDate, 3);
        const data = await requestJson<{
          transactions: Array<{ id: number; date: string; description: string; amountCents: number }>;
        }>(`/api/transactions?accountId=${accountId}&from=${from}&to=${to}&limit=500`);
        if (cancelled) return;
        setDupFailed(false);
        setExisting(
          data.transactions.map((tx) => ({
            id: tx.id,
            date: tx.date,
            description: tx.description,
            amountCents: tx.amountCents,
          }))
        );
      } catch {
        if (!cancelled) {
          setDupFailed(true);
          setExisting([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, accountId, rawOps.length, minDate, maxDate]);

  // Focus trap, background scroll lock, Escape to close (Q-06 accessibility).
  useEffect(() => {
    const dialog = dialogRef.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (fullOpen) setFullOpen(false);
        else onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const scope = fullOpen
        ? document.querySelector<HTMLElement>(".im-full-dialog")
        : dialog;
      const focusable = [
        ...(scope?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []),
      ].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      document
        .querySelector<HTMLElement>('[data-focus-key="add-operation"]')
        ?.focus();
    };
  }, [fullOpen, onClose]);

  function resetFile() {
    setStatus("idle");
    setFileName("");
    setAnalysis(null);
    setPdfRows(null);
    setColumns(null);
    setOpenEditor(null);
    setExisting(null);
    setDupFailed(false);
    setDecisions({});
  }

  // Remapping a column invalidates any per-row decisions and the duplicate
  // search (source row ids are stable but their content changed).
  function remapColumn(patch: Partial<Phase2Columns>) {
    setColumns((current) => (current ? { ...current, ...patch } : current));
    setDecisions({});
    setExisting(null);
    setDupFailed(false);
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    setStep(1);
    setStatus("loading");
    setAnalysis(null);
    setPdfRows(null);
    setColumns(null);
    setOpenEditor(null);
    setExisting(null);
    setDupFailed(false);
    setDecisions({});

    if (file.size > 20 * 1024 * 1024) {
      setStatus("error");
      notify("Файл больше 20 МБ");
      return;
    }

    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    try {
      if (isPdf) {
        const pages = await extractPdfPages(file);
        const result = analyzePdf(pages);
        if (!result.bank) {
          setStatus("error");
          return;
        }
        const previewOps = normalizePdfOperations(result.rows, { currency: result.currency });
        setPdfRows(result.rows);
        setFileFormat("pdf");
        setFileName(file.name);
        setStatus(previewOps.length > 0 ? "ready" : "empty");
      } else {
        const text = await file.text();
        const parsed = analyzeImport(text, { defaultCurrency: activeCurrency });
        if (parsed.headers.length === 0) {
          setStatus("error");
          return;
        }
        const format: "tsv" | "csv" = parsed.delimiter === "," ? "csv" : "tsv";
        const cols = guessPhase2Columns(parsed);
        const previewOps = normalizeTextOperations(parsed, {
          columns: cols,
          defaultCurrency: parsed.detectedCurrency,
          sourceFormat: format,
        });
        setAnalysis(parsed);
        setColumns(cols);
        setFileFormat(format);
        setFileName(file.name);
        setStatus(previewOps.length > 0 ? "ready" : "empty");
      }
    } catch {
      setStatus("error");
    }
  }

  // --- review helpers --------------------------------------------------------
  const decisionOf = (op: NormalizedOperation): ImportDecision | undefined =>
    decisions[op.sourceRowId];

  const isUnresolved = (op: NormalizedOperation) => hasIssues(op) && !decisionOf(op);
  const isExcluded = (op: NormalizedOperation) => decisionOf(op)?.type === "exclude";

  const effectiveDate = (op: NormalizedOperation): string | null => {
    const decision = decisionOf(op);
    return decision?.type === "fixDate" ? decision.value : op.date;
  };
  const effectiveAmount = (op: NormalizedOperation): number | null => {
    const decision = decisionOf(op);
    return decision?.type === "fixAmount" ? decision.cents : op.amountCents;
  };

  const unresolvedCount = ops.filter(isUnresolved).length;
  const excludedCount = ops.filter(isExcluded).length;
  const summaryCount = ops.length - excludedCount;
  // Operations that will actually be created: clean rows plus problem rows the
  // user kept/fixed (excluded and still-undecided rows are not counted).
  const isIncluded = (op: NormalizedOperation) => {
    if (!hasIssues(op)) return true;
    const decision = decisionOf(op);
    return Boolean(decision) && decision!.type !== "exclude";
  };
  const includedCount = ops.filter(isIncluded).length;

  const problemOps = ops.filter(hasIssues);
  const normalOps = ops.filter((op) => !hasIssues(op));
  const totalOps = ops.length;

  function setDecision(op: NormalizedOperation, decision: ImportDecision | null) {
    setDecisions((current) => {
      const next = { ...current };
      if (decision === null) delete next[op.sourceRowId];
      else next[op.sourceRowId] = decision;
      return next;
    });
  }

  // --- submit ----------------------------------------------------------------
  async function handleImport() {
    if (!account || unresolvedCount > 0) return;
    const included = ops.filter((op) => !isExcluded(op));
    const rows: ImportPayloadRow[] = included.map((op) => {
      const cents = effectiveAmount(op) ?? 0;
      return {
        currency: op.currency,
        date: effectiveDate(op) ?? "",
        amount: (cents / 100).toFixed(2),
        direction: op.direction ?? "expense",
        description: op.description,
        category: "",
        payee: "",
        notes: "",
      };
    });
    if (rows.length === 0) return;
    setSubmitting(true);
    try {
      const result = await requestJson<{
        createdTransactions: number;
        duplicates: number;
        rejected: Array<{ row: number; reason: string }>;
      }>("/api/import", {
        method: "POST",
        // Duplicates were resolved per-row in preview, so skip the server's
        // fingerprint dedupe — UNLESS the duplicate search itself failed, in
        // which case we keep it as a safety net so nothing is created blindly.
        body: JSON.stringify({ rows, accountId: Number(account.id), skipDedupe: !dupFailed }),
      });
      await onImported();
      // Surface any rows the server rejected/skipped so kept rows never vanish
      // without explanation.
      const extra: string[] = [];
      if (result.rejected?.length) extra.push(`отклонено: ${result.rejected.length}`);
      if (result.duplicates) extra.push(`дублей пропущено: ${result.duplicates}`);
      notify(
        `Импортировано: ${result.createdTransactions} ${pluralRu(
          result.createdTransactions,
          OPERATION_FORMS
        )}${extra.length ? ` (${extra.join(", ")})` : ""}`
      );
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Импорт не выполнен");
    } finally {
      setSubmitting(false);
    }
  }

  // --- stepper / footer ------------------------------------------------------
  const canLeaveStep1 = status === "ready" && Boolean(account) && !currencyMismatch;
  // On step 3 the duplicate search must finish (existing !== null) before import
  // is allowed, otherwise a fast click on a clean statement would submit with
  // skipDedupe before any duplicate_candidate issue was attached.
  const duplicateSearchPending = step === 3 && existing === null;
  // All questions resolved but nothing left to create → a terminal "everything
  // excluded" state: the primary action becomes «Завершить» and just closes the
  // modal without calling the create API.
  const allExcluded =
    step === 3 && !duplicateSearchPending && unresolvedCount === 0 && includedCount === 0;
  const nextDisabled =
    (step === 1 && !canLeaveStep1) ||
    (step === 3 &&
      !allExcluded &&
      (unresolvedCount > 0 || summaryCount === 0 || duplicateSearchPending));

  function goNext() {
    if (nextDisabled) return;
    if (step < 3) setStep((step + 1) as 1 | 2 | 3);
    else if (allExcluded) onClose();
    else void handleImport();
  }

  const firstOp = rawOps[0] ?? null;

  // Computed from the NORMALIZED operations (not raw file rows), so it is
  // correct for every format including PDF — e.g. the KBank PDF reports
  // «Распознано: 8 расходов и 2 поступления».
  const typeStatsLine = `Распознано: ${summary.expenseCount} ${pluralRu(summary.expenseCount, [
    "расход",
    "расхода",
    "расходов",
  ])} и ${summary.incomeCount} ${pluralRu(summary.incomeCount, [
    "поступление",
    "поступления",
    "поступлений",
  ])}.`;

  const introText =
    totalOps <= 25
      ? "Все найденные операции показаны ниже."
      : problemOps.length > 0
        ? "Ниже показаны все проблемные операции и первые 10 остальных."
        : `Показаны первые 10 из ${totalOps} операций.`;

  // Problem rows are the only ones the user MUST act on and final import is
  // blocked until each is resolved — so they are always shown in full (the
  // review list scrolls, via the shared orderByAttention helper). Only the
  // non-blocking normal rows are capped at 10 for large files; the full list
  // shows everything. This keeps the introText "…все проблемные операции…" true
  // and avoids a dead-end where a hidden unresolved problem keeps import
  // disabled with no way to reach it.
  const visibleReviewOps =
    totalOps <= 25
      ? orderByAttention(ops, hasIssues)
      : [...problemOps, ...normalOps.slice(0, 10)];

  // --- render helpers --------------------------------------------------------
  function reasonFor(issue: ImportIssue): string {
    switch (issue.kind) {
      case "duplicate_candidate":
        return "Похожая операция уже есть в выбранном счёте.";
      case "missing_date":
        return "Не удалось определить дату операции.";
      case "ambiguous_amount":
        return "Сумма не совпадает с изменением баланса.";
      case "bank_state":
        return `Банк отметил операцию как ${issue.state}.`;
    }
  }

  function resolvedTextFor(op: NormalizedOperation, decision: ImportDecision): string {
    if (decision.type === "exclude") return "Исключена из импорта.";
    if (decision.type === "fixDate") return `Дата выбрана: ${dmy(decision.value)}.`;
    if (decision.type === "fixAmount") {
      return `Будет импортирована сумма ${formatMoney(decision.cents, op.currency)}.`;
    }
    const issue = op.issues[0];
    // Approved copy defines a resolved-keep string only for duplicates. For a
    // kept bank-state row we use a minimal factual line (not a new "status")
    // pending a copy decision — see handoff §7.
    if (issue?.kind === "bank_state") return "Будет импортирована.";
    return "Будет импортирована несмотря на возможное совпадение.";
  }

  function renderIssueControls(op: NormalizedOperation, issue: ImportIssue) {
    const decision = decisionOf(op);
    if (decision) {
      return (
        <button
          className="im-link-button"
          type="button"
          onClick={() => setDecision(op, null)}
        >
          Изменить
        </button>
      );
    }
    if (issue.kind === "missing_date") {
      return (
        <>
          <select
            className="op-control im-issue-select"
            defaultValue=""
            aria-label="Выберите дату"
            onChange={(event) =>
              event.target.value && setDecision(op, { type: "fixDate", value: event.target.value })
            }
          >
            <option value="" disabled>
              Выберите дату
            </option>
            {issue.options.map((value) => (
              <option key={value} value={value}>
                {dmy(value)}
              </option>
            ))}
          </select>
          <button
            className="im-link-button im-issue-exclude"
            type="button"
            onClick={() => setDecision(op, { type: "exclude" })}
          >
            Исключить
          </button>
        </>
      );
    }
    if (issue.kind === "ambiguous_amount") {
      return (
        <>
          <select
            className="op-control im-issue-select"
            defaultValue=""
            aria-label="Выберите сумму"
            onChange={(event) =>
              event.target.value &&
              setDecision(op, { type: "fixAmount", cents: Number(event.target.value) })
            }
          >
            <option value="" disabled>
              Выберите сумму
            </option>
            {issue.options.map((option) => (
              <option key={`${option.amountCents}-${option.label}`} value={option.amountCents}>
                {formatMoney(option.amountCents, op.currency)} · {option.label}
              </option>
            ))}
          </select>
          <button
            className="im-link-button im-issue-exclude"
            type="button"
            onClick={() => setDecision(op, { type: "exclude" })}
          >
            Исключить
          </button>
        </>
      );
    }
    // duplicate_candidate / bank_state — Импортировать / Исключить
    return (
      <>
        <button
          className="op-button"
          type="button"
          onClick={() => setDecision(op, { type: "keep" })}
        >
          Импортировать
        </button>
        <button
          className="im-link-button im-issue-exclude"
          type="button"
          onClick={() => setDecision(op, { type: "exclude" })}
        >
          Исключить
        </button>
      </>
    );
  }

  function renderAmount(op: NormalizedOperation) {
    const cents = effectiveAmount(op);
    if (cents === null) return <span>—</span>;
    return (
      <span className={op.direction === "income" ? "income" : undefined}>
        {op.direction === "income" ? "+" : ""}
        <Money cents={cents} currency={op.currency} />
      </span>
    );
  }

  function renderReviewRow(op: NormalizedOperation) {
    const date = effectiveDate(op);
    return (
      <div className="im-preview-row" key={op.sourceRowId}>
        <div>{date ? dmy(date) : "—"}</div>
        <div className="im-preview-description">{op.description || "—"}</div>
        <div className={`im-preview-amount ${op.direction === "income" ? "income" : ""}`}>
          {renderAmount(op)}
        </div>
      </div>
    );
  }

  function renderIssueBlock(op: NormalizedOperation) {
    const issue = op.issues[0];
    const decision = decisionOf(op);
    const date = effectiveDate(op);
    const blockClass = decision
      ? decision.type === "exclude"
        ? "im-issue-block resolved excluded"
        : "im-issue-block resolved"
      : "im-issue-block";
    return (
      <div className={blockClass} key={op.sourceRowId}>
        <div className="im-preview-row">
          <div>{date ? dmy(date) : "—"}</div>
          <div className="im-preview-description">
            {op.description || "—"}
            <span className={`im-review-badge${decision ? " resolved" : ""}`}>
              {decision ? "Решено" : "Проверить"}
            </span>
          </div>
          <div className={`im-preview-amount ${op.direction === "income" ? "income" : ""}`}>
            {renderAmount(op)}
          </div>
        </div>
        <div className="im-issue-strip">
          <div className="im-issue-message">
            <strong>{decision ? "Готово" : "Причина:"}</strong>{" "}
            {decision ? resolvedTextFor(op, decision) : reasonFor(issue)}
          </div>
          <div className="im-issue-actions">{renderIssueControls(op, issue)}</div>
        </div>
      </div>
    );
  }

  // --- full list -------------------------------------------------------------
  // Full list: search + the chosen filter are applied FIRST, then the shared
  // ordering floats the rows that require attention (problem rows) to the top,
  // preserving source order inside each group — same helper as the review.
  const fullRows = orderByAttention(
    ops.filter((op) => {
      if (fullSearch && !op.description.toLowerCase().includes(fullSearch.toLowerCase())) {
        return false;
      }
      if (fullFilter === "attention") return isUnresolved(op);
      if (fullFilter === "expense") return op.direction === "expense";
      if (fullFilter === "income") return op.direction === "income";
      return true;
    }),
    hasIssues
  );

  const stepStateClass = (index: 1 | 2 | 3) =>
    `im-step${step === index ? " active" : ""}${step > index ? " done" : ""}`;

  return (
    <div className="im-overlay open" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className={`im-dialog${step === 3 ? " review-fixed" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Импорт выписки"
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="im-header">
          <h2>Импорт выписки</h2>
          <button className="im-close" type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="im-stepper" aria-label="Этапы импорта">
          <div className={stepStateClass(1)}>
            <span className="im-step-no">1</span>
            <span className="im-step-copy">
              <strong>Файл и счёт</strong>
            </span>
          </div>
          <div className={stepStateClass(2)}>
            <span className="im-step-no">2</span>
            <span className="im-step-copy">
              <strong>Сопоставление</strong>
            </span>
          </div>
          <div className={stepStateClass(3)}>
            <span className="im-step-no">3</span>
            <span className="im-step-copy">
              <strong>Проверка</strong>
            </span>
          </div>
        </div>

        <div className="im-body">
          {step === 1 ? (
            <section className="im-screen">
              {status === "ready" ? (
                <>
                  <div className="im-file-card">
                    <div className="im-file-main">
                      <div className="im-file-icon">{fileFormat.toUpperCase()}</div>
                      <div className="im-file-copy">
                        <strong title={fileName}>{fileName}</strong>
                        <span>
                          {summary.count} {pluralRu(summary.count, OPERATION_FORMS)} ·{" "}
                          {formatDateRangeRu(summary.minDate, summary.maxDate)} · {fileCurrency}
                        </span>
                      </div>
                    </div>
                    <button className="im-link-button" type="button" onClick={resetFile}>
                      Заменить файл
                    </button>
                  </div>

                  <section className="im-section">
                    <div className="im-field">
                      <label htmlFor="importAccount">Импортировать в счёт</label>
                      <select
                        className="op-control"
                        id="importAccount"
                        value={accountId}
                        onChange={(event) => {
                          // Account changed → duplicate search and any per-row
                          // decisions from the previous account no longer apply.
                          setAccountId(event.target.value);
                          setExisting(null);
                          setDupFailed(false);
                          setDecisions({});
                        }}
                      >
                        <option value="">Выберите счёт</option>
                        {accounts.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · {item.currency}
                          </option>
                        ))}
                      </select>
                      <small>Все найденные операции будут созданы в выбранном счёте.</small>
                    </div>
                    {account && currencyMismatch ? (
                      <div className="im-banner warning">
                        Валюта выписки — {fileCurrency}, счёта — {account.currency}.
                      </div>
                    ) : account ? (
                      <div className="im-account-confirm">
                        ✓ Валюта счёта совпадает с валютой выписки: {fileCurrency}
                      </div>
                    ) : null}
                  </section>
                </>
              ) : status === "loading" ? (
                <div className="im-dropzone im-dropzone-state">
                  <div>
                    <div className="im-state-spinner" aria-hidden="true" />
                    <h3>Читаем выписку…</h3>
                  </div>
                </div>
              ) : status === "error" ? (
                <div className="im-dropzone im-dropzone-state">
                  <div>
                    <div className="im-upload-icon im-upload-icon-warn" aria-hidden="true">
                      !
                    </div>
                    <h3>Не удалось прочитать файл</h3>
                    <p>Попробуйте выбрать другой файл.</p>
                    <button
                      className="op-button primary"
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Выбрать файл
                    </button>
                  </div>
                </div>
              ) : status === "empty" ? (
                <div className="im-dropzone im-dropzone-state">
                  <div>
                    <div className="im-upload-icon im-upload-icon-warn" aria-hidden="true">
                      !
                    </div>
                    <h3>В выписке не найдено операций</h3>
                    <button
                      className="op-button primary"
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Выбрать файл
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className="im-dropzone"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    void handleFile(event.dataTransfer.files?.[0] ?? null);
                  }}
                >
                  <div>
                    <div className="im-upload-icon">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5M5 14.5V19h14v-4.5" />
                      </svg>
                    </div>
                    <h3>Перетащите сюда банковскую выписку</h3>
                    <p>или выберите файл на компьютере</p>
                    <button
                      className="op-button primary"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                    >
                      Выбрать файл
                    </button>
                    <div className="im-formats">PDF, CSV, TSV · до 20 МБ</div>
                    <div className="im-global-note">
                      Один файл выписки импортируется в один счёт. Система сама попробует
                      распознать дату, описание, сумму и тип каждой операции.
                    </div>
                  </div>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv,.txt,.pdf,text/csv,text/tab-separated-values,text/plain,application/pdf"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  event.target.value = "";
                  void handleFile(file);
                }}
              />
            </section>
          ) : null}

          {step === 2 ? (
            <section className="im-screen">
              <div className="im-mapping-intro">
                <h3>Проверьте сопоставление</h3>
                <p>Так данные из файла будут записаны в операции.</p>
              </div>

              <div className="im-mapping-list">
                {fileFormat === "pdf" ? (
                  <>
                    <ImportMapRowStatic
                      source="Date"
                      label="Дата"
                      example={firstOp?.date ? `«${dmy(firstOp.date)}»` : "—"}
                    />
                    <ImportMapRowStatic
                      source="Descriptions, Details"
                      label="Описание"
                      example={firstOp ? `«${firstOp.description}»` : "—"}
                    />
                    <ImportMapRowStatic
                      source="Withdrawal / Deposit"
                      label="Сумма и тип"
                      example={firstOp ? `«${formatAmountWithType(firstOp)}»` : "—"}
                      subline={typeStatsLine}
                    />
                  </>
                ) : analysis && columns ? (
                  <>
                    <ImportMapRowEditable
                      rowKey="date"
                      open={openEditor === "date"}
                      onToggle={() => setOpenEditor(openEditor === "date" ? null : "date")}
                      source={analysis.headers[columns.dateIndex] ?? "—"}
                      label="Дата"
                      example={firstOp?.date ? `«${dmy(firstOp.date)}»` : "—"}
                      headers={analysis.headers}
                      dataRow={analysis.dataRows[0] ?? []}
                      value={columns.dateIndex}
                      onChange={(index) => remapColumn({ dateIndex: index })}
                    />
                    <ImportMapRowEditable
                      rowKey="description"
                      open={openEditor === "description"}
                      onToggle={() =>
                        setOpenEditor(openEditor === "description" ? null : "description")
                      }
                      source={analysis.headers[columns.descriptionIndex] ?? "—"}
                      label="Описание"
                      example={firstOp ? `«${firstOp.description}»` : "—"}
                      headers={analysis.headers}
                      dataRow={analysis.dataRows[0] ?? []}
                      value={columns.descriptionIndex}
                      onChange={(index) => remapColumn({ descriptionIndex: index })}
                    />
                    <ImportMapRowEditable
                      rowKey="amount"
                      open={openEditor === "amount"}
                      onToggle={() => setOpenEditor(openEditor === "amount" ? null : "amount")}
                      source={analysis.headers[columns.amountIndex] ?? "—"}
                      label="Сумма и тип"
                      example={firstOp ? `«${formatAmountWithType(firstOp)}»` : "—"}
                      subline={typeStatsLine}
                      headers={analysis.headers}
                      dataRow={analysis.dataRows[0] ?? []}
                      value={columns.amountIndex}
                      onChange={(index) => remapColumn({ amountIndex: index })}
                    />
                  </>
                ) : null}
              </div>

              {summary.feeCount > 0 ? (
                <div className="im-fee-note">
                  <strong>
                    {summary.feeCount === 1
                      ? `Найдена 1 комиссия на сумму ${formatMoney(summary.feeTotalCents, fileCurrency)}.`
                      : `Найдены ${summary.feeCount} ${pluralRu(summary.feeCount, [
                          "комиссия",
                          "комиссии",
                          "комиссий",
                        ])} на общую сумму ${formatMoney(summary.feeTotalCents, fileCurrency)}.`}
                  </strong>{" "}
                  {summary.feeCount === 1
                    ? "Она будет импортирована как отдельный расход."
                    : "Они будут импортированы как отдельные расходы."}
                </div>
              ) : null}
            </section>
          ) : null}

          {step === 3 ? (
            <section className="im-screen im-review-screen">
              <div className="im-review-intro">
                <h3>Проверьте операции перед импортом</h3>
                <p>{introText}</p>
              </div>

              {problemOps.length > 0 ? (
                <div className="im-review-alert">
                  {unresolvedCount > 0 ? (
                    <>
                      <strong>
                        {unresolvedCount} {pluralRu(unresolvedCount, OPERATION_FORMS)}{" "}
                        {pluralRu(unresolvedCount, ["требует", "требуют", "требуют"])} проверки.
                      </strong>{" "}
                      Решите отмеченные вопросы перед импортом.
                    </>
                  ) : (
                    <>
                      <strong>Все вопросы решены.</strong> Операции готовы к импорту.
                    </>
                  )}
                </div>
              ) : null}

              <div className="im-preview">
                <div className="im-preview-head">
                  <div>Дата</div>
                  <div>Описание</div>
                  <div style={{ textAlign: "right" }}>Сумма</div>
                </div>
                <div className="im-review-rows">
                  {visibleReviewOps.map((op) =>
                    hasIssues(op) ? renderIssueBlock(op) : renderReviewRow(op)
                  )}
                </div>
              </div>

              <div className="im-summary-note">
                {allExcluded ? (
                  "Все операции исключены. Новые операции созданы не будут."
                ) : (
                  <>
                    {`Будут созданы ${summaryCount} ${pluralRu(
                      summaryCount,
                      OPERATION_FORMS
                    )} в счёте\u00A0`}
                    <strong>{account?.name ?? "—"}</strong>.
                  </>
                )}
              </div>
            </section>
          ) : null}
        </div>

        <footer className="im-footer">
          <div className="im-footer-left">
            {/* Step 3: only «Открыть полный список» (and only when total > 25).
                Steps 1–2: the «Файл: name» pill. Never both. Matches v34.1. */}
            {step === 3 ? (
              totalOps > 25 ? (
                <button className="im-link-button" type="button" onClick={() => setFullOpen(true)}>
                  Открыть полный список
                </button>
              ) : null
            ) : fileName && status === "ready" ? (
              <div className="im-file-pill">
                Файл: <strong>{fileName}</strong>
              </div>
            ) : null}
          </div>
          <div className="im-footer-right">
            {step > 1 ? (
              <button
                className="op-button"
                type="button"
                onClick={() => setStep((step - 1) as 1 | 2 | 3)}
              >
                Назад
              </button>
            ) : null}
            <button className="op-button" type="button" onClick={onClose}>
              Отмена
            </button>
            <button
              className="op-button primary"
              type="button"
              disabled={nextDisabled || submitting}
              title={step === 3 && unresolvedCount > 0 ? "Сначала решите все вопросы по операциям" : undefined}
              onClick={goNext}
            >
              {step === 3 ? (allExcluded ? "Завершить" : "Импортировать") : "Далее"}
            </button>
          </div>
        </footer>
      </section>

      {fullOpen ? (
        <div
          className="im-full-overlay open"
          onMouseDown={(event) => event.target === event.currentTarget && setFullOpen(false)}
        >
          <section
            className="im-full-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Все операции к импорту"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="im-full-header">
              <h2>Все операции к импорту · {totalOps}</h2>
              <button
                className="im-close"
                type="button"
                aria-label="Закрыть"
                onClick={() => setFullOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="im-full-toolbar">
              <input
                className="op-control"
                type="search"
                placeholder="Поиск по описанию"
                value={fullSearch}
                onChange={(event) => setFullSearch(event.target.value)}
              />
              <select
                className="op-control"
                aria-label="Фильтр операций"
                value={fullFilter}
                onChange={(event) =>
                  setFullFilter(event.target.value as "all" | "attention" | "expense" | "income")
                }
              >
                <option value="all">Все операции</option>
                <option value="attention">Требуют внимания</option>
                <option value="expense">Расходы</option>
                <option value="income">Поступления</option>
              </select>
            </div>
            <div className="im-full-body">
              <div className="im-full-table">
                <div className="im-full-head">
                  <div>Дата</div>
                  <div>Описание</div>
                  <div style={{ textAlign: "right" }}>Сумма</div>
                  <div>Статус</div>
                </div>
                <div>
                  {fullRows.map((op) => {
                    const attention = isUnresolved(op);
                    const date = effectiveDate(op);
                    return (
                      <div
                        className={`im-full-row${attention ? " attention" : ""}`}
                        key={op.sourceRowId}
                      >
                        <div>{date ? dmy(date) : "—"}</div>
                        <div>{op.description || "—"}</div>
                        <div className={`amount ${op.direction === "income" ? "income" : ""}`}>
                          {renderAmount(op)}
                        </div>
                        <div className={`im-full-status${attention ? " attention" : ""}`}>
                          {attention ? "Требует проверки" : "Готово"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <footer className="im-full-footer">
              <span>
                Показано {fullRows.length} из {totalOps}
              </span>
              <button className="op-button" type="button" onClick={() => setFullOpen(false)}>
                Готово
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

// A read-only mapping row (used for the fixed KBank PDF columns).
function ImportMapRowStatic({
  source,
  label,
  example,
  subline,
}: {
  source: string;
  label: string;
  example: string;
  subline?: string;
}) {
  return (
    <div className="im-map-row">
      <span className="im-map-check">✓</span>
      <span className="im-map-source">
        <code>{source}</code>
      </span>
      <span className="im-map-arrow">→</span>
      <span className="im-map-result">
        <strong>{label}:</strong>
        <span className="im-map-example">{example}</span>
        {subline ? <span className="im-map-subline">{subline}</span> : null}
      </span>
    </div>
  );
}

// An editable mapping row: «Изменить» reveals an inline column picker.
function ImportMapRowEditable({
  rowKey,
  open,
  onToggle,
  source,
  label,
  example,
  subline,
  headers,
  dataRow,
  value,
  onChange,
}: {
  rowKey: string;
  open: boolean;
  onToggle: () => void;
  source: string;
  label: string;
  example: string;
  subline?: string;
  headers: string[];
  dataRow: string[];
  value: number;
  onChange: (index: number) => void;
}) {
  return (
    <div className="im-map-row" data-map-row={rowKey}>
      <span className="im-map-check">✓</span>
      <span className="im-map-source">
        <code>{source}</code>
      </span>
      <span className="im-map-arrow">→</span>
      <span className="im-map-result">
        <strong>{label}:</strong>
        <span className="im-map-example">{example}</span>
        {subline ? <span className="im-map-subline">{subline}</span> : null}
      </span>
      <button className="im-map-edit" type="button" onClick={onToggle}>
        Изменить
      </button>
      {open ? (
        <div className="im-map-editor">
          <span className="im-map-editor-label">Выберите колонку файла</span>
          <div className="im-map-editor-controls">
            <select
              className="op-control"
              value={value}
              onChange={(event) => onChange(Number(event.target.value))}
            >
              {headers.map((header, index) => {
                const sample = (dataRow[index] ?? "").trim();
                return (
                  <option key={index} value={index}>
                    {header || `Колонка ${index + 1}`}
                    {sample ? ` — ${sample}` : ""}
                  </option>
                );
              })}
            </select>
            <button className="op-button" type="button" onClick={onToggle}>
              Готово
            </button>
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
  // Прогнозирование (budget forecast): persisted inputs from the API + the
  // Операции-overlay toggle (localStorage).
  const [regularPayments, setRegularPayments] = useState<RegularPayment[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [forecastOn, setForecastOn] = useState(false);
  // Draft inputs for the «Прогнозирование» section (goal + add/edit forms).
  const [goalDraft, setGoalDraft] = useState("");
  const emptyRegularDraft = {
    name: "",
    amount: "",
    currency: "",
    category: "",
    periodicity: "monthly",
    dayOfMonth: "1",
    month: "1",
    intervalMonths: "3",
    anchorMonth: "",
  };
  const [regularDraft, setRegularDraft] = useState(emptyRegularDraft);
  const [editingRegularId, setEditingRegularId] = useState<number | null>(null);
  const emptyLoanDraft = { name: "", amount: "", currency: "", direction: "owe", dueDate: "", notes: "" };
  const [loanDraft, setLoanDraft] = useState(emptyLoanDraft);
  const [editingLoanId, setEditingLoanId] = useState<number | null>(null);
  // Suggestions (Phase 2) + the keys the user dismissed (localStorage).
  const [regularSuggestions, setRegularSuggestions] = useState<RegularSuggestion[]>([]);
  const [loanSuggestions, setLoanSuggestions] = useState<LoanSuggestion[]>([]);
  const [dismissedRegulars, setDismissedRegulars] = useState<string[]>([]);
  const [dismissedLoans, setDismissedLoans] = useState<string[]>([]);
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
  // Historical view of a past period: account balances as of the period end
  // (null = loading or the period is current).
  const [endAccounts, setEndAccounts] = useState<Account[] | null>(null);

  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [query, setQuery] = useState("");
  const [operationScope, setOperationScope] = useState<OperationListScope>("period");
  const [typeFilter, setTypeFilter] = useState("all");
  // Category name, "Без категории" for uncategorized, "" = no filter.
  const [categoryFilter, setCategoryFilter] = useState("");
  // Show only rows marked «Требует внимания».
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const operationListFilterState = {
    query,
    accountId: selectedAccountId,
    type: typeFilter,
    category: categoryFilter,
    flaggedOnly,
  };
  const hasActiveListFilters = hasOperationListFilters(operationListFilterState);
  const historyScopeActive = shouldLoadOperationHistory(
    operationScope,
    operationListFilterState
  );
  const [loading, setLoading] = useState(true);
  const [metaError, setMetaError] = useState("");
  const [transactionsLoading, setTransactionsLoading] = useState(true);
  const [transactionsError, setTransactionsError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [compactMetricsVisible, setCompactMetricsVisible] = useState(false);
  const [rightStackOverflow, setRightStackOverflow] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [operationSort, setOperationSort] = useState<OperationSort>("date");
  const stickyToolsRef = useRef<HTMLDivElement>(null);
  const rightStackRef = useRef<HTMLDivElement>(null);
  const accountsPanelRef = useRef<HTMLElement>(null);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [viewedOverflowAccountIds, setViewedOverflowAccountIds] = useState<Set<number>>(
    () => new Set()
  );
  const [accountsPanelSessionReady, setAccountsPanelSessionReady] = useState(false);

  const [editingTransactionId, setEditingTransactionId] = useState<number | null>(null);
  // Phase 1 operation forms and the pre-existing statement import have
  // separate dialogs. Import behavior remains unchanged and out of scope.
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [transactionForm, setTransactionForm] = useState<TransactionForm>({
    accountId: "",
    date: today(),
    direction: "expense",
    amount: "",
    description: "",
    descriptionIn: "",
    category: "",
    toAccountId: "",
    amountIn: "",
    flagged: false,
    notes: "",
  });
  const [additionalFieldsOpen, setAdditionalFieldsOpen] = useState(false);
  const [descriptionSuggestions, setDescriptionSuggestions] = useState<DescriptionSuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [autoCategoryApplied, setAutoCategoryApplied] = useState(false);
  const [submitMode, setSubmitMode] = useState<"close" | "more">("close");
  const transactionDialogRef = useRef<HTMLDivElement>(null);
  const [formReturnFocusKey, setFormReturnFocusKey] = useState("add-operation");
  const transactionFormRef = useRef(transactionForm);
  const [initialTransactionForm, setInitialTransactionForm] = useState(transactionForm);
  const [deleteTransactionTarget, setDeleteTransactionTarget] = useState<Transaction | null>(null);
  // Pick-a-partner flow (edit modal, type «Перемещение»): opposite-sign
  // candidates around the edited operation's date, and the chosen partner.
  const [partnerCandidates, setPartnerCandidates] = useState<Transaction[] | null>(null);
  const [partnerId, setPartnerId] = useState("");
  const [editingTransferPair, setEditingTransferPair] = useState<{
    out: Transaction;
    incoming: Transaction;
  } | null>(null);
  const [transferPairLoading, setTransferPairLoading] = useState(false);
  const [unlinkTransferPair, setUnlinkTransferPair] = useState<{
    out: Transaction;
    incoming: Transaction;
  } | null>(null);
  // Inline creation of a missing partner right inside the picker.
  const [partnerCreate, setPartnerCreate] = useState({
    open: false,
    accountId: "",
    amount: "",
    date: "",
    description: "",
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
  const detectDialogRef = useRef<HTMLElement>(null);

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

  const loadForecastData = useCallback(async () => {
    const [rp, ln, gl, rs, ls] = await Promise.all([
      requestJson<{ regularPayments: RegularPayment[] }>("/api/regular-payments"),
      requestJson<{ loans: Loan[] }>("/api/loans"),
      requestJson<{ goals: Goal[] }>("/api/goals"),
      requestJson<{ suggestions: RegularSuggestion[] }>("/api/regular-payments/suggest").catch(
        () => ({ suggestions: [] as RegularSuggestion[] })
      ),
      requestJson<{ suggestions: LoanSuggestion[] }>("/api/loans/suggest").catch(
        () => ({ suggestions: [] as LoanSuggestion[] })
      ),
    ]);
    setRegularPayments(rp.regularPayments);
    setLoans(ln.loans);
    setGoals(gl.goals);
    setRegularSuggestions(rs.suggestions);
    setLoanSuggestions(ls.suggestions);
  }, []);

  const loadPeriods = useCallback(async () => {
    const data = await requestJson<{ periods: string[]; currentMonth?: string }>(
      "/api/periods"
    );
    setPeriods(data.periods);
    setServerMonth(data.currentMonth ?? "");
  }, []);

  const loadTransactions = useCallback(async () => {
    setTransactionsLoading(true);
    setTransactionsError("");
    try {
      const { from, to } = monthBounds(mainPeriod);
      const periodBase = new URLSearchParams({ from, to, limit: "500" });
      // Prototype v34 expands the LIST to all history only when the user has
      // actually entered a query or enabled a filter. The cards/right rail
      // remain tied to the selected month, so they always use periodBase.
      const listBase = historyScopeActive
        ? new URLSearchParams({ limit: "500" })
        : new URLSearchParams(periodBase);
      const filtered = new URLSearchParams(listBase);
      if (selectedAccountId !== "all") filtered.set("accountId", selectedAccountId);
      // Text search is applied CLIENT-side (see searchedTransactions): SQLite's
      // LOWER()/LIKE only case-fold ASCII, so a Cyrillic query never matched a
      // capitalized word. JS toLowerCase() handles Unicode correctly.
      if (typeFilter !== "all") filtered.set("type", typeFilter);
      if (categoryFilter) filtered.set("category", categoryFilter);
      if (flaggedOnly) filtered.set("flagged", "1");
      const needsSeparatePeriodData =
        historyScopeActive || filtered.toString() !== periodBase.toString();

      const data = await requestJson<{ transactions: Transaction[] }>(
        `/api/transactions?${filtered.toString()}`
      );
      setTransactions(data.transactions);
      // One request when no filters are active; a second, unfiltered one
      // otherwise so the analytics keep covering the whole month.
      if (needsSeparatePeriodData) {
        const full = await requestJson<{ transactions: Transaction[] }>(
          `/api/transactions?${periodBase.toString()}`
        );
        setPeriodTransactions(full.transactions);
      } else {
        setPeriodTransactions(data.transactions);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось загрузить операции";
      setTransactions([]);
      setPeriodTransactions([]);
      setTransactionsError(message);
    } finally {
      setTransactionsLoading(false);
    }
  }, [mainPeriod, selectedAccountId, typeFilter, categoryFilter, flaggedOnly, historyScopeActive]);

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
      loadForecastData(),
    ]);
  }, [loadAccounts, loadCategories, loadRules, loadCurrencies, loadPeriods, loadForecastData]);

  const loadMetadata = useCallback(async () => {
    setLoading(true);
    setMetaError("");
    try {
      await reloadMeta();
    } catch (error) {
      setMetaError(error instanceof Error ? error.message : "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  }, [reloadMeta]);

  useEffect(() => {
    void (async () => {
      try {
        await reloadMeta();
      } catch (error) {
        setMetaError(error instanceof Error ? error.message : "Не удалось загрузить данные");
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
      if (!(event.target as Element | null)?.closest(".p1RowMenuWrap")) setRowMenu(null);
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

  useEffect(() => {
    if (!filtersOpen && !sortOpen && !addMenuOpen) return;
    const closeMenus = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest(".phase1MenuRoot")) return;
      setFiltersOpen(false);
      setSortOpen(false);
      setAddMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFiltersOpen(false);
      setSortOpen(false);
      setAddMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [filtersOpen, sortOpen, addMenuOpen]);

  useEffect(() => {
    transactionFormRef.current = transactionForm;
  }, [transactionForm]);

  // While the modal is open: trap focus, lock background scrolling and only
  // let Escape close a pristine form (so keyboard use never discards edits).
  useEffect(() => {
    if (!formOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const unchanged =
          JSON.stringify(transactionFormRef.current) ===
          JSON.stringify(initialTransactionForm);
        if (unchanged) {
          setFormOpen(false);
          setEditingTransactionId(null);
        }
        return;
      }
      if (event.key === "Tab") {
        const focusable = [...(transactionDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? [])].filter((element) => element.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      transactionDialogRef.current
        ?.querySelector<HTMLElement>(
          '[data-autofocus], .operationSegments button[aria-pressed="true"], .p1DateFieldFace, select, input, button'
        )
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      document
        .querySelector<HTMLElement>(`[data-focus-key="${formReturnFocusKey}"]`)
        ?.focus();
    };
  }, [formOpen, formReturnFocusKey, initialTransactionForm]);

  useEffect(() => {
    if (!detectOpen) return;
    const returnFocus = document.activeElement as HTMLElement | null;
    const dialog = detectDialogRef.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetectOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() =>
      dialog?.querySelector<HTMLElement>(".p1DialogClose")?.focus()
    );
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [detectOpen]);

  useEffect(() => {
    if (!deleteTransactionTarget && !unlinkTransferPair) return;
    const returnFocus = document.activeElement as HTMLElement | null;
    const selector = deleteTransactionTarget
      ? `[data-focus-key="tx-${deleteTransactionTarget.id}"]`
      : unlinkTransferPair?.out.transferGroup
        ? `[data-focus-key="transfer-${unlinkTransferPair.out.transferGroup}"]`
        : "";
    const dialog = document.querySelector<HTMLElement>(".confirmOverlay .confirmDialog");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDeleteTransactionTarget(null);
        setUnlinkTransferPair(null);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => dialog?.querySelector<HTMLElement>("button")?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      if (returnFocus?.isConnected) returnFocus.focus();
      else if (selector) document.querySelector<HTMLElement>(selector)?.focus();
    };
  }, [deleteTransactionTarget, unlinkTransferPair]);

  useEffect(() => {
    if (activeTab !== "main") return;
    const update = () => {
      const toolsTop = stickyToolsRef.current?.getBoundingClientRect().top;
      // The trigger point is the compact bar's actual height (--metrics-h),
      // not a hardcoded twin of it — the CSS token stays the single source.
      const threshold = readCssVarPx("--metrics-h", 58) + 1;
      setCompactMetricsVisible(toolsTop != null && toolsTop <= threshold);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [activeTab, forecastOn, mainPeriod, loading, transactionsLoading]);

  // §2.2 of the reference behavior: the right cards stack sticks only while it
  // fits the viewport. When it grows taller (accounts expanded, chart legend,
  // small window), sticky turns off and the stack flows with the page — never
  // an inner scrollbar. Measured live: ResizeObserver reacts to content
  // changes, the resize listener to viewport changes.
  useEffect(() => {
    if (activeTab !== "main") return;
    const stack = rightStackRef.current;
    if (!stack) return;
    const update = () => {
      const metricsH = readCssVarPx("--metrics-h", 58);
      const top = (compactMetricsVisible ? metricsH : 0) + 10;
      const bottomReserve = 12;
      setRightStackOverflow(
        stack.scrollHeight + top + bottomReserve > window.innerHeight
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(stack);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeTab, compactMetricsVisible, loading]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        setAccountsExpanded(window.sessionStorage.getItem("mc.accountsExpanded") === "true");
        const storedIds = JSON.parse(
          window.sessionStorage.getItem("mc.viewedOverflowAccountIds") ?? "[]"
        ) as unknown;
        if (Array.isArray(storedIds)) {
          setViewedOverflowAccountIds(
            new Set(storedIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))
          );
        }
      } catch {
        // Session storage is an enhancement; the panel still works without it.
      } finally {
        setAccountsPanelSessionReady(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!accountsPanelSessionReady) return;
    try {
      window.sessionStorage.setItem("mc.accountsExpanded", String(accountsExpanded));
      window.sessionStorage.setItem(
        "mc.viewedOverflowAccountIds",
        JSON.stringify([...viewedOverflowAccountIds])
      );
    } catch {
      // Keep the in-memory session state when storage is unavailable.
    }
  }, [accountsExpanded, viewedOverflowAccountIds, accountsPanelSessionReady]);

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

  const categoryDonutItems = useMemo(
    () =>
      [
        ...categoryBars.items,
        ...(categoryBars.uncategorized ? [categoryBars.uncategorized] : []),
      ].map((item) => ({ label: item.label, cents: item.cents, color: item.color })),
    [categoryBars]
  );

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
      setPartnerCreate({ open: false, accountId: "", amount: "", date: "", description: "" });
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

  useEffect(() => {
    let cancelled = false;
    const group = editingTransaction?.transferGroup;
    if (!formOpen || transactionForm.direction !== "transfer" || !group) {
      return;
    }
    void (async () => {
      setTransferPairLoading(true);
      try {
        const data = await requestJson<{ transactions: Transaction[] }>(
          `/api/transfers?group=${encodeURIComponent(group)}`
        );
        if (cancelled) return;
        const out = data.transactions.find((transaction) => transaction.amountCents < 0);
        const incoming = data.transactions.find((transaction) => transaction.amountCents > 0);
        if (!out || !incoming) return;
        const notes = [...new Set([out.notes.trim(), incoming.notes.trim()].filter(Boolean))].join("\n");
        const nextForm: TransactionForm = {
          accountId: String(out.accountId),
          date: out.date,
          direction: "transfer",
          amount: centsToInputValue(Math.abs(out.amountCents)),
          description: out.description,
          descriptionIn: incoming.description,
          category: "",
          toAccountId: String(incoming.accountId),
          amountIn: centsToInputValue(Math.abs(incoming.amountCents)),
          flagged: out.flagged || incoming.flagged,
          notes,
        };
        setEditingTransferPair({ out, incoming });
        setTransactionForm(nextForm);
        setInitialTransactionForm(nextForm);
        setAdditionalFieldsOpen(Boolean(nextForm.flagged || nextForm.notes));
      } catch (error) {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : "Не удалось загрузить перевод");
        }
      } finally {
        if (!cancelled) setTransferPairLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formOpen, editingTransaction, transactionForm.direction]);

  useEffect(() => {
    let cancelled = false;
    const query = transactionForm.description.trim();
    const ordinary = transactionForm.direction !== "transfer";
    const timer = window.setTimeout(() => {
      void (async () => {
        if (!formOpen || !ordinary || [...query].length < 2) {
          if (!cancelled) {
            setDescriptionSuggestions([]);
            setSuggestionsOpen(false);
          }
          return;
        }
        try {
          const data = await requestJson<{ suggestions: DescriptionSuggestion[] }>(
            `/api/transactions/suggestions?q=${encodeURIComponent(query)}`
          );
          if (!cancelled) {
            setDescriptionSuggestions(data.suggestions);
            setSuggestionsOpen(
              document.activeElement?.id === "operation-description" &&
                data.suggestions.length > 0
            );
          }
        } catch {
          if (!cancelled) {
            setDescriptionSuggestions([]);
            setSuggestionsOpen(false);
          }
        }
      })();
    }, [...query].length >= 2 ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [formOpen, transactionForm.description, transactionForm.direction]);

  // Auto-dismiss the confirmation/status toast. The Phase 1 redesign turned the
  // inline notice into a floating «p1Toast» but never cleared it, so it lingered
  // on screen indefinitely after every save/edit.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

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
    const viewStart = `${mainPeriod}-01`;
    const viewEnd = monthEnd(mainPeriod);
    return source.filter((account) => accountInPeriod(account, viewStart, viewEnd));
  }, [pastPeriod, endAccounts, accounts, mainPeriod]);
  const panelAccountSelection = useMemo(
    () => selectAccountPanelItems(panelAccounts, accountsExpanded, viewedOverflowAccountIds),
    [panelAccounts, accountsExpanded, viewedOverflowAccountIds]
  );

  // Keep a promoted unseen negative account in the current view. Once the user
  // leaves that period/section (or expands the list), the alert has been seen
  // and the configured account order becomes stable again for the session.
  useEffect(() => {
    const promotedId = panelAccountSelection.promoted?.id;
    if (!promotedId) return;
    return () => {
      setViewedOverflowAccountIds((current) => {
        if (current.has(promotedId)) return current;
        const next = new Set(current);
        next.add(promotedId);
        return next;
      });
    };
  }, [activeTab, mainPeriod, panelAccountSelection.promoted?.id]);
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

  // ── Прогнозирование ────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      const v = window.localStorage.getItem("mc.forecastOn");
      if (v != null) setForecastOn(v === "1");
      const parseList = (key: string): string[] => {
        try {
          const raw = window.localStorage.getItem(key);
          const parsed = raw ? JSON.parse(raw) : null;
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      };
      setDismissedRegulars(parseList("mc.dismissedRegulars"));
      setDismissedLoans(parseList("mc.dismissedLoans"));
    })();
  }, []);
  useEffect(() => {
    window.localStorage.setItem("mc.forecastOn", forecastOn ? "1" : "0");
  }, [forecastOn]);
  useEffect(() => {
    window.localStorage.setItem("mc.dismissedRegulars", JSON.stringify(dismissedRegulars));
  }, [dismissedRegulars]);
  useEffect(() => {
    window.localStorage.setItem("mc.dismissedLoans", JSON.stringify(dismissedLoans));
  }, [dismissedLoans]);

  // Forecast is computed for the current month only (past = historical view).
  const forecastAvailable = mainPeriod === currentMonth && Boolean(displayCurrency);
  const currentGoal = goals.find((g) => g.month === mainPeriod) ?? null;

  // Per-day expense totals (whole month, filter-independent) for the day headers.
  const perDayExpenseCents = useMemo(() => {
    const map: Record<string, number> = {};
    if (!displayCurrency) return map;
    for (const tx of periodTransactions) {
      if (tx.amountCents >= 0 || tx.transferGroup) continue;
      let cents: number | null;
      if (tx.accountCurrency === displayCurrency) cents = Math.abs(tx.amountCents);
      else {
        const rTo = periodRates?.[displayCurrency];
        const rFrom = periodRates?.[tx.accountCurrency];
        cents = rTo != null && rFrom != null ? Math.round((Math.abs(tx.amountCents) * rTo) / rFrom) : null;
      }
      if (cents == null) continue;
      map[tx.date] = (map[tx.date] ?? 0) + cents;
    }
    return map;
  }, [periodTransactions, periodRates, displayCurrency]);

  const forecastResult = useMemo<ForecastResult | null>(() => {
    if (!forecastAvailable || !periodRates) return null;
    const rates = periodRates;
    const toDisplay = (cents: number, currency: string): number | null => {
      if (currency === displayCurrency) return cents;
      const rTo = rates[displayCurrency];
      const rFrom = rates[currency];
      return rTo != null && rFrom != null ? Math.round((cents * rTo) / rFrom) : null;
    };
    const goalCents = currentGoal ? toDisplay(currentGoal.amountCents, currentGoal.currency) ?? 0 : 0;
    return forecastMonth({
      month: mainPeriod,
      today: today(),
      incomeCents: incomeConverted.cents,
      expenseCents: expenseConverted.cents,
      goalCents,
      regularPayments,
      loans,
      toDisplay,
    });
  }, [
    forecastAvailable,
    periodRates,
    displayCurrency,
    mainPeriod,
    incomeConverted,
    expenseConverted,
    currentGoal,
    regularPayments,
    loans,
  ]);
  const forecastOverlay = forecastOn && forecastResult !== null ? forecastResult : null;
  const forecastVisible = forecastOn && forecastAvailable;

  // Keep the goal input synced to the stored goal for the viewed month —
  // CONVERTED into the current display currency so the field matches the
  // «Таргет» card and a re-save persists a consistent amount+currency. Re-runs
  // on a display-currency / rate change too. IIFE so setState isn't called
  // synchronously in the effect body.
  useEffect(() => {
    void (async () => {
      if (!currentGoal) {
        setGoalDraft("");
        return;
      }
      let cents = currentGoal.amountCents;
      if (currentGoal.currency !== displayCurrency) {
        const rTo = periodRates?.[displayCurrency];
        const rFrom = periodRates?.[currentGoal.currency];
        if (rTo != null && rFrom != null) cents = Math.round((cents * rTo) / rFrom);
      }
      setGoalDraft(centsToInputValue(cents));
    })();
  }, [currentGoal, displayCurrency, periodRates]);

  const saveGoal = async () => {
    if (!displayCurrency) return;
    const amountCents = goalDraft.trim() ? parseMoneyInputToCents(goalDraft) : 0;
    if (amountCents === null || amountCents < 0) {
      setNotice("Некорректная сумма цели");
      return;
    }
    try {
      await requestJson("/api/goals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: mainPeriod, amountCents, currency: displayCurrency }),
      });
      await loadForecastData();
      setNotice("Цель сохранена");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Цель не сохранена");
    }
  };

  const resetRegularForm = () => {
    setRegularDraft(emptyRegularDraft);
    setEditingRegularId(null);
  };

  const saveRegular = async () => {
    const amountCents = parseMoneyInputToCents(regularDraft.amount);
    if (!regularDraft.name.trim() || amountCents === null || amountCents <= 0) {
      setNotice("Укажите название и сумму регулярного платежа");
      return;
    }
    const body = {
      id: editingRegularId ?? undefined,
      name: regularDraft.name.trim(),
      amountCents,
      currency: regularDraft.currency || displayCurrency,
      category: regularDraft.category.trim(),
      periodicity: regularDraft.periodicity,
      dayOfMonth: Number(regularDraft.dayOfMonth) || 1,
      month: Number(regularDraft.month) || 1,
      intervalMonths: Number(regularDraft.intervalMonths) || 3,
      anchorMonth: regularDraft.anchorMonth || mainPeriod,
    };
    try {
      await requestJson("/api/regular-payments", {
        method: editingRegularId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await loadForecastData();
      resetRegularForm();
      setNotice(editingRegularId ? "Регулярный платёж обновлён" : "Регулярный платёж добавлен");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Платёж не сохранён");
    }
  };

  const startEditRegular = (rp: RegularPayment) => {
    setEditingRegularId(rp.id);
    setRegularDraft({
      name: rp.name,
      amount: centsToInputValue(rp.amountCents),
      currency: rp.currency,
      category: rp.category,
      periodicity: rp.periodicity,
      dayOfMonth: String(rp.dayOfMonth),
      month: String(rp.month ?? 1),
      intervalMonths: String(rp.intervalMonths ?? 3),
      anchorMonth: rp.anchorMonth ?? "",
    });
  };

  const acceptRegularSuggestion = async (sug: RegularSuggestion) => {
    try {
      await requestJson("/api/regular-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sug.name,
          amountCents: sug.amountCents,
          currency: sug.currency,
          category: sug.category,
          periodicity: sug.periodicity,
          dayOfMonth: sug.dayOfMonth,
          source: "suggested",
        }),
      });
      await loadForecastData();
      setNotice("Добавлено в регулярные");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось добавить");
    }
  };

  const removeRegular = async (id: number) => {
    if (!window.confirm("Удалить регулярный платёж?")) return;
    try {
      await requestJson(`/api/regular-payments?id=${id}`, { method: "DELETE" });
      await loadForecastData();
      if (editingRegularId === id) resetRegularForm();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось удалить");
    }
  };

  const resetLoanForm = () => {
    setLoanDraft(emptyLoanDraft);
    setEditingLoanId(null);
  };

  const saveLoan = async () => {
    const amountCents = parseMoneyInputToCents(loanDraft.amount);
    if (!loanDraft.name.trim() || amountCents === null || amountCents <= 0 || !loanDraft.dueDate) {
      setNotice("Укажите название, сумму и дату займа");
      return;
    }
    try {
      await requestJson("/api/loans", {
        method: editingLoanId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingLoanId ?? undefined,
          name: loanDraft.name.trim(),
          amountCents,
          currency: loanDraft.currency || displayCurrency,
          direction: loanDraft.direction,
          dueDate: loanDraft.dueDate,
          notes: loanDraft.notes.trim(),
        }),
      });
      await loadForecastData();
      resetLoanForm();
      setNotice(editingLoanId ? "Заём обновлён" : "Заём добавлен");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Заём не сохранён");
    }
  };

  const startEditLoan = (loan: Loan) => {
    setEditingLoanId(loan.id);
    setLoanDraft({
      name: loan.name,
      amount: centsToInputValue(loan.amountCents),
      currency: loan.currency,
      direction: loan.direction,
      dueDate: loan.dueDate,
      notes: loan.notes,
    });
  };

  // Loan suggestions need a due date, so «accept» pre-fills the add form rather
  // than creating directly — the user sets the date and saves.
  const acceptLoanSuggestion = (sug: LoanSuggestion) => {
    setEditingLoanId(null);
    setLoanDraft({
      name: sug.name,
      amount: centsToInputValue(sug.amountCents),
      currency: sug.currency,
      direction: sug.direction,
      dueDate: "",
      notes: "",
    });
    setNotice("Укажи дату и сохрани заём");
  };

  const removeLoan = async (id: number) => {
    if (!window.confirm("Удалить заём?")) return;
    try {
      await requestJson(`/api/loans?id=${id}`, { method: "DELETE" });
      await loadForecastData();
      if (editingLoanId === id) resetLoanForm();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось удалить");
    }
  };

  const loanSuggestionKey = (s: LoanSuggestion) =>
    `${s.name}|${s.amountCents}|${s.currency}|${s.sourceDate}`;
  const visibleRegularSuggestions = regularSuggestions.filter((s) => !dismissedRegulars.includes(s.key));
  const visibleLoanSuggestions = loanSuggestions.filter((s) => !dismissedLoans.includes(loanSuggestionKey(s)));

  // ── /Прогнозирование ───────────────────────────────────────────────────────

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

  // Text search runs CLIENT-side (SQLite LIKE/LOWER only case-fold ASCII, so a
  // Cyrillic query silently failed to match a capitalized word). The list is one
  // month (≤500 rows), so a Unicode-correct substring filter is instant.
  const searchedTransactions = useMemo(() => {
    const qq = query.trim().toLowerCase();
    if (!qq) return transactions;
    return transactions.filter(
      (t) =>
        (t.description ?? "").toLowerCase().includes(qq) ||
        (t.category ?? "").toLowerCase().includes(qq) ||
        (t.payee ?? "").toLowerCase().includes(qq) ||
        (t.accountName ?? "").toLowerCase().includes(qq)
    );
  }, [transactions, query]);

  // Collapse the two legs of a transfer into one production row. A leg's partner
  // can be absent from the filtered list — an account filter keeps only the leg
  // on the selected account, and a type/flag filter or the text search can hide
  // one side too — so partners are also looked up in the whole-month dataset
  // (periodTransactions). A transfer therefore always renders in its normal
  // «SRC → DST» shape instead of degrading to a lone leg. A lone «⇄» row only
  // survives when the partner is genuinely outside loaded data (e.g. the
  // all-history view spanning a month periodTransactions does not cover).
  const displayRows = useMemo(() => {
    const legsByGroup = new Map<string, Map<number, Transaction>>();
    const indexLeg = (tx: Transaction) => {
      if (!tx.transferGroup) return;
      const legs = legsByGroup.get(tx.transferGroup) ?? new Map<number, Transaction>();
      if (!legs.has(tx.id)) legs.set(tx.id, tx);
      legsByGroup.set(tx.transferGroup, legs);
    };
    // Index the visible legs first so a collapsed row prefers the list's own
    // object, then fold in whole-month legs as partner fallbacks.
    for (const tx of searchedTransactions) indexLeg(tx);
    for (const tx of periodTransactions) indexLeg(tx);
    const placed = new Set<string>();
    const rows: DisplayRow[] = [];
    for (const tx of searchedTransactions) {
      let row: DisplayRow | null = null;
      if (tx.transferGroup) {
        if (placed.has(tx.transferGroup)) continue;
        const partner = [...(legsByGroup.get(tx.transferGroup)?.values() ?? [])].find(
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
      rows.push(row);
    }
    return rows.sort((a, b) => {
      const aTx = a.kind === "transfer" ? a.out : a.tx;
      const bTx = b.kind === "transfer" ? b.out : b.tx;
      return bTx.date.localeCompare(aTx.date) || bTx.id - aTx.id;
    });
  }, [searchedTransactions, periodTransactions]);

  const dayGroups = useMemo(() => {
    return groupOperationItemsByDate(
      displayRows,
      (row) => (row.kind === "transfer" ? row.out : row.tx).date
    );
  }, [displayRows]);

  const historyYearGroups = useMemo(() => {
    return groupOperationItemsByYear(
      displayRows,
      (row) => (row.kind === "transfer" ? row.out : row.tx).date
    );
  }, [displayRows]);

  const amountForSort = useCallback(
    (row: DisplayRow) => {
      const transaction = row.kind === "transfer" ? row.out : row.tx;
      const cents = Math.abs(transaction.amountCents);
      if (!displayCurrency || transaction.accountCurrency === displayCurrency) return cents;
      const rateTo = periodRates?.[displayCurrency];
      const rateFrom = periodRates?.[transaction.accountCurrency];
      return rateTo != null && rateFrom != null ? Math.round((cents * rateTo) / rateFrom) : cents;
    },
    [displayCurrency, periodRates]
  );

  const sortedOperationRows = useMemo(() => {
    return sortOperationItems(displayRows, operationSort, (row) => {
      const transaction = row.kind === "transfer" ? row.out : row.tx;
      return {
        amountCents: amountForSort(row),
        date: transaction.date,
        id: transaction.id,
      };
    });
  }, [displayRows, operationSort, amountForSort]);

  // The account-currency amount in its own column, next to the display-currency
  // "Сумма". Empty when the account currency already equals the display
  // currency, since the display column then shows the same value.
  const renderAccountAmount = (transaction: Transaction): ReactNode => {
    const account = transaction.accountCurrency;
    if (!displayCurrency || account === displayCurrency) return null;
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

  // One selector supplies every create/edit account dropdown and the matching
  // validation. Inactive accounts are absent from options rather than rendered
  // as disabled rows.
  const operationAccountOptions = useMemo(
    () => selectActiveAccountsOn(accounts, transactionForm.date || today()),
    [accounts, transactionForm.date]
  );
  const partnerAccountOptions = useMemo(
    () => selectActiveAccountsOn(accounts, partnerCreate.date || today()),
    [accounts, partnerCreate.date]
  );

  const transactionAccountInvalid = Boolean(
    transactionForm.accountId &&
      !operationAccountOptions.some(
        (account) => String(account.id) === transactionForm.accountId
      )
  );
  const transferToAccountInvalid = Boolean(
    transactionForm.toAccountId &&
      !operationAccountOptions.some(
        (account) => String(account.id) === transactionForm.toAccountId
      )
  );
  const partnerAccountInvalid = Boolean(
    partnerCreate.accountId &&
      (!partnerAccountOptions.some(
        (account) => String(account.id) === partnerCreate.accountId
      ) ||
        partnerCreate.accountId === transactionForm.accountId)
  );
  const transferFromAccount = accounts.find(
    (account) => String(account.id) === transactionForm.accountId
  );
  const transferToAccount = accounts.find(
    (account) => String(account.id) === transactionForm.toAccountId
  );
  const transferCrossCurrency = Boolean(
    transferFromAccount &&
      transferToAccount &&
      transferFromAccount.currency !== transferToAccount.currency
  );

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

  // --- mutations ------------------------------------------------------------
  async function handleSubmitTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      if (transactionAccountInvalid || transferToAccountInvalid) {
        setNotice("Этот счёт недоступен на выбранную дату. Выберите другой счёт.");
        return;
      }
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
              descriptionIn: transactionForm.descriptionIn,
              notes: transactionForm.notes,
              flagged: transactionForm.flagged,
            },
          }),
        });
        setNotice("Перевод добавлен");
      } else if (
        editingTransactionId &&
        transactionForm.direction === "transfer" &&
        editingTransaction?.transferGroup
      ) {
        await requestJson("/api/transfers", {
          method: "PATCH",
          body: JSON.stringify({
            group: editingTransaction.transferGroup,
            date: transactionForm.date,
            fromAccountId: transactionForm.accountId,
            toAccountId: transactionForm.toAccountId,
            amount: transactionForm.amount,
            amountIn: transactionForm.amountIn,
            description: transactionForm.description,
            descriptionIn: transactionForm.descriptionIn,
            notes: transactionForm.notes,
            flagged: transactionForm.flagged,
          }),
        });
        setNotice("Перевод обновлён");
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
        if (
          transactionForm.notes !== editingTransaction.notes ||
          transactionForm.flagged !== editingTransaction.flagged
        ) {
          await requestJson(`/api/transactions?id=${editingTransaction.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              notes: transactionForm.notes,
              flagged: transactionForm.flagged,
            }),
          });
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
      const keepOpen =
        !editingTransactionId &&
        transactionForm.direction !== "transfer" &&
        submitMode === "more";
      const nextForm: TransactionForm = keepOpen
        ? {
            ...transactionForm,
            amount: "",
            description: "",
            descriptionIn: "",
            category: "",
            flagged: false,
            notes: "",
          }
        : {
            accountId: "",
            date: today(),
            direction: "expense",
            amount: "",
            description: "",
            descriptionIn: "",
            category: "",
            toAccountId: "",
            amountIn: "",
            flagged: false,
            notes: "",
          };
      setEditingTransactionId(null);
      setFormOpen(keepOpen);
      setTransactionForm(nextForm);
      setInitialTransactionForm(nextForm);
      setAdditionalFieldsOpen(false);
      setAutoCategoryApplied(false);
      setDescriptionSuggestions([]);
      setSuggestionsOpen(false);
      setSubmitMode("close");
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
    setFormReturnFocusKey("add-operation");
    setEditingTransactionId(null);
    const nextForm: TransactionForm = {
      accountId: "",
      date: today(),
      direction: "expense",
      amount: "",
      description: "",
      descriptionIn: "",
      category: "",
      toAccountId: "",
      amountIn: "",
      flagged: false,
      notes: "",
    };
    setTransactionForm(nextForm);
    setInitialTransactionForm(nextForm);
    setAdditionalFieldsOpen(false);
    setEditingTransferPair(null);
    setAutoCategoryApplied(false);
    setSubmitMode("close");
    setFormOpen(true);
  }

  function openImport() {
    setAddMenuOpen(false);
    setImportOpen(true);
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
      descriptionIn: "",
      category: "",
      toAccountId: "",
      amountIn: "",
      flagged: false,
      notes: "",
    });
    setAdditionalFieldsOpen(false);
    setAutoCategoryApplied(false);
    setDescriptionSuggestions([]);
    setSuggestionsOpen(false);
    setEditingTransferPair(null);
  }

  function startEditTransaction(transaction: Transaction, focusKey = `tx-${transaction.id}`) {
    setFormReturnFocusKey(focusKey);
    setEditingTransactionId(transaction.id);
    const nextForm: TransactionForm = {
      accountId: String(transaction.accountId),
      date: transaction.date,
      direction: transaction.transferGroup
        ? "transfer"
        : transaction.amountCents < 0
          ? "expense"
          : "income",
      amount: centsToInputValue(Math.abs(transaction.amountCents)),
      description: transaction.description,
      descriptionIn: transaction.description,
      category: transaction.category,
      toAccountId: "",
      amountIn: "",
      flagged: transaction.flagged,
      notes: transaction.notes,
    };
    setTransactionForm(nextForm);
    setInitialTransactionForm(nextForm);
    setAdditionalFieldsOpen(Boolean(transaction.flagged || transaction.notes));
    setEditingTransferPair(null);
    setAutoCategoryApplied(false);
    setSubmitMode("close");
    setActiveTab("main");
    setFormOpen(true);
  }

  async function removeTransaction(transaction: Transaction) {
    setSaving(true);
    try {
      await requestJson(`/api/transactions?id=${transaction.id}`, { method: "DELETE" });
      setNotice("Операция удалена");
      setDeleteTransactionTarget(null);
      closeForm();
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Операция не удалена");
    } finally {
      setSaving(false);
    }
  }

  async function openUnlinkTransfer(
    group: string,
    pair?: { out: Transaction; incoming: Transaction }
  ) {
    if (pair) {
      setUnlinkTransferPair(pair);
      return;
    }
    try {
      const data = await requestJson<{ transactions: Transaction[] }>(
        `/api/transfers?group=${encodeURIComponent(group)}`
      );
      const out = data.transactions.find((transaction) => transaction.amountCents < 0);
      const incoming = data.transactions.find((transaction) => transaction.amountCents > 0);
      if (out && incoming) setUnlinkTransferPair({ out, incoming });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось загрузить перевод");
    }
  }

  // Split a transfer back into two ordinary operations. Notes and attention
  // from either side move to the debit leg in the API, so neither is lost.
  async function unlinkTransfer(group: string) {
    setSaving(true);
    try {
      await requestJson(`/api/transfers?group=${encodeURIComponent(group)}`, {
        method: "DELETE",
      });
      setNotice("Перемещение разъединено");
      setUnlinkTransferPair(null);
      closeForm();
      await refreshAfterMutation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось разъединить");
    } finally {
      setSaving(false);
    }
  }

  // Create the missing partner right from the picker and link the pair in one
  // go: the new operation gets the OPPOSITE sign of the edited one.
  async function createAndLinkPartner() {
    const tx = editingTransaction;
    if (!tx || !partnerCreate.accountId || !partnerCreate.amount) return;
    if (partnerAccountInvalid) {
      setNotice("Этот счёт недоступен на выбранную дату. Выберите другой счёт.");
      return;
    }
    setSaving(true);
    try {
      if (
        transactionForm.notes !== tx.notes ||
        transactionForm.flagged !== tx.flagged
      ) {
        await requestJson(`/api/transactions?id=${tx.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            notes: transactionForm.notes,
            flagged: transactionForm.flagged,
          }),
        });
      }
      const created = await requestJson<{ transaction: Transaction }>("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          accountId: partnerCreate.accountId,
          date: partnerCreate.date,
          amount: partnerCreate.amount,
          direction: tx.amountCents < 0 ? "income" : "expense",
          description: partnerCreate.description || tx.description || "Перевод",
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

  function resetListFilters() {
    setQuery("");
    setSelectedAccountId("all");
    setTypeFilter("all");
    setCategoryFilter("");
    setFlaggedOnly(false);
    setFiltersOpen(false);
  }

  function toggleRowMenu(event: ReactMouseEvent<HTMLButtonElement>, key: string) {
    const rect = event.currentTarget.getBoundingClientRect();
    setRowMenuUp(window.innerHeight - rect.bottom < 140);
    setRowMenuPos({
      right: Math.max(8, window.innerWidth - rect.right),
      top: rect.bottom + 4,
      bottom: window.innerHeight - rect.top + 4,
    });
    setRowMenu((current) => (current === key ? null : key));
  }

  const operationSortLabel =
    operationSort === "date"
      ? "Дата ↓"
      : operationSort === "amount-desc"
        ? "Сумма ↓"
        : "Сумма ↑";
  const historyDateMode = historyScopeActive && operationSort === "date";

  const operationModalTitle =
    transactionForm.direction === "transfer"
      ? editingTransaction?.transferGroup
        ? "Редактировать перевод"
        : editingTransactionId
          ? "Создать перевод"
          : "Новый перевод"
      : editingTransactionId
        ? transactionForm.direction === "income"
          ? "Редактировать поступление"
          : "Редактировать расход"
        : "Новая операция";

  function renderOperationRow(
    row: DisplayRow,
    showDate: boolean,
    showDateYear = false
  ) {
    const transaction = row.kind === "transfer" ? row.out : row.tx;
    // Transfers render through the explicit presentation model: the account
    // pair lives in the account column, the amount column holds money only,
    // and line visibility is decided by currencies alone (lib/phase1.ts).
    const transfer =
      row.kind === "transfer"
        ? buildTransferRowPresentation(row.out, row.incoming, displayCurrency)
        : null;
    const menuKey =
      row.kind === "transfer"
        ? `transfer-${row.out.transferGroup}`
        : `tx-${row.tx.id}`;
    const transferGroup =
      row.kind === "transfer" ? row.out.transferGroup : row.tx.transferGroup;
    const flagged =
      row.kind === "transfer"
        ? row.out.flagged || row.incoming.flagged
        : row.tx.flagged;
    const flagReason =
      row.kind === "transfer"
        ? row.out.notes || row.incoming.notes || "Требует внимания"
        : row.tx.notes || "Требует внимания";

    return (
      <tr
        className={`operationRow ${showDate ? "flat" : ""} ${
          row.kind === "transfer" ? "transfer" : ""
        } ${transfer?.showCredited ? "withDestination" : ""}`}
        key={menuKey}
      >
        {showDate ? (
          <td className="operationDate">
            {shortOperationDate(transaction.date, showDateYear)}
            {flagged ? <span className="p1MarkFlag" data-p1-tip={flagReason}>⚠</span> : null}
          </td>
        ) : (
          <td className="operationStatus">
            {row.kind === "tx" && transaction.transferGroup ? (
              <span className="p1MarkTransfer" data-p1-tip="Перевод между своими счетами">⇄</span>
            ) : null}
            {flagged ? <span className="p1MarkFlag" data-p1-tip={flagReason}>⚠</span> : null}
          </td>
        )}

        <td className="operationAccount">
          <ClampedName
            text={transfer ? transfer.accountLabel : transaction.accountName}
            phase1
          />
        </td>
        <td className="operationDescription">
          {transaction.description || "—"}
        </td>
        <td className="operationAmounts">
          <span
            className={`operationMainAmount ${
              row.kind === "tx" && transaction.amountCents > 0 && !transaction.transferGroup
                ? "income"
                : ""
            }`}
          >
            {row.kind === "tx" && transaction.amountCents > 0 && !transaction.transferGroup
              ? "+"
              : null}
            {renderDisplayAmount(transaction)}
          </span>
          {transfer ? (
            transfer.showDebitNative ? (
              <span className="operationLocalAmount">
                <Money
                  cents={transfer.debitAmountCents}
                  currency={transfer.debitCurrency}
                />
              </span>
            ) : null
          ) : (
            <span className="operationLocalAmount">{renderAccountAmount(transaction)}</span>
          )}
          {transfer?.showCredited ? (
            <span className="transferDestination">
              <span aria-hidden="true">→</span>
              <Money
                cents={transfer.creditAmountCents}
                currency={transfer.creditCurrency}
              />
            </span>
          ) : null}
        </td>
        <td className="operationCategory">
          {row.kind === "transfer" ? "" : transaction.category}
        </td>
        <td className="operationActions">
          <span className="p1RowMenuWrap">
            <button
              className="operationMenuButton"
              type="button"
              aria-label="Действия"
              aria-haspopup="menu"
              aria-expanded={rowMenu === menuKey}
              data-focus-key={menuKey}
              onClick={(event) => toggleRowMenu(event, menuKey)}
            >
              ⋮
            </button>
            {rowMenu === menuKey ? (
              <span
                className={`p1RowMenu ${rowMenuUp ? "up" : ""}`}
                role="menu"
                style={
                  rowMenuUp
                    ? { right: rowMenuPos?.right, bottom: rowMenuPos?.bottom }
                    : { right: rowMenuPos?.right, top: rowMenuPos?.top }
                }
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setRowMenu(null);
                    startEditTransaction(transaction, menuKey);
                  }}
                >
                  Править
                </button>
                {transferGroup ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setRowMenu(null);
                      void openUnlinkTransfer(
                        transferGroup,
                        row.kind === "transfer" ? { out: row.out, incoming: row.incoming } : undefined
                      );
                    }}
                  >
                    Разъединить
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      setRowMenu(null);
                      setDeleteTransactionTarget(transaction);
                    }}
                  >
                    Удалить
                  </button>
                )}
              </span>
            ) : null}
          </span>
        </td>
      </tr>
    );
  }

  // --- render ---------------------------------------------------------------
  const tabs: Array<{ id: PrimaryNavTab; label: string }> = [
    { id: "main", label: "Операции" },
    { id: "forecast", label: "Прогнозы" },
    { id: "charts", label: "Отчёты" },
    { id: "settings", label: "Настройки" },
  ];

  const phase1Active = activeTab === "main";

  return (
    <main className="p1AppShell">
      <aside className="p1Sidebar">
        <nav className="p1SidebarNav" aria-label="Разделы">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`p1NavButton ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              aria-label={tab.label}
              data-label={tab.label}
            >
              <span className="p1NavIcon">
                <NavIcon tab={tab.id} />
              </span>
              <span className="p1NavLabel">{tab.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="p1AppMain">
        {notice ? (
          <div className={phase1Active ? "p1Toast" : "notice"} role="status">
            {notice}
          </div>
        ) : null}

      <datalist id="categoryOptions">
        {categories.map((category) => (
          <option key={category.id} value={category.name} />
        ))}
      </datalist>

      {activeTab === "main" ? (
        metaError ? (
          <section className="p1ScreenError" aria-live="polite">
            <div className="p1ScreenErrorCard">
              <span className="p1ScreenErrorIcon" aria-hidden="true">!</span>
              <h2>
                Не удалось загрузить данные за{" "}
                {formatMonthLabel(mainPeriod).replace(/^./, (value) => value.toLowerCase())}
              </h2>
              <p>Проверьте подключение к интернету и попробуйте ещё раз.</p>
              <button type="button" onClick={() => void loadMetadata()}>Повторить</button>
            </div>
          </section>
        ) : (
        <>
          <div
            className={`compactMetrics ${compactMetricsVisible ? "show" : ""} ${
              forecastVisible ? "" : "forecastOff"
            }`}
            aria-hidden={!compactMetricsVisible}
          >
            <button className="compactPeriod" type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              {formatMonthLabel(mainPeriod)}
            </button>
            <div className="compactFacts">
              <span className="compactFact">
                <span>Начало</span>
                <strong>{startTotals === null ? "…" : renderConverted(startConverted, periodRates, periodRateDate)}</strong>
              </span>
              <span className="compactFact compactIncome">
                <span>Поступления</span>
                <strong>+{renderConverted(incomeConverted, periodRates, periodRateDate)}</strong>
              </span>
              <span className="compactFact">
                <span>Расходы</span>
                <strong>{renderConverted(expenseConverted, periodRates, periodRateDate)}</strong>
              </span>
              <span className="compactFact">
                <span>Сейчас</span>
                <strong>{pastPeriod && endAccounts === null ? "…" : renderConverted(panelConverted, panelRates, panelRateDate)}</strong>
              </span>
            </div>
            {forecastVisible ? (
              <div className="compactForecast">
                <span className="compactForecastTitle">Прогноз на {formatMonthName(mainPeriod)}</span>
                <span className="compactMini"><span>Цель</span><b>{forecastResult ? <Money cents={forecastResult.goalCents} currency={displayCurrency} /> : "…"}</b></span>
                <span className="compactMini"><span>Траты в день</span><b>{forecastResult ? <Money cents={forecastResult.dailyGoalCents} currency={displayCurrency} /> : "…"}</b></span>
                <span className="compactMini"><span>Доступно</span><b>{forecastResult ? <Money cents={forecastResult.availableCents} currency={displayCurrency} /> : "…"}</b></span>
              </div>
            ) : null}
          </div>

          <div className="phase1Top">
            <div className="topline">
              <MonthPicker
                phase1
                ariaLabel="Период"
                value={mainPeriod}
                onChange={setMainPeriod}
                max={currentMonth}
              />
              {currencyOptions.length > 0 ? (
                <div className="rightGlobal">
                  <select
                    className="currencySelect"
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
                  <button
                    type="button"
                    className={`forecastToggle ${forecastOn ? "on" : ""}`}
                    aria-pressed={forecastOn}
                    disabled={!forecastAvailable}
                    onClick={() => setForecastOn((value) => !value)}
                  >
                    <span className="forecastDot" aria-hidden="true" />
                    Прогнозы
                  </button>
                </div>
              ) : null}
            </div>

            <section
              className={`p1SummaryGrid ${forecastVisible ? "withForecast" : ""} ${
                loading || transactionsLoading ? "summarySkeleton" : ""
              }`}
              aria-label="Сводка"
            >
              <div className="factsPanel">
                <article className="p1Metric">
                  <span>Баланс на начало периода</span>
                  <strong>{startTotals === null ? "…" : renderConverted(startConverted, periodRates, periodRateDate)}</strong>
                </article>
                <article className="p1Metric incomeMetric">
                  <span>Поступления за период</span>
                  <strong>+{renderConverted(incomeConverted, periodRates, periodRateDate)}</strong>
                </article>
                <article className="p1Metric">
                  <span>Расходы за период</span>
                  <strong>{renderConverted(expenseConverted, periodRates, periodRateDate)}</strong>
                </article>
                <article className="p1Metric">
                  <span>{pastPeriod ? "Баланс на конец периода" : "Текущий баланс"}</span>
                  <strong>{pastPeriod && endAccounts === null ? "…" : renderConverted(panelConverted, panelRates, panelRateDate)}</strong>
                </article>
              </div>
              {forecastVisible ? (
                <article className="forecastCard">
                  <span className="forecastCardTitle">
                    Прогноз на {formatMonthName(mainPeriod)}
                  </span>
                  <span className="forecastColumns">
                    <span className="forecastColumn">
                      <span>Цель</span>
                      <strong>{forecastResult ? <Money cents={forecastResult.goalCents} currency={displayCurrency} /> : "…"}</strong>
                    </span>
                    <span className="forecastColumn">
                      <span>Траты в день</span>
                      <strong>{forecastResult ? <Money cents={forecastResult.dailyGoalCents} currency={displayCurrency} /> : "…"}</strong>
                    </span>
                    <span className="forecastColumn subtle">
                      <span>Доступно</span>
                      <strong>{forecastResult ? <Money cents={forecastResult.availableCents} currency={displayCurrency} /> : "…"}</strong>
                    </span>
                  </span>
                </article>
              ) : null}
            </section>
          </div>

          <div className="p1Layout">
            <section className="p1MainColumn">
              <section className="operationsSurface">
                <div className="p1StickyTools" ref={stickyToolsRef}>
                  <div className="p1Toolbar">
                  <div className={`queryCluster phase1MenuRoot ${filtersOpen ? "open" : ""}`}>
                    <select
                      className="operationScope"
                      aria-label="Область поиска и фильтрации"
                      value={operationScope}
                      onChange={(event) =>
                        setOperationScope(event.target.value as OperationListScope)
                      }
                    >
                      <option value="period">Текущий период</option>
                      <option value="history">Вся история</option>
                    </select>
                    <label className="operationSearch">
                      <span aria-hidden="true">⌕</span>
                      <input
                        aria-label="Поиск по операциям"
                        placeholder="Поиск по операциям"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                    <button
                      className={`filterTrigger ${hasActiveListFilters ? "active" : ""}`}
                      type="button"
                      aria-expanded={filtersOpen}
                      onClick={() => {
                        setFiltersOpen((value) => !value);
                        setSortOpen(false);
                        setAddMenuOpen(false);
                      }}
                    >
                      Фильтры{hasActiveListFilters ? " ·" : ""}
                      <span aria-hidden="true">⌄</span>
                    </button>
                    {filtersOpen ? (
                      <div className="filterPanel">
                        <div className="filterGrid">
                          <label>
                            <span className="srOnly">Счёт</span>
                            <select
                              aria-label="Счёт"
                              value={selectedAccountId}
                              onChange={(event) => setSelectedAccountId(event.target.value)}
                            >
                              <option value="all">Все счета</option>
                              {accounts.map((account) => (
                                <option key={account.id} value={account.id}>{account.name}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span className="srOnly">Категория</span>
                            <select
                              aria-label="Категория"
                              value={categoryFilter}
                              onChange={(event) => setCategoryFilter(event.target.value)}
                            >
                              <option value="">Все категории</option>
                              <option value="Без категории">Без категории</option>
                              {categoryFilterOptions.map((name) => (
                                <option key={name} value={name}>{name}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span className="srOnly">Тип операции</span>
                            <select
                              aria-label="Тип операции"
                              value={typeFilter}
                              onChange={(event) => setTypeFilter(event.target.value)}
                            >
                              <option value="all">Все типы</option>
                              <option value="expense">Расход</option>
                              <option value="income">Поступление</option>
                              <option value="transfer">Перевод</option>
                            </select>
                          </label>
                          <label className="attentionFilter">
                            <input
                              type="checkbox"
                              checked={flaggedOnly}
                              onChange={(event) => setFlaggedOnly(event.target.checked)}
                            />
                            Внимание
                          </label>
                          <button
                            className="findTransfersButton"
                            type="button"
                            disabled={saving}
                            onClick={() => void openDetectTransfers()}
                          >
                            Найти переводы
                          </button>
                          {hasActiveListFilters ? (
                            <button className="resetFilters" type="button" onClick={resetListFilters}>
                              Сбросить
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className={`sortHolder phase1MenuRoot ${sortOpen ? "open" : ""}`}>
                    <button
                      className="sortTrigger"
                      type="button"
                      aria-expanded={sortOpen}
                      onClick={() => {
                        setSortOpen((value) => !value);
                        setFiltersOpen(false);
                        setAddMenuOpen(false);
                      }}
                    >
                      {operationSortLabel}
                    </button>
                    {sortOpen ? (
                      <div className="sortMenu" role="menu">
                        {([
                          ["date", "Дата ↓"],
                          ["amount-desc", "Сумма ↓"],
                          ["amount-asc", "Сумма ↑"],
                        ] as const).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={operationSort === value}
                            onClick={() => {
                              setOperationSort(value);
                              setSortOpen(false);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className={`addHolder phase1MenuRoot ${addMenuOpen ? "open" : ""}`}>
                    <div className="addSplit">
                      <button
                        type="button"
                        data-focus-key="add-operation"
                        onClick={openAddTransaction}
                        disabled={saving}
                      >
                        + Добавить
                      </button>
                      <button
                        type="button"
                        aria-label="Другие способы добавления"
                        aria-expanded={addMenuOpen}
                        onClick={() => {
                          setAddMenuOpen((value) => !value);
                          setFiltersOpen(false);
                          setSortOpen(false);
                        }}
                      >
                        ⌄
                      </button>
                    </div>
                    {addMenuOpen ? (
                      <div className="addMenu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            openImport();
                          }}
                        >
                          Импортировать операции
                        </button>
                      </div>
                    ) : null}
                  </div>
                  </div>
                </div>

                <div className="p1TableFrame">
                  <table className={`p1OpsTable ${operationSort !== "date" ? "flatMode" : ""} ${
                    historyDateMode ? "historyMode" : ""
                  } ${compactMetricsVisible ? "compactHeader" : ""}`}>
                    <thead>
                      {operationSort === "date" ? (
                        <tr>
                          {historyDateMode ? <th>Дата</th> : <th aria-label="Пометки" />}
                          <th>Счёт</th>
                          <th>Назначение</th>
                          <th className="p1AmountHeading">Сумма</th>
                          <th>Категория</th>
                          <th aria-label="Действия" />
                        </tr>
                      ) : (
                        <tr>
                          <th>Дата</th>
                          <th>Счёт</th>
                          <th>Назначение</th>
                          <th className="p1FlatAmountHeading">Сумма</th>
                          <th>Категория</th>
                          <th aria-label="Действия" />
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {transactionsError ? (
                        <tr>
                          <OperationTableState kind="error" onAction={() => void loadTransactions()} />
                        </tr>
                      ) : transactionsLoading ? (
                        OPERATION_TABLE_SKELETON_WIDTHS.map((widths, index) => (
                          <Fragment key={index}>
                            {index % 3 === 0 ? (
                              <tr className="operationSkeletonGroup" aria-hidden="true">
                                <td><span style={{ width: index === 0 ? "85px" : "72px" }} /></td>
                                <td><span style={{ width: index === 0 ? "82px" : "76px" }} /></td>
                              </tr>
                            ) : null}
                            <tr className="operationSkeleton" aria-hidden="true">
                              {widths.map((width, column) => (
                                <td key={column}>{width === "0" ? null : <span style={{ width }} />}</td>
                              ))}
                            </tr>
                          </Fragment>
                        ))
                      ) : operationSort !== "date" ? (
                        sortedOperationRows.length === 0 ? (
                          <tr>
                            <OperationTableState
                              kind={hasActiveListFilters && periodTransactions.length > 0 ? "no-results" : "empty"}
                              onAction={hasActiveListFilters && periodTransactions.length > 0 ? resetListFilters : openAddTransaction}
                            />
                          </tr>
                        ) : (
                          sortedOperationRows.map((row) => renderOperationRow(row, true, true))
                        )
                      ) : historyDateMode ? (
                        historyYearGroups.length === 0 ? (
                          <tr>
                            <OperationTableState
                              kind={hasActiveListFilters && periodTransactions.length > 0 ? "no-results" : "empty"}
                              onAction={hasActiveListFilters && periodTransactions.length > 0 ? resetListFilters : openAddTransaction}
                            />
                          </tr>
                        ) : (
                          historyYearGroups.map((group) => (
                            <Fragment key={group.year}>
                              <tr className="yearGroup">
                                <td colSpan={6}>{group.year}</td>
                              </tr>
                              {group.items.map((row) => renderOperationRow(row, true))}
                            </Fragment>
                          ))
                        )
                      ) : dayGroups.length === 0 ? (
                        <tr>
                          <OperationTableState
                            kind={hasActiveListFilters && periodTransactions.length > 0 ? "no-results" : "empty"}
                            onAction={hasActiveListFilters && periodTransactions.length > 0 ? resetListFilters : openAddTransaction}
                          />
                        </tr>
                      ) : (
                        dayGroups.map((group) => (
                          <Fragment key={group.date}>
                            <tr className="dayGroup">
                              <td colSpan={4}>{formatDayHeader(group.date)}</td>
                              <td className="dayTotalCell">
                                {displayCurrency ? (
                                  <span className="dayTotalInner">
                                    <Money cents={perDayExpenseCents[group.date] ?? 0} currency={displayCurrency} />
                                    {forecastOverlay && group.date === today() ? (
                                      <span className="dayTarget">
                                        Цель{" "}
                                        <Money cents={forecastOverlay.dailyGoalCents} currency={displayCurrency} />
                                      </span>
                                    ) : null}
                                  </span>
                                ) : null}
                              </td>
                              <td colSpan={2} />
                            </tr>
                            {group.items.map((row) => renderOperationRow(row, false))}
                          </Fragment>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </section>

            <aside className="p1RightRail">
              <div
                ref={rightStackRef}
                className={`rightStickyStack ${compactMetricsVisible ? "scrolled" : ""} ${
                  rightStackOverflow ? "stickyOff" : ""
                }`}
              >
                <section ref={accountsPanelRef} className="p1AccountsPanel" aria-label="Баланс по счетам">
                  <div className="accountPanelGrid accountPanelHead" aria-hidden="true">
                    <span>Счёт</span>
                    <span>Расходы</span>
                    <span>Баланс</span>
                  </div>
                  {loading || (pastPeriod && endAccounts === null) ? (
                    <div className="accountPanelSkeleton" aria-hidden="true">
                      {ACCOUNT_PANEL_SKELETON_WIDTHS.map((widths, index) => (
                        <div className="accountPanelGrid" key={index}>
                          {widths.map((width, column) => (
                            <span key={column} style={{ width }} />
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : panelAccounts.length === 0 ? (
                    <div className="rightPanelState">Нет счетов</div>
                  ) : (
                    <div className="accountPanelRows">
                      {panelAccountSelection.visible.map((account) => {
                        const balanceTone =
                          account.balanceCents < 0
                            ? "negative"
                            : account.balanceCents === 0
                              ? "zero"
                              : "";
                        return (
                          <div className="accountPanelGrid accountPanelRow" key={account.id}>
                            <span className="accountPanelName" title={account.name}>
                              <strong>{account.name}</strong>
                            </span>
                            <span className="accountPanelSpend">{renderFlowCell(accountSpend.get(account.id))}</span>
                            <span className={`accountPanelBalance ${balanceTone}`}>
                              <span className="p1RatesPeek">
                                <strong>{renderAccountBalance(account)}</strong>
                                {displayCurrency && account.currency !== displayCurrency && rateInfo(account.currency) ? (
                                  <span className="p1RatesPop">{rateInfo(account.currency)}</span>
                                ) : null}
                              </span>
                              {displayCurrency && account.currency !== displayCurrency ? (
                                <small><Money cents={account.balanceCents} currency={account.currency} /></small>
                              ) : null}
                            </span>
                          </div>
                        );
                      })}
                      {panelAccounts.length > 9 ? (
                        <button
                          type="button"
                          className="accountPanelExpand"
                          aria-expanded={accountsExpanded}
                          onClick={() => {
                            if (!accountsExpanded) {
                              setViewedOverflowAccountIds((current) => {
                                const next = new Set(current);
                                for (const account of panelAccounts.slice(9)) next.add(account.id);
                                return next;
                              });
                              setAccountsExpanded(true);
                              return;
                            }
                            setAccountsExpanded(false);
                            window.requestAnimationFrame(() =>
                              accountsPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                            );
                          }}
                        >
                          {accountsExpanded ? "Свернуть" : "Показать ещё"}
                        </button>
                      ) : null}
                      <div className="accountPanelTotal">
                        <strong>Итого</strong>
                        <strong>{renderConverted(panelConverted, panelRates, panelRateDate)}</strong>
                      </div>
                    </div>
                  )}
                </section>

                <section
                  className={`p1CategoryPanel ${periodRates === null ? "loading" : ""}`}
                  aria-label="Расходы по категориям"
                >
                  <h2>Расходы по категориям</h2>
                  {categoryBars.missing.length > 0 ? (
                    <p className="p1PanelNote">
                      <Flagged reason={`Без учёта ${categoryBars.missing.join(", ")} — нет курса на ${dmy(periodRateDate)}`}>
                        учтены не все валюты
                      </Flagged>
                    </p>
                  ) : null}
                  {periodRates === null ? (
                    <div className="categoryPanelSkeleton" aria-hidden="true">
                      <span className="categorySkeletonLine w55" />
                      <div><span className="categorySkeletonLine w35" /><span className="categorySkeletonLine w35" /></div>
                      <span className="categorySkeletonLine" />
                      <div><span className="categorySkeletonLine w45" /><span className="categorySkeletonLine w35" /></div>
                      <span className="categorySkeletonLine w75" />
                    </div>
                  ) : (
                    <CategoryDonut items={categoryDonutItems} currency={displayCurrency} />
                  )}
                </section>
              </div>

            </aside>
          </div>

          {detectOpen ? (
            <div
              className="p1ModalOverlay"
              onClick={() => setDetectOpen(false)}
            >
              <section
                ref={detectDialogRef}
                className="p1Dialog p1DetectDialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="detect-transfers-title"
                onClick={(event) => event.stopPropagation()}
              >
                <header className="p1DialogHeader">
                  <h2>
                    <span id="detect-transfers-title">Похоже на переводы</span>{" "}
                    <span className="countBadge">{detectPairs?.length ?? 0}</span>
                  </h2>
                  <button
                    className="p1DialogClose"
                    type="button"
                    onClick={() => setDetectOpen(false)}
                    aria-label="Закрыть"
                  >
                    ×
                  </button>
                </header>
                <div className="p1DetectBody">
                  <p className="p1DetectHint">
                    Пары «расход + поступление» с одинаковой суммой и валютой на разных
                    счетах в пределах трёх дней. Отмеченные станут перемещениями и
                    перестанут учитываться в доходах, расходах и категориях.
                  </p>
                  {(detectPairs ?? []).length === 0 ? (
                    <p className="p1DetectEmpty">Ничего похожего на переводы не нашлось.</p>
                  ) : (
                    <ul className="p1DetectList">
                      {(detectPairs ?? []).map((pair, index) => (
                        <li key={pair.out.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={detectChecked.has(index)}
                              onChange={() => toggleDetect(index)}
                            />
                            <span className="p1DetectMain">
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
                            <span className="p1DetectAmount">
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
                </div>
                {(detectPairs ?? []).length > 0 ? (
                  <footer className="p1DetectFooter">
                    <button
                      className="modalButton primary"
                      type="button"
                      disabled={saving || detectChecked.size === 0}
                      onClick={() => void linkDetected()}
                    >
                      Связать выбранные ({detectChecked.size})
                    </button>
                  </footer>
                ) : null}
              </section>
            </div>
          ) : null}

          {formOpen ? (
            <div
              className={`p1ModalOverlay ${
                transactionForm.direction === "transfer"
                  ? "p1TransferOverlay"
                  : "p1OperationOverlay"
              }`}
              onClick={closeForm}
            >
              <div
                ref={transactionDialogRef}
                className={`p1Dialog ${
                  transactionForm.direction === "transfer" ? "p1TransferDialog" : "p1OrdinaryDialog"
                }`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="phase1-operation-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="p1DialogHeader">
                  <h2 id="phase1-operation-title">{operationModalTitle}</h2>
                  <button className="p1DialogClose" type="button" onClick={closeForm} aria-label="Закрыть">
                    ×
                  </button>
                </div>

                {/* Two-column grid; the field set and pairing follow the type:
                    ordinary — [Тип|Дата][Счёт|Сумма][Описание][Категория],
                    transfer — [Тип|Дата][Со счёта|На счёт][Сумма|Зачислено]. */}
                <form className="p1Form" onSubmit={handleSubmitTransaction}>
                  {transactionForm.direction !== "transfer" || !editingTransactionId ? (
                    <div className="operationField">
                    <span className="fieldLabel">Тип операции</span>
                    <div className="operationSegments" role="group" aria-label="Тип операции">
                      {([
                        ["expense", "Расход"],
                        ["income", "Поступление"],
                        ["transfer", "Перевод"],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={transactionForm.direction === value ? "active" : ""}
                          aria-pressed={transactionForm.direction === value}
                          onClick={() => {
                            setTransactionForm({
                              ...transactionForm,
                              direction: value,
                              category: value === "expense" ? transactionForm.category : "",
                            });
                            setAutoCategoryApplied(false);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    </div>
                  ) : null}
                  {transactionForm.direction === "transfer" && !editingTransactionId ? (
                    <>
                      <div className="operationField">
                        <label className="fieldLabel">Дата</label>
                        <DateField
                          phase1
                          required
                          value={transactionForm.date}
                          onChange={(iso) => setTransactionForm({ ...transactionForm, date: iso })}
                        />
                        <span className="fieldHelp">Дата влияет на список доступных счетов</span>
                      </div>
                      <div className={`operationField ${transactionAccountInvalid ? "invalid" : ""}`}>
                        <label className="fieldLabel" htmlFor="transfer-from-account">Со счёта</label>
                        <select
                          id="transfer-from-account"
                          required
                          disabled={accounts.length === 0}
                          value={transactionForm.accountId}
                          aria-invalid={transactionAccountInvalid}
                          onChange={(event) => {
                            const accountId = event.target.value;
                            setTransactionForm({
                              ...transactionForm,
                              accountId,
                              toAccountId:
                                accountId === transactionForm.toAccountId
                                  ? ""
                                  : transactionForm.toAccountId,
                            });
                          }}
                        >
                          <option value="">Выберите счёт</option>
                          {operationAccountOptions.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name}
                            </option>
                          ))}
                        </select>
                        {transactionAccountInvalid ? <span className="fieldError">Этот счёт недоступен на выбранную дату. Выберите другой счёт.</span> : null}
                      </div>
                      <div className={`operationField ${transferToAccountInvalid ? "invalid" : ""}`}>
                        <label className="fieldLabel" htmlFor="transfer-to-account">На счёт</label>
                        <select
                          id="transfer-to-account"
                          required
                          value={transactionForm.toAccountId}
                          aria-invalid={transferToAccountInvalid}
                          onChange={(event) =>
                            setTransactionForm({
                              ...transactionForm,
                              toAccountId: event.target.value,
                            })
                          }
                        >
                          <option value="">Выберите счёт</option>
                          {operationAccountOptions
                            .filter((account) => String(account.id) !== transactionForm.accountId)
                            .map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.name}
                              </option>
                            ))}
                        </select>
                        {transferToAccountInvalid ? <span className="fieldError">Этот счёт недоступен на выбранную дату. Выберите другой счёт.</span> : null}
                      </div>

                      {transferCrossCurrency ? (
                        <div className="transferAmountsDifferent p1WideField">
                          <div className="operationField">
                            <label className="fieldLabel" htmlFor="transfer-amount-out">Списано</label>
                            <div className="amountControl">
                              <input
                                id="transfer-amount-out"
                                required
                                inputMode="decimal"
                                placeholder="0,00"
                                value={transactionForm.amount}
                                onChange={(event) => setTransactionForm({ ...transactionForm, amount: event.target.value })}
                              />
                              <span>{transferFromAccount?.currency}</span>
                            </div>
                          </div>
                          <span className="transferAmountArrow" aria-hidden="true">→</span>
                          <div className="operationField">
                            <label className="fieldLabel" htmlFor="transfer-amount-in">Зачислено</label>
                            <div className="amountControl">
                              <input
                                id="transfer-amount-in"
                                required
                                inputMode="decimal"
                                placeholder="0,00"
                                value={transactionForm.amountIn}
                                onChange={(event) => setTransactionForm({ ...transactionForm, amountIn: event.target.value })}
                              />
                              <span>{transferToAccount?.currency}</span>
                            </div>
                            <span className="fieldHelp">Укажите сумму зачисления в валюте счёта</span>
                          </div>
                        </div>
                      ) : (
                        <div className="operationField p1WideField">
                          <label className="fieldLabel" htmlFor="transfer-amount">Сумма</label>
                          <div className="amountControl">
                            <input
                              id="transfer-amount"
                              required
                              inputMode="decimal"
                              placeholder="0,00"
                              value={transactionForm.amount}
                              onChange={(event) => setTransactionForm({ ...transactionForm, amount: event.target.value })}
                            />
                            <span>{transferFromAccount?.currency ?? ""}</span>
                          </div>
                        </div>
                      )}

                      <div className="operationField p1WideField">
                        <label className="fieldLabel" htmlFor="transfer-description">Описание перевода</label>
                        <input
                          id="transfer-description"
                          maxLength={120}
                          value={transactionForm.description}
                          onChange={(event) =>
                            setTransactionForm({
                              ...transactionForm,
                              description: event.target.value,
                            })
                          }
                        />
                        <span className="fieldHelp">Будет применено к обеим операциям</span>
                        <span className="fieldCounter">{transactionForm.description.length} / 120</span>
                      </div>

                      <button
                        className="additionalToggle p1WideField"
                        type="button"
                        aria-expanded={additionalFieldsOpen}
                        onClick={() => setAdditionalFieldsOpen((value) => !value)}
                      >
                        <span aria-hidden="true">›</span>
                        Дополнительно
                      </button>
                      {additionalFieldsOpen ? (
                        <div className="additionalFields p1WideField">
                          <div className="operationField">
                            <label className="fieldLabel" htmlFor="transfer-note">Заметка</label>
                            <textarea
                              id="transfer-note"
                              maxLength={500}
                              placeholder="Введите заметку (необязательно)"
                              value={transactionForm.notes}
                              onChange={(event) => setTransactionForm({ ...transactionForm, notes: event.target.value })}
                            />
                            <span className="fieldCounter">{transactionForm.notes.length} / 500</span>
                          </div>
                          <label className="operationCheckbox">
                            <input
                              type="checkbox"
                              checked={transactionForm.flagged}
                              onChange={(event) => setTransactionForm({ ...transactionForm, flagged: event.target.checked })}
                            />
                            <span>Требует внимания</span>
                          </label>
                        </div>
                      ) : null}
                    </>
                  ) : transactionForm.direction === "transfer" ? (
                    <>
                      {editingTransaction?.transferGroup ? (
                        <>
                          <div className="linkedTransferBanner p1WideField">
                            <svg className="linkedTransferBannerIcon" viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M9.5 14.5l5-5M7.5 16.5l-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M16.5 7.5l1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0" />
                            </svg>
                            <span><strong>Связанные операции</strong> · изменения сохраняются для обеих сторон</span>
                          </div>
                          {transferPairLoading || !editingTransferPair ? (
                            <div className="transferFormLoading p1WideField">Загрузка…</div>
                          ) : (
                            <>
                              <div className="transferEditDateRow p1WideField">
                                <div className="operationField">
                                  <label className="fieldLabel">Дата</label>
                                  <DateField
                                    phase1
                                    required
                                    value={transactionForm.date}
                                    onChange={(iso) => setTransactionForm({ ...transactionForm, date: iso })}
                                  />
                                  <span className="fieldHelp">Дата влияет на список доступных счетов</span>
                                </div>
                              </div>

                              <div className="transferEditGrid p1WideField">
                                <section>
                                  <h3>Списано</h3>
                                  <div className={`operationField ${transactionAccountInvalid ? "invalid" : ""}`}>
                                    <label className="fieldLabel" htmlFor="edit-transfer-from">Со счёта</label>
                                    <select
                                      id="edit-transfer-from"
                                      required
                                      value={transactionForm.accountId}
                                      aria-invalid={transactionAccountInvalid}
                                      onChange={(event) => {
                                        const accountId = event.target.value;
                                        setTransactionForm({
                                          ...transactionForm,
                                          accountId,
                                          toAccountId:
                                            accountId === transactionForm.toAccountId
                                              ? ""
                                              : transactionForm.toAccountId,
                                        });
                                      }}
                                    >
                                      <option value="">Выберите счёт</option>
                                      {operationAccountOptions
                                        .filter((account) => String(account.id) !== transactionForm.toAccountId)
                                        .map((account) => (
                                          <option key={account.id} value={account.id}>
                                            {account.name}
                                          </option>
                                        ))}
                                    </select>
                                    {transactionAccountInvalid ? <span className="fieldError">Этот счёт недоступен на выбранную дату. Выберите другой счёт.</span> : null}
                                  </div>
                                  <div className="operationField">
                                    <label className="fieldLabel" htmlFor="edit-transfer-out-amount">Сумма</label>
                                    <div className="amountControl">
                                      <input
                                        id="edit-transfer-out-amount"
                                        required
                                        inputMode="decimal"
                                        value={transactionForm.amount}
                                        onChange={(event) => setTransactionForm({ ...transactionForm, amount: event.target.value })}
                                      />
                                      <span>{transferFromAccount?.currency}</span>
                                    </div>
                                    <span className="transferAmountHelp" aria-hidden="true">&nbsp;</span>
                                  </div>
                                  <div className="operationField">
                                    <label className="fieldLabel" htmlFor="edit-transfer-out-description">Описание</label>
                                    <input
                                      id="edit-transfer-out-description"
                                      maxLength={120}
                                      value={transactionForm.description}
                                      onChange={(event) => setTransactionForm({ ...transactionForm, description: event.target.value })}
                                    />
                                  </div>
                                </section>

                                <section>
                                  <h3>Зачислено</h3>
                                  <div className={`operationField ${transferToAccountInvalid ? "invalid" : ""}`}>
                                    <label className="fieldLabel" htmlFor="edit-transfer-to">На счёт</label>
                                    <select
                                      id="edit-transfer-to"
                                      required
                                      value={transactionForm.toAccountId}
                                      aria-invalid={transferToAccountInvalid}
                                      onChange={(event) => setTransactionForm({ ...transactionForm, toAccountId: event.target.value })}
                                    >
                                      <option value="">Выберите счёт</option>
                                      {operationAccountOptions
                                        .filter((account) => String(account.id) !== transactionForm.accountId)
                                        .map((account) => (
                                          <option key={account.id} value={account.id}>
                                            {account.name}
                                          </option>
                                        ))}
                                    </select>
                                    {transferToAccountInvalid ? <span className="fieldError">Этот счёт недоступен на выбранную дату. Выберите другой счёт.</span> : null}
                                  </div>
                                  <div className="operationField">
                                    <label className="fieldLabel" htmlFor="edit-transfer-in-amount">Сумма</label>
                                    <div className={`amountControl ${transferCrossCurrency ? "" : "synced"}`}>
                                      {!transferCrossCurrency ? (
                                        <svg className="transferSyncIcon" viewBox="0 0 24 24" aria-hidden="true">
                                          <path d="M9.5 14.5l5-5M7.5 16.5l-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M16.5 7.5l1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0" />
                                        </svg>
                                      ) : null}
                                      <input
                                        id="edit-transfer-in-amount"
                                        required
                                        inputMode="decimal"
                                        readOnly={!transferCrossCurrency}
                                        aria-label="Сумма зачисления"
                                        value={transferCrossCurrency ? transactionForm.amountIn : transactionForm.amount}
                                        onChange={(event) => setTransactionForm({ ...transactionForm, amountIn: event.target.value })}
                                      />
                                      <span>{transferToAccount?.currency}</span>
                                    </div>
                                    <span className="transferAmountHelp">
                                      {transferCrossCurrency
                                        ? "Укажите сумму зачисления в валюте счёта"
                                        : "Синхронизировано со списанием"}
                                    </span>
                                  </div>
                                  <div className="operationField">
                                    <label className="fieldLabel" htmlFor="edit-transfer-in-description">Описание</label>
                                    <input
                                      id="edit-transfer-in-description"
                                      maxLength={120}
                                      value={transactionForm.descriptionIn}
                                      onChange={(event) => setTransactionForm({ ...transactionForm, descriptionIn: event.target.value })}
                                    />
                                  </div>
                                </section>
                              </div>

                              <button
                                className="additionalToggle p1WideField"
                                type="button"
                                aria-expanded={additionalFieldsOpen}
                                onClick={() => setAdditionalFieldsOpen((value) => !value)}
                              >
                                <span aria-hidden="true">›</span>
                                Дополнительно
                              </button>
                              {additionalFieldsOpen ? (
                                <div className="additionalFields p1WideField">
                                  <div className="operationField">
                                    <label className="fieldLabel" htmlFor="edit-transfer-note">Заметка</label>
                                    <textarea
                                      id="edit-transfer-note"
                                      maxLength={500}
                                      placeholder="Введите заметку (необязательно)"
                                      value={transactionForm.notes}
                                      onChange={(event) => setTransactionForm({ ...transactionForm, notes: event.target.value })}
                                    />
                                    <span className="fieldCounter">{transactionForm.notes.length} / 500</span>
                                  </div>
                                  <label className="operationCheckbox">
                                    <input
                                      type="checkbox"
                                      checked={transactionForm.flagged}
                                      onChange={(event) => setTransactionForm({ ...transactionForm, flagged: event.target.checked })}
                                    />
                                    <span>Требует внимания</span>
                                  </label>
                                </div>
                              ) : null}
                            </>
                          )}
                        </>
                      ) : (
                        <div className={`p1WideField p1PartnerPicker ${partnerCreate.open ? "partnerMode" : "candidateMode"}`}>
                        <div className="transferSourceCard">
                          <span>Исходная операция</span>
                          <div>
                            <span>
                              <strong>{editingTransaction?.accountName}</strong>
                              <small>{editingTransaction ? dmy(editingTransaction.date) : ""} · {editingTransaction?.description || "—"}</small>
                            </span>
                            {editingTransaction ? (
                              <b>
                                {editingTransaction.amountCents < 0 ? "−" : "+"}
                                <Money cents={Math.abs(editingTransaction.amountCents)} currency={editingTransaction.accountCurrency} />
                              </b>
                            ) : null}
                          </div>
                        </div>
                        <div className="transferTabs" role="group" aria-label="Способ связывания">
                          <button
                            type="button"
                            aria-pressed={!partnerCreate.open}
                            className={!partnerCreate.open ? "active" : ""}
                            onClick={() => setPartnerCreate({ ...partnerCreate, open: false })}
                          >
                            Подходящие операции
                          </button>
                          <button
                            type="button"
                            aria-pressed={partnerCreate.open}
                            className={partnerCreate.open ? "active" : ""}
                            onClick={() =>
                              setPartnerCreate({
                                open: true,
                                accountId: partnerCreate.accountId,
                                amount: partnerCreate.amount || centsToInputValue(Math.abs(editingTransaction?.amountCents ?? 0)),
                                date: partnerCreate.date || editingTransaction?.date || today(),
                                description: partnerCreate.description || editingTransaction?.description || "",
                              })
                            }
                          >
                            Создать операцию-напарника
                          </button>
                        </div>
                        <div className="candidateSection">
                          <div className="transferSectionIntro">
                            <h3>Выберите подходящую операцию для связывания</h3>
                            <p>Мы нашли возможные совпадения по дате, сумме и описанию.</p>
                          </div>
                        {partnerCandidates === null ? (
                          <p className="p1TransferMuted">Загрузка…</p>
                        ) : partnerCandidates.length === 0 ? (
                          <p className="p1TransferMuted">
                            Подходящих операций не нашлось (±7 дней от даты)
                          </p>
                        ) : (
                          <ul className="p1PartnerList">
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
                                  <span className="p1PartnerMain">
                                    <span className="partnerCandidateTitle">
                                      <b>{cand.accountName}</b>
                                      {editingTransaction &&
                                      cand.date === editingTransaction.date &&
                                      cand.accountCurrency === editingTransaction.accountCurrency &&
                                      Math.abs(cand.amountCents) === Math.abs(editingTransaction.amountCents) ? (
                                        <em>точное совпадение</em>
                                      ) : null}
                                    </span>
                                    <small>
                                      {dmy(cand.date)} · {cand.description || "—"}
                                    </small>
                                  </span>
                                  <span className="p1PartnerAmount">
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
                        <div className="transferInfo">Не нашли подходящую операцию? Переключитесь на вкладку «Создать операцию-напарника».</div>
                        </div>

                        {/* Missing counterpart? Create it right here and link
                            in one action instead of closing the modal. */}
                        <div className="p1PartnerCreate">
                          {!partnerCreate.open ? (
                            <button
                              type="button"
                              className="p1PartnerCreateFallback"
                              onClick={() =>
                                setPartnerCreate({
                                  open: true,
                                  accountId: "",
                                  amount: centsToInputValue(
                                    Math.abs(editingTransaction?.amountCents ?? 0)
                                  ),
                                  date: editingTransaction?.date ?? today(),
                                  description: editingTransaction?.description ?? "",
                                })
                              }
                            >
                              + Создать операцию-напарника
                            </button>
                          ) : (
                            <>
                              <div className="p1PartnerCreateGrid">
                                <div className="operationField">
                                  <label className="fieldLabel">Дата операции</label>
                                  <DateField
                                    phase1
                                    required
                                    value={partnerCreate.date}
                                    onChange={(iso) => setPartnerCreate({ ...partnerCreate, date: iso })}
                                  />
                                  <span className="fieldHelp">
                                    {partnerCreate.date === editingTransaction?.date
                                      ? "Дата подставлена из исходной операции"
                                      : "Дата изменена вручную"}
                                  </span>
                                </div>
                                <div className={`operationField ${partnerAccountInvalid ? "invalid" : ""}`}>
                                  <label className="fieldLabel" htmlFor="partner-account">
                                    {editingTransaction && editingTransaction.amountCents > 0
                                      ? "Со счёта"
                                      : "На счёт"}
                                  </label>
                                  <select
                                    id="partner-account"
                                    required
                                    value={partnerCreate.accountId}
                                    aria-invalid={partnerAccountInvalid}
                                    onChange={(event) =>
                                      setPartnerCreate({
                                        ...partnerCreate,
                                        accountId: event.target.value,
                                      })
                                    }
                                  >
                                    <option value="">Выберите счёт</option>
                                    {partnerAccountOptions
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
                                  {partnerAccountInvalid ? (
                                    <span className="fieldError">Этот счёт недоступен на выбранную дату. Выберите другой счёт.</span>
                                  ) : null}
                                </div>
                                <div className="operationField">
                                  <label className="fieldLabel" htmlFor="partner-amount">
                                    {editingTransaction && editingTransaction.amountCents > 0
                                      ? "Сумма списания"
                                      : "Сумма зачисления"}
                                  </label>
                                  <div className="amountControl">
                                    <input
                                      id="partner-amount"
                                      required
                                      inputMode="decimal"
                                      value={partnerCreate.amount}
                                      onChange={(event) => setPartnerCreate({ ...partnerCreate, amount: event.target.value })}
                                    />
                                    <span>{accounts.find((account) => String(account.id) === partnerCreate.accountId)?.currency ?? ""}</span>
                                  </div>
                                  <span className="fieldHelp">
                                    {partnerCreate.amount === centsToInputValue(Math.abs(editingTransaction?.amountCents ?? 0))
                                      ? "Сумма подставлена из исходной операции"
                                      : "Сумма изменена вручную"}
                                  </span>
                                </div>
                                <div className="operationField">
                                  <label className="fieldLabel" htmlFor="partner-description">Описание</label>
                                  <input
                                    id="partner-description"
                                    value={partnerCreate.description}
                                    onChange={(event) => setPartnerCreate({ ...partnerCreate, description: event.target.value })}
                                  />
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                        <button
                          className="additionalToggle"
                          type="button"
                          aria-expanded={additionalFieldsOpen}
                          onClick={() => setAdditionalFieldsOpen((value) => !value)}
                        >
                          <span aria-hidden="true">›</span>
                          Дополнительно
                        </button>
                        {additionalFieldsOpen ? (
                          <div className="additionalFields">
                            <div className="operationField">
                              <label className="fieldLabel" htmlFor="link-transfer-note">Заметка</label>
                              <textarea
                                id="link-transfer-note"
                                maxLength={500}
                                placeholder="Введите заметку (необязательно)"
                                value={transactionForm.notes}
                                onChange={(event) => setTransactionForm({ ...transactionForm, notes: event.target.value })}
                              />
                              <span className="fieldCounter">{transactionForm.notes.length} / 500</span>
                            </div>
                            <label className="operationCheckbox">
                              <input
                                type="checkbox"
                                checked={transactionForm.flagged}
                                onChange={(event) => setTransactionForm({ ...transactionForm, flagged: event.target.checked })}
                              />
                              <span>Требует внимания</span>
                            </label>
                          </div>
                        ) : null}
                      </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="operationField">
                        <label className="fieldLabel">Дата</label>
                        <DateField
                          phase1
                          required
                          value={transactionForm.date}
                          onChange={(iso) => setTransactionForm({ ...transactionForm, date: iso })}
                        />
                        {!editingTransactionId ? (
                          <span className="fieldHelp">Дата влияет на список доступных счетов</span>
                        ) : null}
                      </div>

                      <div className={`operationField ${transactionAccountInvalid ? "invalid" : ""}`}>
                        <label className="fieldLabel" htmlFor="operation-account">Счёт</label>
                        <select
                          id="operation-account"
                          required
                          disabled={accounts.length === 0}
                          value={transactionForm.accountId}
                          aria-invalid={transactionAccountInvalid}
                          onChange={(event) => setTransactionForm({ ...transactionForm, accountId: event.target.value })}
                        >
                          <option value="">Выберите счёт</option>
                          {operationAccountOptions.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name}
                            </option>
                          ))}
                        </select>
                        {transactionAccountInvalid ? (
                          <span className="fieldError">Этот счёт недоступен на выбранную дату. Выберите другой счёт.</span>
                        ) : null}
                      </div>

                      <div className="operationField">
                        <label className="fieldLabel" htmlFor="operation-amount">Сумма</label>
                        <div className="amountControl">
                          <input
                            id="operation-amount"
                            required
                            inputMode="decimal"
                            placeholder="0,00"
                            value={transactionForm.amount}
                            onChange={(event) => setTransactionForm({ ...transactionForm, amount: event.target.value })}
                          />
                          <span>
                            {accounts.find((account) => String(account.id) === transactionForm.accountId)?.currency ?? ""}
                          </span>
                        </div>
                      </div>

                      <div
                        className="operationField p1WideField descriptionField"
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                            setSuggestionsOpen(false);
                          }
                        }}
                      >
                        <label className="fieldLabel" htmlFor="operation-description">Описание</label>
                        <input
                          id="operation-description"
                          maxLength={200}
                          autoComplete="off"
                          value={transactionForm.description}
                          onFocus={() => setSuggestionsOpen(descriptionSuggestions.length > 0)}
                          onChange={(event) => {
                            setTransactionForm({ ...transactionForm, description: event.target.value });
                            setAutoCategoryApplied(false);
                          }}
                        />
                        <span className="fieldCounter">{transactionForm.description.length} / 200</span>
                        {suggestionsOpen && descriptionSuggestions.length > 0 ? (
                          <div className="descriptionSuggestions" role="listbox">
                            {descriptionSuggestions.map((suggestion) => (
                              <button
                                type="button"
                                role="option"
                                aria-selected="false"
                                key={suggestion.description.toLocaleLowerCase("ru-RU")}
                                onClick={() => {
                                  // Explicitly picking a suggestion is a strong
                                  // signal, so fill its category whenever it has
                                  // one — including a description used only once.
                                  // The autoCategory confidence gate governs only
                                  // silent auto-fill, not a deliberate pick.
                                  const applyCategory =
                                    transactionForm.direction === "expense" &&
                                    Boolean(suggestion.category);
                                  setTransactionForm({
                                    ...transactionForm,
                                    description: suggestion.description,
                                    category: applyCategory ? suggestion.category : transactionForm.category,
                                  });
                                  setAutoCategoryApplied(applyCategory);
                                  setSuggestionsOpen(false);
                                }}
                              >
                                <span>
                                  <strong>{suggestion.description}</strong>
                                  {suggestion.category ? <small>{suggestion.category}</small> : null}
                                </span>
                                <em>Использовано {suggestion.usageCount} раз</em>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      {transactionForm.direction === "expense" ? (
                        <div className="operationField p1WideField">
                          <label className="fieldLabel" htmlFor="operation-category">Категория</label>
                          <select
                            id="operation-category"
                            value={transactionForm.category}
                            onChange={(event) => {
                              setTransactionForm({ ...transactionForm, category: event.target.value });
                              setAutoCategoryApplied(false);
                            }}
                          >
                            <option value="">Выберите категорию</option>
                            {transactionForm.category && !categories.some((category) => category.name === transactionForm.category) ? (
                              <option value={transactionForm.category}>{transactionForm.category}</option>
                            ) : null}
                            {categories.map((category) => (
                              <option key={category.id} value={category.name}>{category.name}</option>
                            ))}
                          </select>
                          {autoCategoryApplied ? <span className="autoCategoryBadge">Подставлено автоматически</span> : null}
                        </div>
                      ) : null}

                      <button
                        className="additionalToggle p1WideField"
                        type="button"
                        aria-expanded={additionalFieldsOpen}
                        onClick={() => setAdditionalFieldsOpen((value) => !value)}
                      >
                        <span aria-hidden="true">›</span>
                        Дополнительно
                      </button>

                      {additionalFieldsOpen ? (
                        <div className="additionalFields p1WideField">
                          <div className="operationField">
                            <label className="fieldLabel" htmlFor="operation-note">Заметка</label>
                            <textarea
                              id="operation-note"
                              maxLength={500}
                              value={transactionForm.notes}
                              onChange={(event) => setTransactionForm({ ...transactionForm, notes: event.target.value })}
                            />
                            <span className="fieldCounter">{transactionForm.notes.length} / 500</span>
                          </div>
                          <label className="operationCheckbox">
                            <input
                              type="checkbox"
                              checked={transactionForm.flagged}
                              onChange={(event) => setTransactionForm({ ...transactionForm, flagged: event.target.checked })}
                            />
                            <span>Требует внимания</span>
                          </label>
                        </div>
                      ) : null}
                    </>
                  )}
                  {transactionForm.direction === "transfer" ? (
                    <footer className="transferFooter p1WideField">
                      <div>
                        {editingTransferPair ? (
                          <button
                            className="modalButton destructiveOutline"
                            type="button"
                            onClick={() => setUnlinkTransferPair(editingTransferPair)}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M9.5 14.5l5-5M7.5 16.5l-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M16.5 7.5l1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0M4 4l16 16" />
                            </svg>
                            <span>Разъединить</span>
                          </button>
                        ) : null}
                      </div>
                      <div>
                        <button className="modalButton" type="button" onClick={closeForm}>Отмена</button>
                        {editingTransactionId && !editingTransaction?.transferGroup && partnerCreate.open ? (
                          <button
                            className="modalButton primary"
                            type="button"
                            disabled={
                              saving ||
                              !partnerCreate.accountId ||
                              !partnerCreate.amount ||
                              partnerAccountInvalid
                            }
                            onClick={() => void createAndLinkPartner()}
                          >
                            Создать и связать
                          </button>
                        ) : (
                          <button
                            className="modalButton primary"
                            type="submit"
                            disabled={
                              saving ||
                              transferPairLoading ||
                              accounts.length === 0 ||
                              transactionAccountInvalid ||
                              transferToAccountInvalid ||
                              (editingTransactionId !== null &&
                                !editingTransaction?.transferGroup &&
                                !partnerId)
                            }
                          >
                            {editingTransactionId !== null && !editingTransaction?.transferGroup
                              ? "Связать"
                              : editingTransactionId
                                ? "Сохранить"
                                : "Добавить перевод"}
                          </button>
                        )}
                      </div>
                    </footer>
                  ) : (
                    <footer className="operationFooter p1WideField">
                      <div>
                        {editingTransaction ? (
                          <button
                            className="modalButton destructiveOutline"
                            type="button"
                            onClick={() => setDeleteTransactionTarget(editingTransaction)}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
                            </svg>
                            <span>Удалить</span>
                          </button>
                        ) : null}
                      </div>
                      <div>
                        <button className="modalButton" type="button" onClick={closeForm}>Отмена</button>
                        {editingTransactionId ? (
                          <button
                            className="modalButton primary"
                            type="submit"
                            disabled={saving || accounts.length === 0 || transactionAccountInvalid}
                          >
                            Сохранить
                          </button>
                        ) : (
                          <>
                            <button
                              className="modalButton"
                              type="submit"
                              disabled={saving || accounts.length === 0 || transactionAccountInvalid}
                              onClick={() => setSubmitMode("close")}
                            >
                              Добавить и закрыть
                            </button>
                            <button
                              className="modalButton primary"
                              type="submit"
                              disabled={saving || accounts.length === 0 || transactionAccountInvalid}
                              onClick={() => setSubmitMode("more")}
                            >
                              Добавить ещё
                            </button>
                          </>
                        )}
                      </div>
                    </footer>
                  )}
                </form>
              </div>
            </div>
          ) : null}

          {importOpen ? (
            <ImportModal
              accounts={accounts}
              activeCurrency={activeCurrency}
              notify={setNotice}
              onClose={() => setImportOpen(false)}
              onImported={refreshAfterMutation}
            />
          ) : null}

          {deleteTransactionTarget ? (
            <div
              className="confirmOverlay"
              onClick={() => setDeleteTransactionTarget(null)}
            >
              <div
                className="confirmDialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-operation-title"
                onClick={(event) => event.stopPropagation()}
              >
                <h3 id="delete-operation-title">Удалить операцию?</h3>
                <p>Операция будет удалена из истории. Это действие нельзя отменить.</p>
                <div className="confirmOperation">
                  <span>
                    <strong>{deleteTransactionTarget.accountName}</strong>
                    <small>{dmy(deleteTransactionTarget.date)} · {deleteTransactionTarget.description || "—"}</small>
                  </span>
                  <b>
                    {deleteTransactionTarget.amountCents > 0 ? "+" : null}
                    <Money cents={Math.abs(deleteTransactionTarget.amountCents)} currency={deleteTransactionTarget.accountCurrency} />
                  </b>
                </div>
                <div className="confirmActions">
                  <button className="modalButton" type="button" onClick={() => setDeleteTransactionTarget(null)}>Отмена</button>
                  <button
                    className="modalButton danger"
                    type="button"
                    disabled={saving}
                    onClick={() => void removeTransaction(deleteTransactionTarget)}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {unlinkTransferPair ? (
            <div
              className="confirmOverlay unlinkOverlay"
              onClick={() => setUnlinkTransferPair(null)}
            >
              <div
                className="confirmDialog unlinkDialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="unlink-transfer-title"
                onClick={(event) => event.stopPropagation()}
              >
                <h3 id="unlink-transfer-title">Разъединить этот перевод?</h3>
                <div className="unlinkPair">
                  <div className="unlinkCard">
                    <span className="unlinkRole">Исходная операция</span>
                    <strong className="unlinkAccount">{unlinkTransferPair.out.accountName}</strong>
                    <small className="unlinkMeta">{dmy(unlinkTransferPair.out.date)} · На {unlinkTransferPair.incoming.accountName}</small>
                    <b className="unlinkAmount">−<Money cents={Math.abs(unlinkTransferPair.out.amountCents)} currency={unlinkTransferPair.out.accountCurrency} /></b>
                  </div>
                  <div className="unlinkCard">
                    <span className="unlinkRole">Операция-напарник</span>
                    <strong className="unlinkAccount">{unlinkTransferPair.incoming.accountName}</strong>
                    <small className="unlinkMeta">{dmy(unlinkTransferPair.incoming.date)} · {unlinkTransferPair.incoming.description || "—"}</small>
                    <b className="unlinkAmount"><Money cents={Math.abs(unlinkTransferPair.incoming.amountCents)} currency={unlinkTransferPair.incoming.accountCurrency} /></b>
                  </div>
                </div>
                <div className="unlinkWarning">
                  <strong>После разъединения</strong>
                  <p>Связь между операциями будет удалена. Они останутся в истории и будут учитываться отдельно: списание — как расход, зачисление — как поступление.</p>
                </div>
                <div className="confirmActions">
                  <button className="modalButton" type="button" onClick={() => setUnlinkTransferPair(null)}>Отмена</button>
                  <button
                    className="modalButton danger"
                    type="button"
                    disabled={saving}
                    onClick={() => void unlinkTransfer(unlinkTransferPair.out.transferGroup ?? "")}
                  >
                    Разъединить
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
        )
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
              <span>{currentMonth}</span>
            </div>

            {!forecastAvailable ? (
              <div className="mutedBlock">
                Прогноз считается для текущего месяца ({currentMonth}) в выбранной валюте. Открой
                текущий месяц на вкладке «Операции».
              </div>
            ) : (
              <>
                <div className="forecastGoalBox">
                  <label className="filterField">
                    Желаемая сумма отложить в этом месяце
                    <span className="goalInput">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={goalDraft}
                        placeholder="0"
                        onChange={(event) => setGoalDraft(event.target.value)}
                      />
                      {displayCurrency}
                    </span>
                  </label>
                  <button type="button" className="secondaryButton" onClick={() => void saveGoal()}>
                    Сохранить цель
                  </button>
                </div>

                {forecastResult ? (
                  <table className="forecastBreak">
                    <tbody>
                      <tr>
                        <td>Приходы месяца (факт)</td>
                        <td>+<Money cents={forecastResult.incomeCents} currency={displayCurrency} /></td>
                      </tr>
                      <tr>
                        <td>Расходы месяца (факт)</td>
                        <td>−<Money cents={forecastResult.expenseCents} currency={displayCurrency} /></td>
                      </tr>
                      {forecastResult.loansNetCents !== 0 ? (
                        <tr>
                          <td>Займы этого месяца</td>
                          <td><Money cents={forecastResult.loansNetCents} currency={displayCurrency} /></td>
                        </tr>
                      ) : null}
                      {forecastResult.upcomingRegularsCents !== 0 ? (
                        <tr>
                          <td>Регулярные, ещё не наступившие</td>
                          <td><Money cents={forecastResult.upcomingRegularsCents} currency={displayCurrency} /></td>
                        </tr>
                      ) : null}
                      <tr>
                        <td>Желаемая сумма</td>
                        <td>−<Money cents={forecastResult.goalCents} currency={displayCurrency} /></td>
                      </tr>
                      <tr className="forecastBudgetRow">
                        <td>Доступный остаток</td>
                        <td className={forecastResult.availableCents < 0 ? "negative" : ""}>
                          <Money cents={forecastResult.availableCents} currency={displayCurrency} />
                        </td>
                      </tr>
                      <tr>
                        <td>Daily goal ({forecastResult.daysLeftInclToday} дн. до конца)</td>
                        <td className={forecastResult.dailyGoalCents < 0 ? "negative" : ""}>
                          <Money cents={forecastResult.dailyGoalCents} currency={displayCurrency} />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                ) : null}

                <h3 className="recurHead">Регулярные платежи ({regularPayments.length})</h3>
                <p className="panelNote">
                  Ежемесячные/годовые обязательства. В прогнозе вычитаются те, чей день ещё не наступил
                  в этом месяце.
                </p>
                <ul className="recurList">
                  {regularPayments.map((rp) => (
                    <li key={rp.id} className={editingRegularId === rp.id ? "editing" : ""}>
                      <span className="recurName">
                        {rp.name}
                        {rp.category ? <span className="forecastMuted"> · {rp.category}</span> : null}
                      </span>
                      <span className="recurMeta">{regularPeriodLabel(rp)}</span>
                      <span className="recurAmt"><Money cents={rp.amountCents} currency={rp.currency} /></span>
                      <button type="button" className="textButton" title="Изменить" onClick={() => startEditRegular(rp)}>
                        ✎
                      </button>
                      <button type="button" className="textButton" title="Удалить" onClick={() => void removeRegular(rp.id)}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                {visibleRegularSuggestions.length > 0 ? (
                  <div className="suggestBlock">
                    <span className="suggestHead">Предложить из истории:</span>
                    <ul className="recurList">
                      {visibleRegularSuggestions.map((s) => (
                        <li key={s.key}>
                          <span className="recurName">
                            {s.name}
                            {s.category ? <span className="forecastMuted"> · {s.category}</span> : null}
                          </span>
                          <span className="recurMeta">
                            ~{s.dayOfMonth}-е · {s.monthsPresent}/6 мес
                          </span>
                          <span className="recurAmt"><Money cents={s.amountCents} currency={s.currency} />/мес</span>
                          <button
                            type="button"
                            className="textButton"
                            onClick={() => void acceptRegularSuggestion(s)}
                          >
                            + в регулярные
                          </button>
                          <button
                            type="button"
                            className="textButton"
                            title="Скрыть"
                            onClick={() => setDismissedRegulars((prev) => [...prev, s.key])}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="forecastAddForm">
                  <input
                    placeholder="Название"
                    value={regularDraft.name}
                    onChange={(e) => setRegularDraft({ ...regularDraft, name: e.target.value })}
                  />
                  <input
                    placeholder={`Сумма (${regularDraft.currency || displayCurrency})`}
                    inputMode="decimal"
                    value={regularDraft.amount}
                    onChange={(e) => setRegularDraft({ ...regularDraft, amount: e.target.value })}
                  />
                  <input
                    placeholder="Категория"
                    value={regularDraft.category}
                    onChange={(e) => setRegularDraft({ ...regularDraft, category: e.target.value })}
                  />
                  <select
                    value={regularDraft.periodicity}
                    onChange={(e) => setRegularDraft({ ...regularDraft, periodicity: e.target.value })}
                  >
                    <option value="monthly">Каждый месяц</option>
                    <option value="yearly">Раз в год</option>
                    <option value="every_n_months">Раз в N мес.</option>
                  </select>
                  {regularDraft.periodicity === "yearly" ? (
                    <input
                      placeholder="Месяц 1-12"
                      inputMode="numeric"
                      value={regularDraft.month}
                      onChange={(e) => setRegularDraft({ ...regularDraft, month: e.target.value })}
                    />
                  ) : null}
                  {regularDraft.periodicity === "every_n_months" ? (
                    <input
                      placeholder="Каждые N мес."
                      inputMode="numeric"
                      value={regularDraft.intervalMonths}
                      onChange={(e) => setRegularDraft({ ...regularDraft, intervalMonths: e.target.value })}
                    />
                  ) : null}
                  <input
                    placeholder="День 1-31"
                    inputMode="numeric"
                    value={regularDraft.dayOfMonth}
                    onChange={(e) => setRegularDraft({ ...regularDraft, dayOfMonth: e.target.value })}
                  />
                  <button type="button" className="secondaryButton" onClick={() => void saveRegular()}>
                    {editingRegularId ? "Сохранить" : "Добавить"}
                  </button>
                  {editingRegularId ? (
                    <button type="button" className="textButton" onClick={resetRegularForm}>
                      Отмена
                    </button>
                  ) : null}
                </div>

                <h3 className="recurHead">Займы ({loans.length})</h3>
                <p className="panelNote">
                  Долги в обе стороны и возмещения. Учитываются в прогнозе месяца, на который приходится дата.
                </p>
                <ul className="recurList">
                  {loans.map((loan) => (
                    <li key={loan.id} className={editingLoanId === loan.id ? "editing" : ""}>
                      <span className="recurName">{loan.name}</span>
                      <span className="recurMeta">
                        {LOAN_DIR_LABEL[loan.direction] ?? loan.direction} · {dmy(loan.dueDate)}
                        {loan.status === "settled" ? " · закрыт" : ""}
                      </span>
                      <span className="recurAmt">
                        {loan.direction === "owe" ? "−" : "+"}
                        <Money cents={loan.amountCents} currency={loan.currency} />
                      </span>
                      <button type="button" className="textButton" title="Изменить" onClick={() => startEditLoan(loan)}>
                        ✎
                      </button>
                      <button type="button" className="textButton" title="Удалить" onClick={() => void removeLoan(loan.id)}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                {visibleLoanSuggestions.length > 0 ? (
                  <div className="suggestBlock">
                    <span className="suggestHead">Найдено в категории «займ»:</span>
                    <ul className="recurList">
                      {visibleLoanSuggestions.map((s) => (
                        <li key={loanSuggestionKey(s)}>
                          <span className="recurName">{s.name}</span>
                          <span className="recurMeta">
                            {LOAN_DIR_LABEL[s.direction] ?? s.direction} · {dmy(s.sourceDate)}
                          </span>
                          <span className="recurAmt"><Money cents={s.amountCents} currency={s.currency} /></span>
                          <button type="button" className="textButton" onClick={() => acceptLoanSuggestion(s)}>
                            + заём
                          </button>
                          <button
                            type="button"
                            className="textButton"
                            title="Скрыть"
                            onClick={() => setDismissedLoans((prev) => [...prev, loanSuggestionKey(s)])}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="forecastAddForm">
                  <input
                    placeholder="Название / контрагент"
                    value={loanDraft.name}
                    onChange={(e) => setLoanDraft({ ...loanDraft, name: e.target.value })}
                  />
                  <input
                    placeholder={`Сумма (${loanDraft.currency || displayCurrency})`}
                    inputMode="decimal"
                    value={loanDraft.amount}
                    onChange={(e) => setLoanDraft({ ...loanDraft, amount: e.target.value })}
                  />
                  <select
                    value={loanDraft.direction}
                    onChange={(e) => setLoanDraft({ ...loanDraft, direction: e.target.value })}
                  >
                    <option value="owe">Мы должны отдать</option>
                    <option value="owed">Нам вернут</option>
                    <option value="reimbursement">Возмещение (страховая)</option>
                  </select>
                  <DateField
                    value={loanDraft.dueDate}
                    onChange={(iso) => setLoanDraft({ ...loanDraft, dueDate: iso })}
                  />
                  <button type="button" className="secondaryButton" onClick={() => void saveLoan()}>
                    {editingLoanId ? "Сохранить" : "Добавить"}
                  </button>
                  {editingLoanId ? (
                    <button type="button" className="textButton" onClick={resetLoanForm}>
                      Отмена
                    </button>
                  ) : null}
                </div>

                <p className="panelNote forecastAssume">
                  Текущий месяц. Регулярные и займы можно добавлять вручную или из подсказок (анализ
                  истории). Мультимесячный прогноз (+1/3/6/12) и закрытые месяцы — следующая фаза.
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
