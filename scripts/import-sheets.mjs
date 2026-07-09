#!/usr/bin/env node
// One-off migration: import a monthly "Money counter" Google-Sheets tab (exported
// as CSV) into Money Counter via POST /api/import (which auto-creates accounts by
// name+currency, applies category rules, and dedups — see app/api/import/route.ts).
//
// Usage:
//   node scripts/import-sheets.mjs <file.csv> [more.csv ...]            # DRY RUN (no writes)
//   node scripts/import-sheets.mjs <file.csv> --post http://localhost:8787   # real import
//   ...optional: --chunk 1000
//
// The monthly tabs all share the format of 2026-04: a summary block on top, then a
// transactions table whose rows have col A = "‹weekday› DD.MM.YYYY" and col B =
// "➕/➖ <account>". We read ONLY: A date, B account+sign, D category, E description,
// H (idx 7) amount in the account currency, N (idx 13) manual FX-loss for transfers.

import { readFileSync } from "node:fs";

// --- account mapping: normalized sheet label -> { name, currency } -----------
// Names mirror the СЧЕТА summary block; currencies per the user's list.
const ACCOUNTS = {
  "garna": { name: "Garna", currency: "USD" },
  "ledger": { name: "Ledger", currency: "USD" },
  "deel": { name: "DEEL", currency: "USD" }, // Deel payroll account (2025-06..10): salary in, then moved to Revolut VD-USD
  "kasikorn": { name: "Kasikorn", currency: "THB" },
  "krungsri": { name: "Krungsri", currency: "THB" },
  "bbva": { name: "BBVA", currency: "EUR" },
  // Cash accounts in the app are "CASH EUR" and "CASH THB" (currency lives on the
  // account, so the euro/baht wallets are separate rows). The import route matches
  // by name+currency exactly, so these MUST be the full names, not bare "CASH".
  "наличные": { name: "CASH EUR", currency: "EUR" },
  "cash": { name: "CASH EUR", currency: "EUR" },
  "kast ak": { name: "KAST AK", currency: "USD" },
  "kast vd": { name: "KAST VD", currency: "USD" },
  "kast": { name: "KAST VD", currency: "USD" }, // bare "Kast" = Kast VD (per user)
  "revolut vd eur": { name: "REVOLUT (VD EUR)", currency: "EUR" },
  "revolut vd usd": { name: "REVOLUT (VD USD)", currency: "USD" },
  "revolut ak": { name: "REVOLUT (AK)", currency: "EUR" },
  "tinkoff ak": { name: "TINKOFF (AK)", currency: "RUB" },
  "tinkoff vd": { name: "TINKOFF (VD)", currency: "RUB" },
  "t биржа": { name: "Т-Биржа", currency: "USD" },
  "т биржа": { name: "Т-Биржа", currency: "USD" },
  "t инвестиции": { name: "Т-Инвестиции", currency: "RUB" },
  "т инвестиции": { name: "Т-Инвестиции", currency: "RUB" },
  "t вклад18": { name: "Т-Вклад18", currency: "RUB" },
  "т вклад18": { name: "Т-Вклад18", currency: "RUB" },
  "вклад": { name: "Т-Вклад18", currency: "RUB" }, // sheet writes "На вклад" for the Т-Вклад18 deposit (2025-09)
};
// VITA is a virtual/imaginary account — never import it.
const SKIP = new Set(["vita"]);

// --- helpers -----------------------------------------------------------------

// RFC4180-ish CSV parser: handles quoted fields with embedded commas/quotes/newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c === "\r") {
      // ignore; handled by \n
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Sheet number: "  5 550,00 " -> 5550.00 ; "–"/""/etc -> NaN.
function num(s) {
  if (s == null) return NaN;
  const cleaned = String(s).replace(/[\s ]/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

// "ср 01.04.2026" -> "2026-04-01" ; null if not a date cell.
function isoDate(s) {
  const m = String(s ?? "").match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Strip the ➕/➖ marker and normalize an account label for the map lookup.
function normLabel(s) {
  return String(s ?? "")
    .replace(/[➕➖]/g, "")
    .replace(/[-–—]/g, " ")
    .replace(/[\s ]+/g, " ")
    .trim()
    .toLowerCase();
}

// The sheet gained an extra column in April 2026: older tabs keep the amount
// in G (idx 6) and the transfer FX-loss in M (idx 12), newer ones in H (idx 7)
// and N (idx 13). Detect per file by which column actually holds numbers on
// transaction rows.
function detectLayout(records) {
  let g = 0;
  let h = 0;
  for (const rec of records) {
    if (!isoDate(rec[0]) || !/[➕➖]/.test(String(rec[1] ?? ""))) continue;
    if (Number.isFinite(num(rec[6]))) g += 1;
    if (Number.isFinite(num(rec[7]))) h += 1;
  }
  return h >= g
    ? { amount: 7, loss: 13, eur: 11, name: "H/N (апрель+)" }
    : { amount: 6, loss: 12, eur: 10, name: "G/M (до апреля)" };
}

// --- transform one CSV file into import rows ---------------------------------
function buildRows(records, report, layout, opts = {}) {
  const out = [];
  for (const rec of records) {
    const date = isoDate(rec[0]);
    const bRaw = rec[1] ?? "";
    const isIncome = bRaw.includes("➕");
    const isExpense = bRaw.includes("➖");
    // A transaction row: col A is a date and col B carries a +/- marker.
    if (!date || (!isIncome && !isExpense)) continue;

    const label = normLabel(bRaw);
    if (SKIP.has(label)) { report.skippedVita += 1; continue; }
    let acct = ACCOUNTS[label];
    if (!acct) { report.unmapped.set(bRaw.trim(), (report.unmapped.get(bRaw.trim()) ?? 0) + 1); continue; }

    const amount = num(rec[layout.amount]); // "Чек" (H or G, see detectLayout)
    if (!Number.isFinite(amount) || amount === 0) { report.badAmount += 1; continue; }

    // THB-era sheets (--home-thb): the home/equivalent column (layout.eur) is THB,
    // not EUR. "наличные" defaults to CASH EUR, but a cash row with NO conversion
    // (native amount == THB-home equivalent) is leftover baht cash and belongs on
    // the separate CASH THB account. In EUR-era sheets the home column IS EUR, so
    // without --home-thb this never fires and behaviour is unchanged.
    if (opts.homeThb && (label === "наличные" || label === "cash")) {
      const home = num(rec[layout.eur]);
      if (Number.isFinite(home) && Math.abs(amount - home) < 0.01) {
        acct = { name: "CASH THB", currency: "THB" };
        report.cashThb += 1;
      }
    }

    const rawCat = String(rec[3] ?? "").trim();
    const category = rawCat === "N/A" ? "" : rawCat;
    const description = String(rec[4] ?? "").trim();

    // Inter-account transfer: description "На <known account>".
    const destMatch = description.match(/^На\s+(.+)$/i);
    const dest = destMatch ? ACCOUNTS[normLabel(destMatch[1])] : null;
    if (dest) {
      if (!isExpense) report.transferWrongSign += 1; // expected ➖ on the debit side
      const loss = Number.isFinite(num(rec[layout.loss])) ? num(rec[layout.loss]) : 0; // "ПОТЕРИ КУРСА" (N or M)
      const received = Math.round((amount - loss) * 100) / 100;
      report.transfers += 1;
      // debit on the source account...
      out.push({ accountName: acct.name, currency: acct.currency, date, amount, direction: "expense", description, category: "" });
      // ...credit on the destination, net of the manual FX loss, in its currency.
      if (received > 0) {
        out.push({ accountName: dest.name, currency: dest.currency, date, amount: received, direction: "income", description: `Перевод с ${acct.name}`, category: "" });
      } else {
        report.transferNonPositive += 1;
      }
      // record destination label as "seen as account" for completeness
      report.destinations.add(destMatch[1].trim());
      continue;
    }
    if (destMatch) report.destinations.add(`${destMatch[1].trim()} (не счёт → расход)`);

    out.push({ accountName: acct.name, currency: acct.currency, date, amount, direction: isIncome ? "income" : "expense", description, category });

    // «Снятие наличных»: the sheet credited CASH with the withdrawn amount via
    // a formula the CSV export loses — emit the CASH (EUR) income leg too. For
    // non-EUR accounts the EUR-value column carries the converted amount.
    // EXACT description only: fuzzy mentions («Всякое (снятие наличных)») are
    // judgment calls — the user reviewed and rejected one — so they are only
    // reported, never auto-credited. Link the pairs in the app afterwards:
    // «Найти переводы» matches the same-currency ones automatically.
    const mentionsCash = /снятие налич/i.test(description);
    const exactCash = /^снятие наличных$/i.test(description.trim());
    if (isExpense && mentionsCash && !exactCash) {
      report.cashMentions.push(`${date} ${acct.name} «${description}»`);
    }
    if (isExpense && exactCash && acct.name !== "CASH EUR" && acct.name !== "CASH THB") {
      if (opts.homeThb && acct.currency !== "EUR") {
        // THB-era: the home column is THB (not EUR), so the EUR cash received can't
        // be read from the CSV, and a THB→EUR withdrawal is cross-currency (the app
        // never invents an FX rate). Import ONLY the THB debit; the CASH EUR credit
        // is entered and linked manually in the app afterwards.
        report.cashCrossThb.push(`${date} ${acct.name} «${description}» ${amount.toFixed(2)}`);
      } else {
        const eurValue = num(rec[layout.eur]);
        const received = Number.isFinite(eurValue) && eurValue > 0
          ? Math.round(eurValue * 100) / 100
          : acct.currency === "EUR"
            ? amount
            : NaN;
        if (Number.isFinite(received)) {
          out.push({ accountName: "CASH EUR", currency: "EUR", date, amount: received, direction: "income", description, category: "" });
          report.cashWithdrawals += 1;
        } else {
          report.cashNoEur += 1;
        }
      }
    }
  }
  return out;
}

// --- main --------------------------------------------------------------------
const argv = process.argv.slice(2);
let postUrl = null;
let chunk = 1000;
let homeThb = false;
const files = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--post") { postUrl = argv[i + 1]; i += 1; }
  else if (argv[i] === "--chunk") { chunk = Number(argv[i + 1]) || 1000; i += 1; }
  else if (argv[i] === "--home-thb") { homeThb = true; }
  else files.push(argv[i]);
}
if (files.length === 0) {
  console.error("Usage: node scripts/import-sheets.mjs <file.csv> [...] [--post <baseUrl>] [--chunk N]");
  process.exit(1);
}

const report = {
  unmapped: new Map(), destinations: new Set(), transfers: 0, skippedVita: 0,
  badAmount: 0, transferWrongSign: 0, transferNonPositive: 0,
  cashWithdrawals: 0, cashNoEur: 0, cashMentions: [],
  cashThb: 0, cashCrossThb: [],
};
let rows = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const recs = parseCsv(text);
  const layout = detectLayout(recs);
  const built = buildRows(recs, report, layout, { homeThb });
  console.log(`• ${file}: ${recs.length} строк CSV → ${built.length} операций [раскладка ${layout.name}${homeThb ? ", дом. валюта THB" : ""}]`);
  rows = rows.concat(built);
}

// Per-account summary (signed sum, in account currency).
const byAcct = new Map();
for (const r of rows) {
  const key = `${r.accountName} [${r.currency}]`;
  const signed = (r.direction === "expense" ? -1 : 1) * r.amount;
  const a = byAcct.get(key) ?? { n: 0, sum: 0 };
  a.n += 1; a.sum += signed; byAcct.set(key, a);
}
const cats = new Set(rows.map((r) => r.category).filter(Boolean));

console.log(`\n=== ИТОГО: ${rows.length} операций (включая ${report.transfers} переводов = по 2 операции) ===`);
console.log("\nПо счетам (кол-во | знаковая сумма в валюте счёта):");
for (const [k, v] of [...byAcct.entries()].sort()) {
  console.log(`  ${k.padEnd(24)} ${String(v.n).padStart(4)} | ${v.sum.toFixed(2)}`);
}
console.log(`\nКатегорий (Статья): ${cats.size} → ${[...cats].sort().join(", ")}`);
console.log(`Назначения переводов «На …»: ${[...report.destinations].sort().join("; ") || "—"}`);
if (report.skippedVita) console.log(`Пропущено VITA: ${report.skippedVita}`);
if (report.badAmount) console.log(`Пропущено (нет/0 суммы): ${report.badAmount}`);
if (report.transferWrongSign) console.log(`⚠ Переводы с неожиданным знаком (не ➖): ${report.transferWrongSign}`);
if (report.transferNonPositive) console.log(`⚠ Перевод с приходом ≤ 0 (пропущен кредит): ${report.transferNonPositive}`);
if (report.cashThb) console.log(`Наличные в батах → CASH THB (без конвертации): ${report.cashThb}`);
if (report.cashWithdrawals) console.log(`Снятий наличных → приход на CASH EUR: ${report.cashWithdrawals} (связать в приложении: «Найти переводы»)`);
if (report.cashNoEur) console.log(`⚠ Снятие наличных БЕЗ EUR-эквивалента (CASH-приход пропущен): ${report.cashNoEur}`);
if (report.cashCrossThb.length) {
  console.log(`⚠ Кросс-валютные снятия THB→EUR — залит ТОЛЬКО расход, нога CASH EUR НЕ создана (добавить и связать вручную):`);
  for (const line of report.cashCrossThb) console.log(`  ${line}`);
}
if (report.cashMentions.length) {
  console.log(`⚠ Упоминают снятие, но описание не точное — CASH-приход НЕ создан (реши вручную):`);
  for (const line of report.cashMentions) console.log(`  ${line}`);
}
if (report.unmapped.size) {
  console.log(`\n⚠ НЕИЗВЕСТНЫЕ счета в колонке B (НЕ импортированы) — добавь в ACCOUNTS:`);
  for (const [k, n] of [...report.unmapped.entries()].sort()) console.log(`  «${k}» ×${n}`);
}

if (!postUrl) {
  console.log(`\n[DRY RUN] ничего не отправлено. Для импорта добавь: --post <baseUrl>`);
  process.exit(0);
}

// Real import: chunked POST /api/import.
console.log(`\n=== POST ${postUrl}/api/import (чанки по ${chunk}) ===`);
for (let i = 0; i < rows.length; i += chunk) {
  const slice = rows.slice(i, i + chunk);
  const res = await fetch(`${postUrl}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows: slice }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`  чанк ${i}-${i + slice.length}: HTTP ${res.status}`, data); process.exit(1); }
  console.log(`  чанк ${i}-${i + slice.length}: +${data.createdTransactions} оп, +${data.createdAccounts} счетов, дублей ${data.duplicates}, отклонено ${data.rejected?.length ?? 0}`);
  if (data.rejected?.length) console.log("    отклонены:", JSON.stringify(data.rejected.slice(0, 10)));
}
console.log("Готово.");
