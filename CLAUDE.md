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

- `app/money-counter.tsx` — the **entire UI**, one big client component (`"use client"`). Three tabs: **Операции** (main: period-filtered list, new/edit form, import panel), **Настройки** (accounts, categories, auto-rules), **Визуализация** (cashflow bars + category pie). Holds all state and data-loading; small presentational helpers (`MonthSelect`, `CategoryPie`) live in the same file. `app/page.tsx` just renders it.
- `app/globals.css` — all styling (tabs, lists, charts, pie, import panel).
- `lib/finance.ts` — **pure** money/date/format helpers: `parseMoneyInputToCents`, `parseFlexibleDate`/`normalizeDateInput`, `resolveSignedAmountCents`, `formatMoney`, `normalizeCurrency`, `normalizeColor`, `matchCategoryRule`, `accountTypes`.
- `lib/import.ts` — **pure, framework-free** bank-statement import engine. Entry point `analyzeImport(text, {defaultCurrency})` → `{delimiter, headers, dataRows, mapping, rows, …}`. Also `detectDelimiter`, `parseDelimited`, `guessMapping`, `buildRows`, `resolveRowCents`, `detectAmountSigned`, `FIELD_DEFS`. Handles CSV/TSV/`;`/`|`, quotes/BOM/CRLF, EN/RU/ES/DE/FR/IT headers, split debit/credit, fees, signed vs direction-column amounts, and a header-row finder for preamble lines.
- `db/index.ts` — `getD1()`, `getDb()` (drizzle), and `ensureSchema()` (the real runtime migration; see Gotchas).
- `app/api/*/route.ts` — handlers: `accounts`, `transactions` (GET supports `from`/`to`/`accountId`/`q`/`type`/`limit`), `import`, `categories`, `rules`, `rules/apply`, `periods`, `stats`.

### Import data flow (important)
Parsing happens **client-side** in `lib/import.ts`. The browser sends already-parsed rows to `POST /api/import` as `{ rows, accountId? }`. The route does NOT re-parse columns — it only validates date/amount, resolves the account, applies category rules, dedups, and batch-inserts. A bank statement has no "account" column, so the UI makes the user pick/create the target account (`accountId`).

## Data model & conventions

- **Money is integer cents** everywhere (`amount_cents`, `opening_balance_cents`). Convert at the edges only.
- **Dates are TEXT `YYYY-MM-DD`** (timezone-free). Range queries compare strings.
- **Currency lives on the account**, not the transaction. **Never sum across currencies** — group per-currency (`totalsByCurrencyToText` in the UI) or filter by a single currency (the `/api/stats` `currency` param). Account balance = opening balance + sum of its transactions (computed in SQL in `accounts` route).
- **Category is a free-text string** on `transactions.category` (the category *name*). The `categories` table is a managed vocabulary (for the picker + pie colors); identity is **case-insensitive** — keep all write paths consistent (compare via `LOWER(name)`).
- **Auto-categorization**: `category_rules` (pattern → category). Applied **only when a row's category is empty**, on import and on manual `POST /api/transactions`, via `matchCategoryRule` (case-insensitive substring match on description, then payee). `POST /api/rules/apply` retro-applies to uncategorized transactions.

## Gotchas (read before changing related code)

- **Schema migrations: edit `ensureSchema()` in `db/index.ts`.** It runs `CREATE TABLE/INDEX IF NOT EXISTS` on every request, so adding a table there makes it appear with no manual migration step. Mirror the change in `db/schema.ts` for `drizzle-kit`, but `db/schema.ts` is NOT what creates tables at runtime.
- **Date validation rejects impossible days.** `parseFlexibleDate`/`normalizeDateInput` return `null` for e.g. `2026-02-31` or `2026-06-31`. So **never use `YYYY-MM-31` as a generic month-end bound** — compute the real last day (`monthEnd()` in `money-counter.tsx` uses `new Date(year, month, 0)`). This previously caused range queries to silently drop their upper bound for 30-day months/February.
- **React compiler ESLint is strict** (errors, not warnings): (1) don't reassign a variable created during render — use pure/functional patterns (e.g. prefix-sum instead of a mutated accumulator); (2) don't call `setState` synchronously in a `useEffect` body — wrap async work in an async IIFE (`useEffect(() => { void (async () => { … })(); }, [...])`). `npm run lint` catches both.
- **Import dedup is DB-seeded only.** Fingerprints (`accountId|date|amountCents|description`) come from existing DB rows, so re-importing an overlapping period is idempotent, but two genuinely identical rows in one file both import.
- **A bank "Type" column is deliberately NOT mapped to `category`** (it's a payment method like "Card Payment", not a spending category). Real `Category`/`Категория` columns still map. This keeps the user's auto-rules in control of categorization.
- The transactions list uses `LIMIT` (500); always pair it with `from`/`to` period filters so rows aren't truncated.

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

## Conventions

- Code, identifiers, comments: English. UI strings: Russian. Money/dates as above.
- Match the existing single-file UI style and the route-handler error pattern (`toRouteErrorMessage`, which special-cases "no such table").
- Don't commit/push unless asked. Committing directly to `main` is fine for this project — do NOT create a feature branch first (this overrides the global "branch first on main" rule).
