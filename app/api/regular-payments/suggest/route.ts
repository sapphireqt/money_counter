import { currentMonthKey, ensureSchema, getD1 } from "../../../../db";
import { normalizeKey, suggestRegulars, type SuggestTx } from "../../../../lib/forecast";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

const monthEnd = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};

// Suggest recurring payments from the last 6 complete months' expenses in the
// bill/subscription categories, excluding ones already added.
export async function GET() {
  try {
    await ensureSchema();
    const d1 = getD1();
    const [cy, cm] = currentMonthKey().split("-").map(Number);
    const windowMonths: string[] = [];
    for (let i = 6; i >= 1; i -= 1) {
      const d = new Date(cy, cm - 1 - i, 1);
      windowMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    const start = `${windowMonths[0]}-01`;
    const end = monthEnd(windowMonths[windowMonths.length - 1]);

    const rows = await d1
      .prepare(
        `SELECT t.date AS date, t.amount_cents AS amountCents, a.currency AS currency,
                t.category AS category, t.description AS description, t.payee AS payee
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE t.amount_cents < 0 AND t.transfer_group IS NULL
           AND t.category IN ('B (must-pay)', 'LS (apps)')
           AND t.date >= ? AND t.date <= ?`
      )
      .bind(start, end)
      .all<SuggestTx>();

    const existing = await d1
      .prepare("SELECT name FROM regular_payments WHERE active = 1")
      .all<{ name: string }>();
    const excludeKeys = (existing.results ?? []).map((r) => normalizeKey(r.name));

    const suggestions = suggestRegulars(rows.results ?? [], { windowMonths, excludeKeys });
    return Response.json({ suggestions });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
