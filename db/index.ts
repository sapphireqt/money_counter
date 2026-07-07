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

// Reporting periods are calendar months. Dates in the app are timezone-free
// YYYY-MM-DD strings, so "current month" is the UTC one; months before it are
// shown by the UI as a historical end-of-period view (they stay editable).
export function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
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
        sort_order INTEGER NOT NULL DEFAULT 9999,
        opened_at TEXT,
        closed_at TEXT,
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
        transfer_group TEXT,
        flagged INTEGER NOT NULL DEFAULT 0,
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
        sort_order INTEGER NOT NULL DEFAULT 9999,
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

  // transfer_group and flagged arrived after the transactions table shipped,
  // and CREATE TABLE IF NOT EXISTS never adds columns to an existing table —
  // so ALTER and swallow the "duplicate column" error on every later run. The
  // index is created here (not in the batch above) because on a pre-migration
  // DB the column does not exist until the ALTER lands.
  try {
    await d1
      .prepare("ALTER TABLE transactions ADD COLUMN transfer_group TEXT")
      .run();
  } catch {
    // duplicate column name — already migrated
  }
  try {
    await d1
      .prepare(
        "ALTER TABLE transactions ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0"
      )
      .run();
  } catch {
    // duplicate column name — already migrated
  }
  // Custom manual ordering for the reference lists (Настройки, drag-and-drop).
  // 9999 = "not ordered yet": such rows fall back to the alphabetical tail.
  for (const table of ["accounts", "categories"]) {
    try {
      await d1
        .prepare(
          `ALTER TABLE ${table} ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 9999`
        )
        .run();
    } catch {
      // duplicate column name — already migrated
    }
  }
  // Account lifetime (both optional; null = "always existed"). The opening
  // balance materializes ON opened_at, and operations are validated to fall
  // inside [opened_at, closed_at].
  for (const column of ["opened_at", "closed_at"]) {
    try {
      await d1
        .prepare(`ALTER TABLE accounts ADD COLUMN ${column} TEXT`)
        .run();
    } catch {
      // duplicate column name — already migrated
    }
  }
  await d1
    .prepare(
      "CREATE INDEX IF NOT EXISTS transactions_transfer_group_idx ON transactions (transfer_group)"
    )
    .run();
}
