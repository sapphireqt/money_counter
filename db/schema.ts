import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("transactions_account_id_idx").on(table.accountId),
    index("transactions_date_idx").on(table.date),
    index("transactions_amount_cents_idx").on(table.amountCents),
  ]
);
