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

/**
 * Link expense+income legs into transfers («Перемещение»). Both rows get one
 * shared transfer_group and their categories are cleared — a movement between
 * own accounts is not spending, so it must not sit in a category. Balances are
 * untouched: each leg still belongs to its account.
 *
 *   POST { outId, inId }                  — link one pair
 *   POST { pairs: [{outId, inId}, ...] }  — link many (the detect flow)
 *   -> { linked, errors: [{outId, inId, reason}] }
 */
export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = (await request.json().catch(() => ({}))) as {
      outId?: unknown;
      inId?: unknown;
      pairs?: Array<{ outId?: unknown; inId?: unknown }>;
    };
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

// DELETE /api/transfers?group=<id> — split a transfer back into two ordinary
// operations (categories stay empty; re-categorize by hand or rules).
export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const group = new URL(request.url).searchParams.get("group") ?? "";
    if (!group) {
      return Response.json({ error: "Некорректное перемещение" }, { status: 400 });
    }
    const result = await getD1()
      .prepare("UPDATE transactions SET transfer_group = NULL, updated_at = CURRENT_TIMESTAMP WHERE transfer_group = ?")
      .bind(group)
      .run();
    return Response.json({ unlinked: result.meta.changes ?? 0 });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
