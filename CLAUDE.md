# Money Counter — agent guide

Personal finance app: track ~10 bank accounts (multiple currencies), their
transactions, balances, categories, and bank-statement imports (CSV/TSV). Single
user, self-hosted. See `README.md` for the user-facing intro and Docker demo;
this file is the working context for code changes.

## Stack

- **React 19** client UI rendered by **vinext** (a Vite-based Next-like framework; `app/` routing, `app/api/*/route.ts` handlers).
- **Cloudflare Workers + D1** (SQLite) as the runtime and database. D1 binding is named `DB` (`.openai/hosting.json`).
- **Drizzle ORM** schema in `db/schema.ts` (used by `drizzle-kit`), but at runtime tables are created by `ensureSchema()` — see Gotchas.
- Tailwind v4 is installed but the UI is plain CSS in `app/globals.css`.
- No test runner is configured (see Testing).

## Commands

- `npm run dev` — local dev. vinext serves on the first free port from **3000** up (3001, 3002, …); miniflare auto-creates a local D1. Watch the log for the URL.
- `npm run build` — production build; run this to verify changes compile end-to-end.
- `npm run lint` — ESLint with the strict React-compiler rules (see Gotchas). **Always run before finishing.**
- `npm run db:generate` — regenerate Drizzle migrations after editing `db/schema.ts` (not required to make tables work at runtime).
- `npx tsc --noEmit` — typecheck.

(`npm` and `pnpm` lockfiles both exist; either works.)

## Deploy

**Deploy after every code change by default** — commit to `main`, push, then run
the two steps below. The user demos the live app to a customer who cannot look at
the dev laptop, so changes must reach the running deployment automatically. Skip
deploying ONLY when the user explicitly says not to (e.g. "не выкатывай").

Exactly these two steps — do NOT change the image tag.

1. Build & push:
   ```bash
   docker buildx build --ssh default --platform linux/amd64,linux/arm64 -f Dockerfile . --tag ghcr.io/sapphireqt/money_counter:build-002 --push
   ```
2. Restart:
   ```bash
   kubectl --context lab rollout restart deploy money-counter -n money-counter
   ```

## Architecture / key files

- `app/money-counter.tsx` — the **entire UI**, one big client component (`"use client"`). A **left sidebar** switches sections: **Операции** (sticky summary cards + sticky toolbar with a capsule month pager, captioned filters and «Найти переводы»; day-grouped list with a silent marker column — «⇄» transfer legs, «⚠️» flagged rows — and a per-row «⋮» kebab menu (viewport-fixed so a short list can't clip it, flips up near the viewport bottom); right rail: «Счета» panel [Остаток | В валюте счёта | Траты, rate easter-egg popup on the native figure], «Расходы по категориям» bars), **Настройки** (sub-tabs **Счета / Категории / Валюты**; drag-and-drop ordering; auto-rules live under Категории), **Визуализация** (cashflow bars + category pie), plus empty placeholders **Прогнозирование** and **Займы** (live backlog). **Every add/edit form opens in a modal** — mirror this pattern for new lists. Holds all state and data-loading; helpers (`Money`, `Flagged`, `ClampedName`, `DateField`, `CategoryPie`, `CategoryBars`, `MonthPicker`, `convertTotals`) live in the same file. `app/page.tsx` just renders it.
- `app/globals.css` — all styling (sidebar nav, lists, modals, charts, pie, import panel).
- `lib/finance.ts` — **pure** money/date/format helpers: `parseMoneyInputToCents`, `parseFlexibleDate`/`normalizeDateInput`, `resolveSignedAmountCents`, `formatMoney`, `normalizeCurrency`, `normalizeColor`, `matchCategoryRule`, `accountTypes`.
- `lib/import.ts` — **pure, framework-free** bank-statement import engine. Entry point `analyzeImport(text, {defaultCurrency})` → `{delimiter, headers, dataRows, mapping, rows, …}`. Also `detectDelimiter`, `parseDelimited`, `guessMapping`, `buildRows`, `resolveRowCents`, `detectAmountSigned`, `FIELD_DEFS`. Handles CSV/TSV/`;`/`|`, quotes/BOM/CRLF, EN/RU/ES/DE/FR/IT headers, split debit/credit, fees, signed vs direction-column amounts, and a header-row finder for preamble lines.
- `db/index.ts` — `getD1()`, `getDb()` (drizzle), and `ensureSchema()` (the real runtime migration; see Gotchas).
- `app/api/*/route.ts` — handlers: `accounts` (GET also `?asOf=YYYY-MM-DD` → balance as of a date, exclusive of it; POST/PATCH/DELETE), `transactions` (GET `from`/`to`/`accountId`/`q`/`type`/`limit`; POST/PATCH/DELETE — DELETE of a transfer leg unlinks the partner), `transfers` (POST links expense+income pairs into «Перемещение», single or `{pairs:[…]}` batch; DELETE `?group=` unlinks) + `transfers/detect` (GET conservative auto-candidates: same currency+amount, different accounts, ±3 days), `import`, `categories` (CRUD; PATCH renames, guards case-insensitive clashes), `rules` (CRUD), `rules/apply` (`?overwrite=1` re-runs over ALL transactions; `?ruleId=N` applies ONE rule with overwrite; both skip transfer legs), `currencies` (CRUD — the currency reference book), `rates` (FX + crypto, see Data model), `periods` (GET months with transactions + the server's current UTC month), `stats` (excludes transfer legs). No bulk-delete endpoint exists (delete is per-id).

### Import data flow (important)
Parsing happens **client-side** in `lib/import.ts`. The browser sends already-parsed rows to `POST /api/import` as `{ rows, accountId? }`. The route does NOT re-parse columns — it only validates date/amount, resolves the account, applies category rules, dedups, and batch-inserts. A bank statement has no "account" column, so the UI makes the user pick/create the target account (`accountId`). **Omit `accountId`** and the route instead resolves each row's account by `accountName`+`currency`, **auto-creating missing accounts** (opening balance 0) — this is how a multi-account historical import works (`scripts/import-sheets.mjs`).

## Data model & conventions

- **Money is integer cents** everywhere (`amount_cents`, `opening_balance_cents`). Convert at the edges only.
- **Dates are TEXT `YYYY-MM-DD`** (timezone-free). Range queries compare strings.
- **Currency lives on the account**, not the transaction. **Never sum across currencies** in storage/SQL — group per-currency or filter by a single currency (the `/api/stats` `currency` param). Account balance = opening balance + sum of its transactions (computed in SQL in `accounts` route).
- **Currencies are a reference book** (`currencies` table: `code` PK, `name`, `symbol`), seeded in `ensureSchema()` and managed under Настройки → Валюты; the account form picks its currency from it. `normalizeCurrency` accepts **3–5 letters** (fiat + crypto tickers like `USDT`).
- **Display-currency conversion (UI only)**: the user can view all money in one chosen currency. `GET /api/rates?date&currencies` returns USD-based rates: fiat from the keyless **Frankfurter** API; crypto tickers (TRX, BTC…) from **Kraken's** keyless public OHLC API (`<CODE>USD` daily close, stored as `usd_rate = 1/close`), falling back to **Binance** (`<CODE>USDT` daily close, USDT≈USD) for dates beyond Kraken's window; **USDT is pegged to exactly 1** by design (user's accounting convention, keeps Binance-quoted conversions consistent). All cached in `exchange_rates` (historical rates are immutable). `convertTotals()` converts per-currency maps to the display currency at **one rate date per view** (`periodRateDate`): the **last day of the selected past month**, or the **last day of the previous month** when the current month is shown — every number on screen (cards, rows, bars, «Счета» panel) uses that single date, so rates never move during a month and «начало + приход − расход = конец» reconciles. Hovering a converted balance in the «Счета» panel reveals an easter-egg popup with the native amount and the exact rate. A currency with no rate is summed-out and **flagged** in the UI (never silently wrong).
- **Past periods are a historical VIEW, not a lock**: when the selected month is before the current (UTC) one, the «Счета» panel and the «Баланс на конец периода» card show balances as of the period end (`?asOf=<next month>-01`, converted at the period's last-day rate). Nothing is frozen or snapshotted and everything stays editable — edits into past months simply recalculate the historical numbers. This is deliberate (the user compares spending month-to-month by flipping periods); do NOT reintroduce closed-period write guards.
- **Manual list order**: `accounts.sort_order` / `categories.sort_order` (default 9999 = alphabetical tail) set by drag-and-drop in Настройки (`POST /api/accounts/reorder`, `/api/categories/reorder` with `{ids}`). Both GET endpoints `ORDER BY sort_order, LOWER(name)`, so every dropdown, the «Счета» panel, and the filters follow it.
- **Account lifetime**: optional `accounts.opened_at`/`closed_at` (null = «всегда»; new accounts default opened_at to today in the form; import-created ones stay null). The opening balance **materializes ON opened_at** (excluded from earlier `asOf` balances — a March-created account doesn't leak into January's history), operation dates are validated against the range in transactions POST/PATCH, transfer creation, and import (per-row reject), and the «Счета» panel hides the account outside the range — but only while its balance is zero (a non-zero balance always shows, so money never silently leaves «Итого»). Closing ≠ archiving: history stays visible.
- **Category is a free-text string** on `transactions.category` (the category *name*). The `categories` table is a managed vocabulary (for the picker + pie colors); identity is **case-insensitive** — keep all write paths consistent (compare via `LOWER(name)`).
- **Auto-categorization**: `category_rules` (pattern → category). Applied **only when a row's category is empty**, on import and on manual `POST /api/transactions`, via `matchCategoryRule` (case-insensitive substring match on description, then payee). `POST /api/rules/apply` retro-applies to uncategorized transactions.
- **Attention flags**: `transactions.flagged` (+ free-text `notes` as the explanation) — the «⚠️ Требует внимания» checkbox in the edit form. Purely visual: a ⚠️ marker in the marker column with the note as a fast tooltip, «⚠️» filter toggle, `GET /api/transactions?flagged=1`. Used to mark import oddities for later review.
- **Transfers («Перемещение»)**: a movement between own accounts is TWO transaction rows (expense on A + income on B) sharing one `transactions.transfer_group` id. Linked legs still count toward **balances** (each leg belongs to its account) but are **excluded from income/expense cards, category bars, the pie, and `/api/stats`**, and their `category` is cleared on link. Creating/linking: the add modal's type «Перемещение между счетами» creates BOTH legs atomically (`POST /api/transfers {create}`; cross-currency asks for the received amount — the app never invents an FX rate); editing an operation and switching its type links it to an opposite-sign partner; the «Найти переводы» button batch-links detected pairs. Unlink: ✂ on the merged row. The operations list collapses two loaded legs into one «A → B» row; a leg whose partner is filtered out renders alone with a badge. Different-currency transfers are linked manually (detect is same-currency by design).

## Gotchas (read before changing related code)

- **Schema migrations: edit `ensureSchema()` in `db/index.ts`.** It runs `CREATE TABLE/INDEX IF NOT EXISTS` on every request, so adding a table there makes it appear with no manual migration step. Mirror the change in `db/schema.ts` for `drizzle-kit`, but `db/schema.ts` is NOT what creates tables at runtime.
- **Date validation rejects impossible days.** `parseFlexibleDate`/`normalizeDateInput` return `null` for e.g. `2026-02-31` or `2026-06-31`. So **never use `YYYY-MM-31` as a generic month-end bound** — compute the real last day (`monthEnd()` in `money-counter.tsx` uses `new Date(year, month, 0)`). This previously caused range queries to silently drop their upper bound for 30-day months/February.
- **React compiler ESLint is strict** (errors, not warnings): (1) don't reassign a variable created during render — use pure/functional patterns (e.g. prefix-sum instead of a mutated accumulator); (2) don't call `setState` synchronously in a `useEffect` body — wrap async work in an async IIFE (`useEffect(() => { void (async () => { … })(); }, [...])`). `npm run lint` catches both.
- **Import dedup is DB-seeded only.** Fingerprints (`accountId|date|amountCents|description`) come from existing DB rows, so re-importing an overlapping period is idempotent, but two genuinely identical rows in one file both import.
- **A bank "Type" column is deliberately NOT mapped to `category`** (it's a payment method like "Card Payment", not a spending category). Real `Category`/`Категория` columns still map. This keeps the user's auto-rules in control of categorization.
- The transactions list uses `LIMIT` (500); always pair it with `from`/`to` period filters so rows aren't truncated.
- **Crypto rate sources are a chain: Kraken (~720-day window, USD-quoted) → Binance (full history since a pair's listing, USDT-quoted).** A coin neither lists stays missing → flagged («нет курса»). `api.binance.com` is geo-blocked in some jurisdictions — if the deployment moves, verify egress. Never accept a candle from a DIFFERENT day than requested, and never CACHE today's candle (it is still forming) — both would poison the immutable `exchange_rates` cache.
- **Frankfurter rejects the whole request (HTTP 422) if `quotes` contains any unsupported code** — it does NOT silently skip them. `/api/rates` therefore partitions codes via `GET /v2/currencies` first and sends only supported ones; everything else goes to the Kraken fallback. Don't put crypto tickers into the Frankfurter request.
- **`Intl.NumberFormat` throws on non-ISO (4–5-letter) currency codes** like `USDT`. `formatMoneyParts` in `lib/finance.ts` has a fallback (plain number + code suffix) — route any money formatting through it, never call Intl with a raw account currency elsewhere.
- **Never use a raw `<input type="date">`** — Chrome formats it per the BROWSER locale and ignores the page `lang="ru"`, so users see mm/dd/yyyy. Use the `DateField` component (our дд.мм.гггг face over a hidden native input that supplies the calendar via `showPicker()` and the ISO value).
- **Two layout traps that already bit twice**: (1) a global `table { min-width: 760px }` exists — new tables in narrow containers must override it (`min-width: 0`); (2) a grid auto track's automatic minimum is the item's min-content, so a column with a wide table inside refuses to shrink and slides under its neighbour — `.mainColumn`/`.rightRail` pin their track with `grid-template-columns: minmax(0, 1fr)`; do the same for new rails/columns (especially scroll containers).
- **Two transaction datasets in the UI**: `transactions` (list filters applied — ONLY for the operations list) vs `periodTransactions` (whole month, unfiltered — cards, «Траты», category bars, dropdown options). Hang new analytics on `periodTransactions`, list rendering on `transactions`.
- **The search filter `q` goes into SQL `LIKE`** — `_` and `%` in the query are wildcards, not literals (e.g. searching `__t` matches everything). Known quirk, fine for a single user.
- **`ca-certificates` in the Dockerfile is required** for outbound HTTPS: workerd verifies TLS against the system store, which `node:slim` lacks — without it the FX-rate fetch fails with «unable to get local issuer certificate». Don't remove that `apt-get` line.

## Testing

No test runner. Verify changes by layer:

- **Pure libs (`lib/finance.ts`, `lib/import.ts`)** run in Node with type-stripping. They use extensionless relative imports (`./finance`), which Node ESM won't resolve, so add a tiny resolve hook:
  ```js
  // resolve-ts.mjs
  import { existsSync } from "node:fs";
  export async function resolve(spec, ctx, next) {
    if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/.test(spec)) {
      const url = new URL(spec + ".ts", ctx.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(spec, ctx);
  }
  // register.mjs: import { register } from "node:module"; register("./resolve-ts.mjs", import.meta.url);
  ```
  Then `node --experimental-strip-types --import ./register.mjs your-test.ts`, importing libs by absolute path.
- **API + D1 flows**: `npm run dev`, then `curl`/`fetch` the endpoints (miniflare gives a real local D1). Create an account first, then import/transactions. The local SQLite lives at `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` (the one with an `accounts` table) — inspect/clean it with `sqlite3` directly. Remember to clean up test rows.
- A known-good fixture: a Revolut statement is comma-delimited despite a `.tsv` extension; its movement total reconciles to `finalBalance − balanceBeforeFirstRow`.
- **UI flows**: drive the real app with headless Chrome + CDP over Node's native WebSocket (no Playwright installed): launch `"/Applications/Google Chrome.app/.../Google Chrome" --headless=new --remote-debugging-port=9223`, `PUT /json/new?<url>`, then `Runtime.evaluate`/`Page.captureScreenshot`. Gotchas: wrap evaluate code in IIFEs (top-level `const` redeclaration across evaluates poisons the page context), sleep between a click and reading the DOM (React batches), set React selects via the native value setter + a bubbling `change` event, dispatch `mouseover` (not `mouseenter`) for hover handlers, and override `window.confirm` AFTER the page loads.
- **Monthly Google-Sheets import**: use the **`import-month` skill** (`.claude/skills/import-month/SKILL.md`) — pre-scan, dry-run, prod import via port-forward, verification and post-processing, with the known column-layout history and pitfalls. The underlying tool: `scripts/import-sheets.mjs` (dry-run by default, `--post <baseUrl>` writes; per-file column-layout detection; exact «Снятие наличных» rows also emit a CASH income leg).

## Conventions

- Code, identifiers, comments: English. UI strings: Russian. Money/dates as above.
- Match the existing single-file UI style and the route-handler error pattern (`toRouteErrorMessage`, which special-cases "no such table").
- After making code changes, the default is to commit to `main`, push, and deploy (see Deploy) automatically — do NOT wait to be asked, and do NOT create a feature branch. This overrides the global "commit/push only when asked" and "branch first on main" rules. The only exception is when the user explicitly says not to commit/deploy.
