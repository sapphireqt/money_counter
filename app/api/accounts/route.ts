import {
  normalizeAccountType,
  normalizeColor,
  normalizeCurrency,
  parseMoneyInputToCents,
} from "../../../lib/finance";
import { ensureSchema, getD1 } from "../../../db";

type AccountRow = {
  id: number;
  name: string;
  bank_name: string;
  currency: string;
  type: string;
  opening_balance_cents: number;
  color: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  balance_cents: number;
  transaction_count: number;
};

const accountSelect = `
  SELECT
    a.id,
    a.name,
    a.bank_name,
    a.currency,
    a.type,
    a.opening_balance_cents,
    a.color,
    a.archived_at,
    a.created_at,
    a.updated_at,
    a.opening_balance_cents + COALESCE(SUM(t.amount_cents), 0) AS balance_cents,
    COUNT(t.id) AS transaction_count
  FROM accounts a
  LEFT JOIN transactions t ON t.account_id = a.id
`;

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";

  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }

  return message;
}

function mapAccount(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    bankName: row.bank_name,
    currency: row.currency,
    type: row.type,
    openingBalanceCents: row.opening_balance_cents,
    color: row.color,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    balanceCents: row.balance_cents,
    transactionCount: row.transaction_count,
  };
}

async function readPayload(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function getAccountById(id: number) {
  const d1 = getD1();
  const row = await d1
    .prepare(
      `${accountSelect}
       WHERE a.id = ?
       GROUP BY a.id`
    )
    .bind(id)
    .first<AccountRow>();

  return row ? mapAccount(row) : null;
}

export async function GET() {
  try {
    await ensureSchema();

    const rows = await getD1()
      .prepare(
        `${accountSelect}
         WHERE a.archived_at IS NULL
         GROUP BY a.id
         ORDER BY LOWER(a.name), a.id`
      )
      .all<AccountRow>();

    return Response.json({
      accounts: (rows.results ?? []).map(mapAccount),
    });
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const name = String(payload.name ?? "").trim();

    if (!name) {
      return Response.json({ error: "Название счета обязательно" }, { status: 400 });
    }

    const openingBalanceCents =
      parseMoneyInputToCents(payload.openingBalance ?? payload.openingBalanceCents) ?? 0;
    const bankName = String(payload.bankName ?? "").trim();
    const currency = normalizeCurrency(payload.currency);
    const type = normalizeAccountType(payload.type);
    const color = normalizeColor(payload.color);

    const row = await getD1()
      .prepare(
        `INSERT INTO accounts (
          name,
          bank_name,
          currency,
          type,
          opening_balance_cents,
          color
        )
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING
          id,
          name,
          bank_name,
          currency,
          type,
          opening_balance_cents,
          color,
          archived_at,
          created_at,
          updated_at,
          opening_balance_cents AS balance_cents,
          0 AS transaction_count`
      )
      .bind(name, bankName, currency, type, openingBalanceCents, color)
      .first<AccountRow>();

    if (!row) {
      throw new Error("Не удалось создать счет");
    }

    return Response.json({ account: mapAccount(row) }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const requestUrl = new URL(request.url);
    const id = parseId(payload.id ?? requestUrl.searchParams.get("id"));

    if (!id) {
      return Response.json({ error: "Некорректный счет" }, { status: 400 });
    }

    const assignments: string[] = [];
    const values: Array<number | string> = [];

    if ("name" in payload) {
      const name = String(payload.name ?? "").trim();
      if (!name) {
        return Response.json({ error: "Название счета обязательно" }, { status: 400 });
      }
      assignments.push("name = ?");
      values.push(name);
    }

    if ("bankName" in payload) {
      assignments.push("bank_name = ?");
      values.push(String(payload.bankName ?? "").trim());
    }

    if ("currency" in payload) {
      assignments.push("currency = ?");
      values.push(normalizeCurrency(payload.currency));
    }

    if ("type" in payload) {
      assignments.push("type = ?");
      values.push(normalizeAccountType(payload.type));
    }

    if ("openingBalance" in payload || "openingBalanceCents" in payload) {
      const openingBalanceCents = parseMoneyInputToCents(
        payload.openingBalance ?? payload.openingBalanceCents
      );
      if (openingBalanceCents === null) {
        return Response.json({ error: "Некорректный начальный баланс" }, { status: 400 });
      }
      assignments.push("opening_balance_cents = ?");
      values.push(openingBalanceCents);
    }

    if ("color" in payload) {
      assignments.push("color = ?");
      values.push(normalizeColor(payload.color));
    }

    if (assignments.length === 0) {
      return Response.json({ error: "Нет изменений" }, { status: 400 });
    }

    assignments.push("updated_at = CURRENT_TIMESTAMP");
    await getD1()
      .prepare(
        `UPDATE accounts
         SET ${assignments.join(", ")}
         WHERE id = ? AND archived_at IS NULL`
      )
      .bind(...values, id)
      .run();

    const account = await getAccountById(id);
    return Response.json({ account });
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const requestUrl = new URL(request.url);
    const id = parseId(requestUrl.searchParams.get("id"));

    if (!id) {
      return Response.json({ error: "Некорректный счет" }, { status: 400 });
    }

    await getD1()
      .prepare(
        `UPDATE accounts
         SET archived_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND archived_at IS NULL`
      )
      .bind(id)
      .run();

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}
