import { normalizeCurrency, normalizeDateInput } from "../../../lib/finance";
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

/**
 * Aggregates for the visualization tab, scoped to a date range and a single
 * currency (mixing currencies in one sum is meaningless). Returns per-month
 * income/expense and expenses grouped by category.
 */
export async function GET(request: Request) {
  try {
    await ensureSchema();
    const params = new URL(request.url).searchParams;
    // Transfer legs move money between own accounts — they are neither income
    // nor expense, so the charts must not count them.
    const conditions = ["a.archived_at IS NULL", "t.transfer_group IS NULL"];
    const values: Array<number | string> = [];

    const accountId = parseId(params.get("accountId"));
    const from = normalizeDateInput(params.get("from") ?? "");
    const to = normalizeDateInput(params.get("to") ?? "");
    const currency = params.get("currency");

    if (accountId) {
      conditions.push("t.account_id = ?");
      values.push(accountId);
    }
    if (from) {
      conditions.push("t.date >= ?");
      values.push(from);
    }
    if (to) {
      conditions.push("t.date <= ?");
      values.push(to);
    }
    if (currency && /^[A-Za-z]{3,5}$/.test(currency)) {
      conditions.push("a.currency = ?");
      values.push(normalizeCurrency(currency));
    }

    const where = conditions.join(" AND ");
    const d1 = getD1();

    const monthly = await d1
      .prepare(
        `SELECT substr(t.date, 1, 7) AS month,
                SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END) AS income,
                SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END) AS expense
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE ${where}
         GROUP BY month
         ORDER BY month`
      )
      .bind(...values)
      .all<{ month: string; income: number; expense: number }>();

    const byCategory = await d1
      .prepare(
        `SELECT CASE WHEN t.category = '' OR t.category IS NULL
                     THEN 'Без категории' ELSE t.category END AS category,
                SUM(-t.amount_cents) AS total
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE ${where} AND t.amount_cents < 0
         GROUP BY category
         ORDER BY total DESC`
      )
      .bind(...values)
      .all<{ category: string; total: number }>();

    const monthlyRows = monthly.results ?? [];
    const totals = monthlyRows.reduce(
      (acc, row) => ({
        income: acc.income + (row.income ?? 0),
        expense: acc.expense + (row.expense ?? 0),
      }),
      { income: 0, expense: 0 }
    );

    return Response.json({
      monthly: monthlyRows,
      byCategory: byCategory.results ?? [],
      totals,
    });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
