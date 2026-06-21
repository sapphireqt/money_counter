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

## Docker Demo

Build the local demo image:

```bash
docker build -t money-counter-demo .
```

Run it with a persistent local D1 volume:

```bash
docker run --rm -p 8787:8787 -v money-counter-data:/data money-counter-demo
```

Then open `http://localhost:8787`.

The container runs the built Cloudflare Worker with Wrangler's local runtime and
stores D1 state under `/data`. It does not use Sites or publish anything.
