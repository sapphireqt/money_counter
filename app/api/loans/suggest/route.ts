import { currentMonthKey, ensureSchema, getD1 } from "../../../../db";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

type Row = { date: string; amountCents: number; currency: string; description: string };

// Suggest loans from transactions categorized «займ» over the last 12 months.
// Direction guess: money OUT = we lent (owed back to us); money IN = we borrowed
// (we owe). The due date is the user's to set — the source date is offered as a
// starting point. Deduped against existing loans by amount+currency.
export async function GET() {
  try {
    await ensureSchema();
    const d1 = getD1();
    const [cy, cm] = currentMonthKey().split("-").map(Number);
    const s = new Date(cy, cm - 1 - 12, 1);
    const start = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-01`;

    const rows = await d1
      .prepare(
        `SELECT t.date AS date, t.amount_cents AS amountCents, a.currency AS currency, t.description AS description
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE LOWER(TRIM(t.category)) = 'займ' AND t.transfer_group IS NULL AND t.date >= ?
         ORDER BY t.date DESC`
      )
      .bind(start)
      .all<Row>();

    const existing = await d1
      .prepare("SELECT amount_cents, currency FROM loans")
      .all<{ amount_cents: number; currency: string }>();
    const seen = new Set((existing.results ?? []).map((l) => `${Math.abs(l.amount_cents)}|${l.currency}`));

    const suggestions = (rows.results ?? [])
      .filter((t) => !seen.has(`${Math.abs(t.amountCents)}|${t.currency}`))
      .map((t) => ({
        name: t.description || "Заём",
        amountCents: Math.abs(t.amountCents),
        currency: t.currency,
        direction: t.amountCents < 0 ? "owed" : "owe",
        sourceDate: t.date,
      }));
    return Response.json({ suggestions });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
