import {
  matchCategoryRule,
  normalizeDateInput,
  resolveSignedAmountCents,
  type CategoryRule,
} from "../../../lib/finance";
import { ensureSchema, getD1 } from "../../../db";

type TransactionRow = {
  id: number;
  account_id: number;
  account_name: string;
  account_currency: string;
  date: string;
  description: string;
  category: string;
  payee: string;
  amount_cents: number;
  status: string;
  notes: string;
  transfer_group: string | null;
  created_at: string;
  updated_at: string;
};

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";

  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }

  return message;
}

function mapTransaction(row: TransactionRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    accountCurrency: row.account_currency,
    date: row.date,
    description: row.description,
    category: row.category,
    payee: row.payee,
    amountCents: row.amount_cents,
    status: row.status,
    notes: row.notes,
    transferGroup: row.transfer_group,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function readPayload(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeStatus(value: unknown) {
  return value === "pending" ? "pending" : "cleared";
}

async function getTransactionById(id: number) {
  const row = await getD1()
    .prepare(
      `SELECT
        t.id,
        t.account_id,
        a.name AS account_name,
        a.currency AS account_currency,
        t.date,
        t.description,
        t.category,
        t.payee,
        t.amount_cents,
        t.status,
        t.notes,
        t.transfer_group,
        t.created_at,
        t.updated_at
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.id = ?`
    )
    .bind(id)
    .first<TransactionRow>();

  return row ? mapTransaction(row) : null;
}

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const requestUrl = new URL(request.url);
    const searchParams = requestUrl.searchParams;
    const conditions = ["a.archived_at IS NULL"];
    const values: Array<number | string> = [];
    const accountId = parseId(searchParams.get("accountId"));
    const query = searchParams.get("q")?.trim();
    const type = searchParams.get("type");
    const from = normalizeDateInput(searchParams.get("from") ?? "");
    const to = normalizeDateInput(searchParams.get("to") ?? "");
    const limit = Math.min(
      Math.max(Number(searchParams.get("limit") ?? 250), 1),
      500
    );

    if (accountId) {
      conditions.push("t.account_id = ?");
      values.push(accountId);
    }

    if (query) {
      conditions.push(
        "(LOWER(t.description) LIKE ? OR LOWER(t.category) LIKE ? OR LOWER(t.payee) LIKE ? OR LOWER(a.name) LIKE ?)"
      );
      const likeQuery = `%${query.toLowerCase()}%`;
      values.push(likeQuery, likeQuery, likeQuery, likeQuery);
    }

    if (type === "income") {
      conditions.push("t.amount_cents > 0");
    }

    if (type === "expense") {
      conditions.push("t.amount_cents < 0");
    }

    if (from) {
      conditions.push("t.date >= ?");
      values.push(from);
    }

    if (to) {
      conditions.push("t.date <= ?");
      values.push(to);
    }

    const rows = await getD1()
      .prepare(
        `SELECT
          t.id,
          t.account_id,
          a.name AS account_name,
          a.currency AS account_currency,
          t.date,
          t.description,
          t.category,
          t.payee,
          t.amount_cents,
          t.status,
          t.notes,
          t.transfer_group,
          t.created_at,
          t.updated_at
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY t.date DESC, t.id DESC
         LIMIT ?`
      )
      .bind(...values, limit)
      .all<TransactionRow>();

    return Response.json({
      transactions: (rows.results ?? []).map(mapTransaction),
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
    const accountId = parseId(payload.accountId);
    const date = normalizeDateInput(payload.date);
    const amountCents = resolveSignedAmountCents(
      payload.amount ?? payload.amountCents,
      payload.direction
    );
    const description = String(payload.description ?? "").trim();

    if (!accountId) {
      return Response.json({ error: "Выберите счет" }, { status: 400 });
    }

    if (!date) {
      return Response.json({ error: "Некорректная дата" }, { status: 400 });
    }

    if (amountCents === null || amountCents === 0) {
      return Response.json({ error: "Некорректная сумма" }, { status: 400 });
    }

    const account = await getD1()
      .prepare("SELECT id FROM accounts WHERE id = ? AND archived_at IS NULL")
      .bind(accountId)
      .first<{ id: number }>();

    if (!account) {
      return Response.json({ error: "Счет не найден" }, { status: 404 });
    }

    const payee = String(payload.payee ?? "").trim();
    let category = String(payload.category ?? "").trim();
    if (!category) {
      const ruleRows = await getD1()
        .prepare("SELECT pattern, category FROM category_rules ORDER BY id")
        .all<CategoryRule>();
      const rules = ruleRows.results ?? [];
      category =
        matchCategoryRule(description, rules) || matchCategoryRule(payee, rules);
    }

    const row = await getD1()
      .prepare(
        `INSERT INTO transactions (
          account_id,
          date,
          description,
          category,
          payee,
          amount_cents,
          status,
          notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING
          id,
          account_id,
          (SELECT name FROM accounts WHERE id = account_id) AS account_name,
          (SELECT currency FROM accounts WHERE id = account_id) AS account_currency,
          date,
          description,
          category,
          payee,
          amount_cents,
          status,
          notes,
          transfer_group,
          created_at,
          updated_at`
      )
      .bind(
        accountId,
        date,
        description || (amountCents > 0 ? "Поступление" : "Расход"),
        category,
        payee,
        amountCents,
        normalizeStatus(payload.status),
        String(payload.notes ?? "").trim()
      )
      .first<TransactionRow>();

    if (!row) {
      throw new Error("Не удалось создать операцию");
    }

    return Response.json({ transaction: mapTransaction(row) }, { status: 201 });
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
      return Response.json({ error: "Некорректная операция" }, { status: 400 });
    }

    const assignments: string[] = [];
    const values: Array<number | string> = [];

    if ("accountId" in payload) {
      const accountId = parseId(payload.accountId);
      if (!accountId) {
        return Response.json({ error: "Выберите счет" }, { status: 400 });
      }
      const account = await getD1()
        .prepare("SELECT id FROM accounts WHERE id = ? AND archived_at IS NULL")
        .bind(accountId)
        .first<{ id: number }>();
      if (!account) {
        return Response.json({ error: "Счет не найден" }, { status: 404 });
      }
      assignments.push("account_id = ?");
      values.push(accountId);
    }

    if ("date" in payload) {
      const date = normalizeDateInput(payload.date);
      if (!date) {
        return Response.json({ error: "Некорректная дата" }, { status: 400 });
      }
      assignments.push("date = ?");
      values.push(date);
    }

    if ("amount" in payload || "amountCents" in payload) {
      const amountCents = resolveSignedAmountCents(
        payload.amount ?? payload.amountCents,
        payload.direction
      );
      if (amountCents === null || amountCents === 0) {
        return Response.json({ error: "Некорректная сумма" }, { status: 400 });
      }
      assignments.push("amount_cents = ?");
      values.push(amountCents);
    }

    if ("description" in payload) {
      assignments.push("description = ?");
      values.push(String(payload.description ?? "").trim() || "Операция");
    }

    if ("category" in payload) {
      assignments.push("category = ?");
      values.push(String(payload.category ?? "").trim());
    }

    if ("payee" in payload) {
      assignments.push("payee = ?");
      values.push(String(payload.payee ?? "").trim());
    }

    if ("status" in payload) {
      assignments.push("status = ?");
      values.push(normalizeStatus(payload.status));
    }

    if ("notes" in payload) {
      assignments.push("notes = ?");
      values.push(String(payload.notes ?? "").trim());
    }

    if (assignments.length === 0) {
      return Response.json({ error: "Нет изменений" }, { status: 400 });
    }

    assignments.push("updated_at = CURRENT_TIMESTAMP");
    await getD1()
      .prepare(
        `UPDATE transactions
         SET ${assignments.join(", ")}
         WHERE id = ?`
      )
      .bind(...values, id)
      .run();

    const transaction = await getTransactionById(id);
    return Response.json({ transaction });
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
      return Response.json({ error: "Некорректная операция" }, { status: 400 });
    }

    // Deleting one leg of a transfer would leave the partner marked as a
    // transfer with nobody to pair with — unlink the whole group first.
    const existing = await getD1()
      .prepare("SELECT transfer_group FROM transactions WHERE id = ?")
      .bind(id)
      .first<{ transfer_group: string | null }>();

    await getD1()
      .prepare("DELETE FROM transactions WHERE id = ?")
      .bind(id)
      .run();

    if (existing?.transfer_group) {
      await getD1()
        .prepare("UPDATE transactions SET transfer_group = NULL WHERE transfer_group = ?")
        .bind(existing.transfer_group)
        .run();
    }

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}
