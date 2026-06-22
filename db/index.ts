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
  ]);
}
