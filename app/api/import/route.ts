import {
  normalizeCurrency,
  normalizeDateInput,
  resolveSignedAmountCents,
} from "../../../lib/finance";
import { ensureSchema, getD1 } from "../../../db";

type ImportRow = {
  accountName?: string;
  currency?: string;
  date?: string;
  amount?: string | number;
  amountCents?: string | number;
  direction?: string;
  description?: string;
  category?: string;
  payee?: string;
  notes?: string;
};

type AccountLookup = {
  id: number;
  name: string;
  currency: string;
};

const palette = [
  "#2563eb",
  "#0f766e",
  "#b45309",
  "#be123c",
  "#6d28d9",
  "#0369a1",
  "#4d7c0f",
];

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";

  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }

  return message;
}

function accountKey(name: string, currency: string) {
  return `${name.trim().toLowerCase()}::${currency}`;
}

async function readPayload(request: Request) {
  try {
    return (await request.json()) as { rows?: ImportRow[] };
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const rows = Array.isArray(payload.rows) ? payload.rows : [];

    if (rows.length === 0) {
      return Response.json({ error: "Нет строк для импорта" }, { status: 400 });
    }

    if (rows.length > 1000) {
      return Response.json(
        { error: "За один импорт можно загрузить до 1000 строк" },
        { status: 400 }
      );
    }

    const d1 = getD1();
    const existingAccounts = await d1
      .prepare(
        "SELECT id, name, currency FROM accounts WHERE archived_at IS NULL ORDER BY id"
      )
      .all<AccountLookup>();
    const accountsByKey = new Map<string, AccountLookup>();

    for (const account of existingAccounts.results ?? []) {
      accountsByKey.set(accountKey(account.name, account.currency), account);
    }

    let createdAccounts = 0;
    let createdTransactions = 0;
    const rejected: Array<{ row: number; reason: string }> = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 1;
      const accountName = String(row.accountName ?? "").trim();
      const currency = normalizeCurrency(row.currency);
      const date = normalizeDateInput(row.date);
      const amountCents = resolveSignedAmountCents(
        row.amount ?? row.amountCents,
        row.direction
      );

      if (!accountName) {
        rejected.push({ row: rowNumber, reason: "не указан счет" });
        continue;
      }

      if (!date) {
        rejected.push({ row: rowNumber, reason: "некорректная дата" });
        continue;
      }

      if (amountCents === null || amountCents === 0) {
        rejected.push({ row: rowNumber, reason: "некорректная сумма" });
        continue;
      }

      const key = accountKey(accountName, currency);
      let account = accountsByKey.get(key);

      if (!account) {
        const created = await d1
          .prepare(
            `INSERT INTO accounts (name, currency, color)
             VALUES (?, ?, ?)
             RETURNING id, name, currency`
          )
          .bind(
            accountName,
            currency,
            palette[accountsByKey.size % palette.length]
          )
          .first<AccountLookup>();

        if (!created) {
          rejected.push({ row: rowNumber, reason: "счет не создан" });
          continue;
        }

        account = created;
        accountsByKey.set(key, created);
        createdAccounts += 1;
      }

      if (!account) {
        rejected.push({ row: rowNumber, reason: "счет не найден" });
        continue;
      }

      await d1
        .prepare(
          `INSERT INTO transactions (
            account_id,
            date,
            description,
            category,
            payee,
            amount_cents,
            notes
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          account.id,
          date,
          String(row.description ?? "").trim() ||
            (amountCents > 0 ? "Поступление" : "Расход"),
          String(row.category ?? "").trim(),
          String(row.payee ?? "").trim(),
          amountCents,
          String(row.notes ?? "").trim()
        )
        .run();

      createdTransactions += 1;
    }

    return Response.json({
      createdAccounts,
      createdTransactions,
      rejected,
    });
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}
