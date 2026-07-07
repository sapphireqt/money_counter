import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    bankName: text("bank_name").notNull().default(""),
    currency: text("currency").notNull().default("EUR"),
    type: text("type").notNull().default("checking"),
    openingBalanceCents: integer("opening_balance_cents").notNull().default(0),
    color: text("color").notNull().default("#2563eb"),
    // Manual order from Настройки (drag-and-drop); 9999 = alphabetical tail.
    sortOrder: integer("sort_order").notNull().default(9999),
    // Account lifetime, both optional (null = always existed): the opening
    // balance counts from openedAt, operations must fall inside the range,
    // and the «Счета» panel hides the account outside it (unless a non-zero
    // balance says otherwise).
    openedAt: text("opened_at"),
    closedAt: text("closed_at"),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("accounts_name_idx").on(table.name),
    index("accounts_archived_at_idx").on(table.archivedAt),
  ]
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull().default(""),
    payee: text("payee").notNull().default(""),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("cleared"),
    notes: text("notes").notNull().default(""),
    // Non-null on the two legs of a money movement between own accounts: both
    // rows share one opaque group id. Linked legs still count toward account
    // balances but are excluded from income/expense/category aggregates.
    transferGroup: text("transfer_group"),
    // User attention marker («Требует внимания») — purely visual, usually
    // paired with an explanation in `notes`.
    flagged: integer("flagged").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("transactions_account_id_idx").on(table.accountId),
    index("transactions_date_idx").on(table.date),
    index("transactions_amount_cents_idx").on(table.amountCents),
    index("transactions_transfer_group_idx").on(table.transferGroup),
  ]
);

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#2563eb"),
    // Manual order from Настройки (drag-and-drop); 9999 = alphabetical tail.
    sortOrder: integer("sort_order").notNull().default(9999),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("categories_name_idx").on(table.name)]
);

export const categoryRules = sqliteTable(
  "category_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pattern: text("pattern").notNull(),
    category: text("category").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("category_rules_category_idx").on(table.category)]
);

// Cached historical FX rates, base USD: 1 USD = usdRate units of `currency`.
// Keyed by (date, currency); historical rates are immutable so rows are
// written once and reused. Populated on demand from the Frankfurter API.
export const exchangeRates = sqliteTable(
  "exchange_rates",
  {
    date: text("date").notNull(),
    currency: text("currency").notNull(),
    usdRate: real("usd_rate").notNull(),
  },
  (table) => [primaryKey({ columns: [table.date, table.currency] })]
);

// Currency reference book: one row per currency in use, keyed by ISO code.
// Future-proofed with name/symbol for labels and later attributes/filters.
export const currencies = sqliteTable("currencies", {
  code: text("code").primaryKey(),
  name: text("name").notNull().default(""),
  symbol: text("symbol").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
