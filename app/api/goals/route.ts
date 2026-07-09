import { ensureSchema, getD1 } from "../../../db";
import { normalizeCurrency } from "../../../lib/finance";

type GoalRow = {
  month: string;
  amount_cents: number;
  currency: string;
};

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

async function readPayload(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const isMonth = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}$/.test(v);

function toClient(r: GoalRow) {
  return { month: r.month, amountCents: r.amount_cents, currency: r.currency };
}

export async function GET() {
  try {
    await ensureSchema();
    const rows = await getD1()
      .prepare("SELECT month, amount_cents, currency FROM monthly_goals ORDER BY month")
      .all<GoalRow>();
    return Response.json({ goals: (rows.results ?? []).map(toClient) });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

// Upsert the goal for a month. A zero amount clears the goal (row removed) so
// "no goal" and "goal of 0" don't drift apart.
export async function PUT(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const month = payload.month;
    const amountCents = Math.round(Number(payload.amountCents));
    const currency = normalizeCurrency(String(payload.currency ?? ""));
    if (!isMonth(month)) return Response.json({ error: "Некорректный месяц" }, { status: 400 });
    if (!Number.isFinite(amountCents) || amountCents < 0) return Response.json({ error: "Некорректная сумма" }, { status: 400 });
    if (!currency) return Response.json({ error: "Некорректная валюта" }, { status: 400 });

    const d1 = getD1();
    if (amountCents === 0) {
      await d1.prepare("DELETE FROM monthly_goals WHERE month = ?").bind(month).run();
      return Response.json({ goal: null });
    }
    const row = await d1
      .prepare(
        `INSERT INTO monthly_goals (month, amount_cents, currency, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(month) DO UPDATE SET amount_cents = excluded.amount_cents,
           currency = excluded.currency, updated_at = CURRENT_TIMESTAMP
         RETURNING month, amount_cents, currency`
      )
      .bind(month, amountCents, currency)
      .first<GoalRow>();
    return Response.json({ goal: row ? toClient(row) : null });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const month = new URL(request.url).searchParams.get("month");
    if (!isMonth(month)) return Response.json({ error: "Некорректный месяц" }, { status: 400 });
    await getD1().prepare("DELETE FROM monthly_goals WHERE month = ?").bind(month).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
