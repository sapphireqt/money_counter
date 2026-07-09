import { ensureSchema, getD1 } from "../../../db";
import { normalizeCurrency } from "../../../lib/finance";

type RegularRow = {
  id: number;
  name: string;
  amount_cents: number;
  currency: string;
  category: string;
  direction: string;
  periodicity: string;
  day_of_month: number;
  month: number | null;
  interval_months: number | null;
  anchor_month: string | null;
  active: number;
  source: string;
};

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

async function readPayload(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toClient(r: RegularRow) {
  return {
    id: r.id,
    name: r.name,
    amountCents: r.amount_cents,
    currency: r.currency,
    category: r.category,
    direction: r.direction,
    periodicity: r.periodicity,
    dayOfMonth: r.day_of_month,
    month: r.month,
    intervalMonths: r.interval_months,
    anchorMonth: r.anchor_month,
    active: r.active === 1,
    source: r.source,
  };
}

const PERIODICITIES = ["monthly", "yearly", "every_n_months"];

// Validate + coerce the periodicity-dependent fields. Returns null on a hard
// validation error (bad name/amount/currency), else the normalized values.
function normalizeFields(payload: Record<string, unknown>) {
  const name = String(payload.name ?? "").trim();
  const amountCents = Math.round(Number(payload.amountCents));
  const currency = normalizeCurrency(String(payload.currency ?? ""));
  if (!name) return { error: "Укажите название" };
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { error: "Некорректная сумма" };
  if (!currency) return { error: "Некорректная валюта" };

  const category = String(payload.category ?? "").trim();
  const direction = payload.direction === "income" ? "income" : "expense";
  const periodicity = PERIODICITIES.includes(String(payload.periodicity))
    ? String(payload.periodicity)
    : "monthly";
  let dayOfMonth = Math.round(Number(payload.dayOfMonth));
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) dayOfMonth = 1;

  let month: number | null = null;
  if (periodicity === "yearly") {
    const m = Math.round(Number(payload.month));
    month = Number.isInteger(m) && m >= 1 && m <= 12 ? m : 1;
  }
  let intervalMonths: number | null = null;
  let anchorMonth: string | null = null;
  if (periodicity === "every_n_months") {
    const n = Math.round(Number(payload.intervalMonths));
    intervalMonths = Number.isInteger(n) && n >= 1 ? n : 3;
    const am = String(payload.anchorMonth ?? "");
    anchorMonth = /^\d{4}-\d{2}$/.test(am) ? am : null;
  }
  const source = payload.source === "suggested" ? "suggested" : "manual";
  return { name, amountCents, currency, category, direction, periodicity, dayOfMonth, month, intervalMonths, anchorMonth, source };
}

export async function GET() {
  try {
    await ensureSchema();
    const rows = await getD1()
      .prepare(
        `SELECT id, name, amount_cents, currency, category, direction, periodicity,
                day_of_month, month, interval_months, anchor_month, active, source
         FROM regular_payments WHERE active = 1 ORDER BY amount_cents DESC, id`
      )
      .all<RegularRow>();
    return Response.json({ regularPayments: (rows.results ?? []).map(toClient) });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const f = normalizeFields(await readPayload(request));
    if ("error" in f) return Response.json({ error: f.error }, { status: 400 });
    const created = await getD1()
      .prepare(
        `INSERT INTO regular_payments
           (name, amount_cents, currency, category, direction, periodicity, day_of_month, month, interval_months, anchor_month, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id, name, amount_cents, currency, category, direction, periodicity, day_of_month, month, interval_months, anchor_month, active, source`
      )
      .bind(f.name, f.amountCents, f.currency, f.category, f.direction, f.periodicity, f.dayOfMonth, f.month, f.intervalMonths, f.anchorMonth, f.source)
      .first<RegularRow>();
    return Response.json({ regularPayment: created ? toClient(created) : null }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const id = parseId(payload.id);
    if (!id) return Response.json({ error: "Некорректный платёж" }, { status: 400 });
    const f = normalizeFields(payload);
    if ("error" in f) return Response.json({ error: f.error }, { status: 400 });
    const d1 = getD1();
    await d1
      .prepare(
        `UPDATE regular_payments SET name = ?, amount_cents = ?, currency = ?, category = ?,
           direction = ?, periodicity = ?, day_of_month = ?, month = ?, interval_months = ?, anchor_month = ?
         WHERE id = ?`
      )
      .bind(f.name, f.amountCents, f.currency, f.category, f.direction, f.periodicity, f.dayOfMonth, f.month, f.intervalMonths, f.anchorMonth, id)
      .run();
    const row = await d1
      .prepare(
        `SELECT id, name, amount_cents, currency, category, direction, periodicity,
                day_of_month, month, interval_months, anchor_month, active, source
         FROM regular_payments WHERE id = ?`
      )
      .bind(id)
      .first<RegularRow>();
    return Response.json({ regularPayment: row ? toClient(row) : null });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const id = parseId(new URL(request.url).searchParams.get("id"));
    if (!id) return Response.json({ error: "Некорректный платёж" }, { status: 400 });
    await getD1().prepare("DELETE FROM regular_payments WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
