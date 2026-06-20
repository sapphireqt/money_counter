# Money Counter

Site for tracking several bank accounts, income, expenses, balances, and CSV
imports from spreadsheet exports.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
pnpm install
pnpm run dev
pnpm run build
```

The app uses Sites, vinext, Cloudflare D1, and Drizzle migrations.

## Data Model

- `accounts`: bank accounts, currencies, opening balances, colors, archive state.
- `transactions`: dated income and expense rows linked to accounts.
- Account balances are calculated from opening balance plus transactions.

## CSV Import

The importer recognizes common English and Russian headers: date, account,
amount, type/direction, description, category, payee, notes, and currency.

## Useful Commands

- `pnpm run dev`: start local development.
- `pnpm run build`: verify the vinext build output.
- `pnpm run db:generate`: generate Drizzle migrations after schema changes.
- `pnpm run lint`: run ESLint.
