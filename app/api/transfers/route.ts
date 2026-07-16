import {
  normalizeDateInput,
  parseMoneyInputToCents,
} from "../../../lib/finance";
import { ensureSchema, getD1 } from "../../../db";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

function parseId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type LegRow = {
  id: number;
  account_id: number;
  amount_cents: number;
  transfer_group: string | null;
};

type CreatePayload = {
  fromAccountId?: unknown;
  toAccountId?: unknown;
  date?: unknown;
  amount?: unknown;
  amountIn?: unknown;
  description?: unknown;
  notes?: unknown;
  flagged?: unknown;
};

type TransferRow = {
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
  flagged: number;
};

function mapTransferRow(row: TransferRow) {
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
    flagged: row.flagged === 1,
  };
}

function mergeNotes(first: string, second: string) {
  const notes = [first.trim(), second.trim()].filter(Boolean);
  return [...new Set(notes)].join("\n");
}

// Create a brand-new transfer: both legs inserted already linked, in ONE D1
// batch (atomic), so a manual «перекинул деньги» is a single action instead
// of add-expense + add-income + link.
async function createTransfer(create: CreatePayload) {
  const d1 = getD1();
  const fromId = Number(create.fromAccountId);
  const toId = Number(create.toAccountId);
  if (!Number.isInteger(fromId) || fromId <= 0 || !Number.isInteger(toId) || toId <= 0) {
    return Response.json({ error: "Выберите оба счета" }, { status: 400 });
  }
  if (fromId === toId) {
    return Response.json({ error: "Счета должны быть разными" }, { status: 400 });
  }
  const date = normalizeDateInput(create.date);
  if (!date) {
    return Response.json({ error: "Некорректная дата" }, { status: 400 });
  }
  const outCents = Math.abs(parseMoneyInputToCents(create.amount) ?? 0);
  if (outCents === 0) {
    return Response.json({ error: "Некорректная сумма" }, { status: 400 });
  }

  const rows = await d1
    .prepare(
      "SELECT id, name, currency, opened_at, closed_at FROM accounts WHERE id IN (?, ?) AND archived_at IS NULL"
    )
    .bind(fromId, toId)
    .all<{ id: number; name: string; currency: string; opened_at: string | null; closed_at: string | null }>();
  const from = (rows.results ?? []).find((a) => a.id === fromId);
  const to = (rows.results ?? []).find((a) => a.id === toId);
  if (!from || !to) {
    return Response.json({ error: "Счет не найден" }, { status: 404 });
  }
  for (const account of [from, to]) {
    if (account.opened_at && date < account.opened_at) {
      return Response.json(
        { error: `Счёт «${account.name}» открыт ${account.opened_at.split("-").reverse().join(".")} — дата перевода раньше` },
        { status: 400 }
      );
    }
    if (account.closed_at && date > account.closed_at) {
      return Response.json(
        { error: `Счёт «${account.name}» закрыт ${account.closed_at.split("-").reverse().join(".")} — дата перевода позже` },
        { status: 400 }
      );
    }
  }

  // Same currency: the received amount defaults to the sent one. Different
  // currencies: the user must say how much actually arrived — we never
  // invent an exchange rate for real money.
  const sameCurrency = from.currency === to.currency;
  const hasAmountIn = create.amountIn != null && String(create.amountIn).trim() !== "";
  const inCents = sameCurrency
    ? outCents
    : hasAmountIn
      ? Math.abs(parseMoneyInputToCents(create.amountIn) ?? 0)
      : 0;
  if (inCents === 0) {
    return Response.json(
      { error: `Укажите сумму зачисления в ${to.currency}` },
      { status: 400 }
    );
  }

  const description =
    String(create.description ?? "").trim() || `Перевод: ${from.name} → ${to.name}`;
  const notes = String(create.notes ?? "").trim();
  const flagged = create.flagged ? 1 : 0;
  const group = crypto.randomUUID();
  const insert = `INSERT INTO transactions (account_id, date, description, category, payee, amount_cents, notes, transfer_group, flagged)
                  VALUES (?, ?, ?, '', '', ?, ?, ?, ?)`;
  await d1.batch([
    d1.prepare(insert).bind(fromId, date, description, -outCents, notes, group, flagged),
    d1.prepare(insert).bind(toId, date, description, inCents, notes, group, flagged),
  ]);
  return Response.json({ created: 2, group }, { status: 201 });
}

async function readTransfer(group: string) {
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
         t.flagged
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.transfer_group = ?
       ORDER BY t.amount_cents ASC, t.id ASC`
    )
    .bind(group)
    .all<TransferRow>();
  return rows.results ?? [];
}

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const group = new URL(request.url).searchParams.get("group")?.trim() ?? "";
    if (!group) return Response.json({ error: "Некорректный перевод" }, { status: 400 });
    const rows = await readTransfer(group);
    if (rows.length !== 2) {
      return Response.json({ error: "Связанные операции не найдены" }, { status: 404 });
    }
    return Response.json({ transactions: rows.map(mapTransferRow) });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

/**
 * Link expense+income legs into transfers («Перемещение»). Both rows get one
 * shared transfer_group and their categories are cleared — a movement between
 * own accounts is not spending, so it must not sit in a category. Balances are
 * untouched: each leg still belongs to its account.
 *
 *   POST { outId, inId }                  — link one pair
 *   POST { pairs: [{outId, inId}, ...] }  — link many (the detect flow)
 *   POST { create: {fromAccountId, toAccountId, date, amount, amountIn?,
 *          description?} }                — create a NEW transfer (both legs)
 *   -> { linked, errors: [{outId, inId, reason}] } | { created: 2, group }
 */
export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = (await request.json().catch(() => ({}))) as {
      outId?: unknown;
      inId?: unknown;
      pairs?: Array<{ outId?: unknown; inId?: unknown }>;
      create?: CreatePayload;
    };

    if (payload.create && typeof payload.create === "object") {
      return await createTransfer(payload.create);
    }
    const isBatch = Array.isArray(payload.pairs);
    const pairs = isBatch
      ? payload.pairs!
      : [{ outId: payload.outId, inId: payload.inId }];

    if (pairs.length === 0 || pairs.length > 200) {
      return Response.json({ error: "Некорректный список пар" }, { status: 400 });
    }

    const d1 = getD1();
    let linked = 0;
    const errors: Array<{ outId: unknown; inId: unknown; reason: string }> = [];

    for (const pair of pairs) {
      const outId = parseId(pair.outId);
      const inId = parseId(pair.inId);
      if (!outId || !inId || outId === inId) {
        errors.push({ outId: pair.outId, inId: pair.inId, reason: "некорректная пара" });
        continue;
      }

      const rows = await d1
        .prepare(
          `SELECT t.id, t.account_id, t.amount_cents, t.transfer_group
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           WHERE t.id IN (?, ?) AND a.archived_at IS NULL`
        )
        .bind(outId, inId)
        .all<LegRow>();
      const legs = rows.results ?? [];
      const out = legs.find((leg) => leg.id === outId);
      const incoming = legs.find((leg) => leg.id === inId);

      let reason = "";
      if (!out || !incoming) reason = "операция не найдена";
      else if (out.transfer_group || incoming.transfer_group)
        reason = "операция уже входит в перемещение";
      else if (out.account_id === incoming.account_id)
        reason = "операции на одном счете";
      else if (out.amount_cents >= 0 || incoming.amount_cents <= 0)
        reason = "нужны расход и поступление";

      if (reason) {
        errors.push({ outId, inId, reason });
        continue;
      }

      const group = crypto.randomUUID();
      await d1
        .prepare(
          `UPDATE transactions
           SET transfer_group = ?, category = '', updated_at = CURRENT_TIMESTAMP
           WHERE id IN (?, ?)`
        )
        .bind(group, outId, inId)
        .run();
      linked += 1;
    }

    // A failed single-pair link is an HTTP error, not a 200 with a buried
    // errors array — otherwise the client's generic handling would show a
    // success toast over a no-op. Batches keep per-pair reporting.
    if (!isBatch && linked === 0) {
      return Response.json(
        { error: `Не удалось связать: ${errors[0]?.reason ?? "ошибка"}` },
        { status: 409 }
      );
    }

    return Response.json({ linked, errors });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureSchema();
    const payload = (await request.json().catch(() => ({}))) as {
      group?: unknown;
      date?: unknown;
      fromAccountId?: unknown;
      toAccountId?: unknown;
      amount?: unknown;
      amountIn?: unknown;
      description?: unknown;
      descriptionIn?: unknown;
      notes?: unknown;
      flagged?: unknown;
    };
    const group = String(payload.group ?? "").trim();
    if (!group) return Response.json({ error: "Некорректный перевод" }, { status: 400 });

    const rows = await readTransfer(group);
    const out = rows.find((row) => row.amount_cents < 0);
    const incoming = rows.find((row) => row.amount_cents > 0);
    if (!out || !incoming || rows.length !== 2) {
      return Response.json({ error: "Связанные операции не найдены" }, { status: 404 });
    }

    const fromId = parseId(payload.fromAccountId) ?? out.account_id;
    const toId = parseId(payload.toAccountId) ?? incoming.account_id;
    if (fromId === toId) {
      return Response.json({ error: "Счета должны быть разными" }, { status: 400 });
    }
    const date = normalizeDateInput(payload.date ?? out.date);
    if (!date) return Response.json({ error: "Некорректная дата" }, { status: 400 });

    const outCents =
      payload.amount == null
        ? Math.abs(out.amount_cents)
        : Math.abs(parseMoneyInputToCents(payload.amount) ?? 0);
    if (outCents === 0) return Response.json({ error: "Некорректная сумма" }, { status: 400 });

    const accountRows = await getD1()
      .prepare(
        "SELECT id, name, currency, opened_at, closed_at FROM accounts WHERE id IN (?, ?) AND archived_at IS NULL"
      )
      .bind(fromId, toId)
      .all<{ id: number; name: string; currency: string; opened_at: string | null; closed_at: string | null }>();
    const from = (accountRows.results ?? []).find((account) => account.id === fromId);
    const to = (accountRows.results ?? []).find((account) => account.id === toId);
    if (!from || !to) return Response.json({ error: "Счёт не найден" }, { status: 404 });
    for (const account of [from, to]) {
      if (account.opened_at && date < account.opened_at) {
        return Response.json(
          { error: `Счёт «${account.name}» открыт ${account.opened_at.split("-").reverse().join(".")} — дата перевода раньше` },
          { status: 400 }
        );
      }
      if (account.closed_at && date > account.closed_at) {
        return Response.json(
          { error: `Счёт «${account.name}» закрыт ${account.closed_at.split("-").reverse().join(".")} — дата перевода позже` },
          { status: 400 }
        );
      }
    }

    const sameCurrency = from.currency === to.currency;
    const inCents = sameCurrency
      ? outCents
      : payload.amountIn == null
        ? Math.abs(incoming.amount_cents)
        : Math.abs(parseMoneyInputToCents(payload.amountIn) ?? 0);
    if (inCents === 0) {
      return Response.json({ error: `Укажите сумму зачисления в ${to.currency}` }, { status: 400 });
    }

    const descriptionOut =
      String(payload.description ?? out.description).trim() ||
      `Перевод: ${from.name} → ${to.name}`;
    const descriptionIn =
      String(payload.descriptionIn ?? incoming.description).trim() || descriptionOut;
    const notes =
      "notes" in payload
        ? String(payload.notes ?? "").trim()
        : mergeNotes(out.notes, incoming.notes);
    const flagged =
      "flagged" in payload ? (payload.flagged ? 1 : 0) : out.flagged || incoming.flagged ? 1 : 0;
    const sql = `UPDATE transactions
                 SET account_id = ?, date = ?, description = ?, category = '', amount_cents = ?,
                     notes = ?, flagged = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND transfer_group = ?`;
    await getD1().batch([
      getD1().prepare(sql).bind(fromId, date, descriptionOut, -outCents, notes, flagged, out.id, group),
      getD1().prepare(sql).bind(toId, date, descriptionIn, inCents, notes, flagged, incoming.id, group),
    ]);

    const updated = await readTransfer(group);
    return Response.json({ transactions: updated.map(mapTransferRow) });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

// DELETE /api/transfers?group=<id> — split a transfer back into two ordinary
// operations (categories stay empty; re-categorize by hand or rules).
export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const group = new URL(request.url).searchParams.get("group") ?? "";
    if (!group) {
      return Response.json({ error: "Некорректное перемещение" }, { status: 400 });
    }
    const rows = await readTransfer(group);
    const out = rows.find((row) => row.amount_cents < 0);
    const incoming = rows.find((row) => row.amount_cents > 0);
    if (!out || !incoming || rows.length !== 2) {
      return Response.json({ error: "Связанные операции не найдены" }, { status: 404 });
    }
    const notes = mergeNotes(out.notes, incoming.notes);
    const flagged = out.flagged || incoming.flagged ? 1 : 0;
    await getD1().batch([
      getD1()
        .prepare(
          "UPDATE transactions SET transfer_group = NULL, notes = ?, flagged = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .bind(notes, flagged, out.id),
      getD1()
        .prepare(
          "UPDATE transactions SET transfer_group = NULL, notes = '', flagged = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .bind(incoming.id),
    ]);
    return Response.json({ unlinked: 2 });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
