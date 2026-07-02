import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getD1() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return env.DB;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

// Reporting periods are calendar months. The current (and any future) month is
// always open; a past month is closed ("frozen") unless explicitly reopened —
// reopened months are the rows of open_periods. Dates in the app are
// timezone-free YYYY-MM-DD strings, so "current month" is the UTC one.
export function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

// Distinct closed months among the given YYYY-MM-DD dates, sorted. An empty
// result means every date is writable.
export async function findClosedMonths(dates: string[]) {
  const current = currentMonthKey();
  const past = [...new Set(dates.map((date) => date.slice(0, 7)))].filter(
    (month) => month < current
  );
  if (past.length === 0) return [];
  // Chunked IN lists: D1 caps bound parameters at 100 per statement, and a
  // large historical import can span more distinct months than that.
  const reopened = new Set<string>();
  for (let offset = 0; offset < past.length; offset += 50) {
    const chunk = past.slice(offset, offset + 50);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await getD1()
      .prepare(`SELECT month FROM open_periods WHERE month IN (${placeholders})`)
      .bind(...chunk)
      .all<{ month: string }>();
    for (const row of rows.results ?? []) reopened.add(row.month);
  }
  return past.filter((month) => !reopened.has(month)).sort();
}

export async function ensureSchema() {
  const d1 = getD1();

  await d1.batch([
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        bank_name TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL DEFAULT 'EUR',
        type TEXT NOT NULL DEFAULT 'checking',
        opening_balance_cents INTEGER NOT NULL DEFAULT 0,
        color TEXT NOT NULL DEFAULT '#2563eb',
        archived_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    d1.prepare("CREATE INDEX IF NOT EXISTS accounts_name_idx ON accounts (name)"),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS accounts_archived_at_idx ON accounts (archived_at)"
    ),
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        payee TEXT NOT NULL DEFAULT '',
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'cleared',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      )
    `),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS transactions_account_id_idx ON transactions (account_id)"
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions (date)"
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS transactions_amount_cents_idx ON transactions (amount_cents)"
    ),
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#2563eb',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS categories_name_idx ON categories (name)"
    ),
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS category_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS category_rules_category_idx ON category_rules (category)"
    ),
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS exchange_rates (
        date TEXT NOT NULL,
        currency TEXT NOT NULL,
        usd_rate REAL NOT NULL,
        PRIMARY KEY (date, currency)
      )
    `),
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS open_periods (
        month TEXT PRIMARY KEY,
        opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    d1.prepare(`
      CREATE TABLE IF NOT EXISTS currencies (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        symbol TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    // Seed the common currencies, plus any already used by accounts. OR IGNORE
    // keeps it idempotent across the per-request ensureSchema() call.
    d1.prepare(
      `INSERT OR IGNORE INTO currencies (code, name, symbol) VALUES
         ('USD', 'US Dollar', '$'),
         ('EUR', 'Euro', '€'),
         ('THB', 'Thai Baht', '฿'),
         ('RUB', 'Russian Ruble', '₽')`
    ),
    d1.prepare(
      "INSERT OR IGNORE INTO currencies (code) SELECT DISTINCT currency FROM accounts WHERE currency <> ''"
    ),
  ]);
}
