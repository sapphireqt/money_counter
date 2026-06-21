import { ensureSchema, getD1 } from "../../../db";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

// Distinct YYYY-MM months that have at least one transaction, newest first.
export async function GET() {
  try {
    await ensureSchema();
    const rows = await getD1()
      .prepare(
        `SELECT DISTINCT substr(t.date, 1, 7) AS month
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.archived_at IS NULL
         ORDER BY month DESC`
      )
      .all<{ month: string }>();
    return Response.json({
      periods: (rows.results ?? []).map((row) => row.month),
    });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
