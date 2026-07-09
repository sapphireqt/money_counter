import { ensureSchema, getD1 } from "../../../db";
import { normalizeCurrency, normalizeDateInput } from "../../../lib/finance";

type LoanRow = {
  id: number;
  name: string;
  amount_cents: number;
  currency: string;
  direction: string;
  due_date: string;
  status: string;
  settled_date: string | null;
  notes: string;
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

function toClient(r: LoanRow) {
  return {
    id: r.id,
    name: r.name,
    amountCents: r.amount_cents,
    currency: r.currency,
    direction: r.direction,
    dueDate: r.due_date,
    status: r.status,
    settledDate: r.settled_date,
    notes: r.notes,
  };
}

const DIRECTIONS = ["owe", "owed", "reimbursement"]; // owe = we pay out; owed/reimbursement = we receive

function normalizeFields(payload: Record<string, unknown>) {
  const name = String(payload.name ?? "").trim();
  const amountCents = Math.round(Number(payload.amountCents));
  const currency = normalizeCurrency(String(payload.currency ?? ""));
  const direction = DIRECTIONS.includes(String(payload.direction)) ? String(payload.direction) : "owe";
  const dueDate = normalizeDateInput(String(payload.dueDate ?? ""));
  const status = payload.status === "settled" ? "settled" : "pending";
  const settledDate = status === "settled" ? normalizeDateInput(String(payload.settledDate ?? "")) : null;
  const notes = String(payload.notes ?? "").trim();
  if (!name) return { error: "Укажите название" };
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { error: "Некорректная сумма" };
  if (!currency) return { error: "Некорректная валюта" };
  if (!dueDate) return { error: "Некорректная дата" };
  return { name, amountCents, currency, direction, dueDate, status, settledDate, notes };
}

export async function GET() {
  try {
    await ensureSchema();
    const rows = await getD1()
      .prepare(
        `SELECT id, name, amount_cents, currency, direction, due_date, status, settled_date, notes
         FROM loans ORDER BY due_date, id`
      )
      .all<LoanRow>();
    return Response.json({ loans: (rows.results ?? []).map(toClient) });
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
        `INSERT INTO loans (name, amount_cents, currency, direction, due_date, status, settled_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id, name, amount_cents, currency, direction, due_date, status, settled_date, notes`
      )
      .bind(f.name, f.amountCents, f.currency, f.direction, f.dueDate, f.status, f.settledDate, f.notes)
      .first<LoanRow>();
    return Response.json({ loan: created ? toClient(created) : null }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const id = parseId(payload.id);
    if (!id) return Response.json({ error: "Некорректный заём" }, { status: 400 });
    const f = normalizeFields(payload);
    if ("error" in f) return Response.json({ error: f.error }, { status: 400 });
    const d1 = getD1();
    await d1
      .prepare(
        `UPDATE loans SET name = ?, amount_cents = ?, currency = ?, direction = ?, due_date = ?,
           status = ?, settled_date = ?, notes = ? WHERE id = ?`
      )
      .bind(f.name, f.amountCents, f.currency, f.direction, f.dueDate, f.status, f.settledDate, f.notes, id)
      .run();
    const row = await d1
      .prepare(
        `SELECT id, name, amount_cents, currency, direction, due_date, status, settled_date, notes
         FROM loans WHERE id = ?`
      )
      .bind(id)
      .first<LoanRow>();
    return Response.json({ loan: row ? toClient(row) : null });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const id = parseId(new URL(request.url).searchParams.get("id"));
    if (!id) return Response.json({ error: "Некорректный заём" }, { status: 400 });
    await getD1().prepare("DELETE FROM loans WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
