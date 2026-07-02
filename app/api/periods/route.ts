import { currentMonthKey, ensureSchema, getD1 } from "../../../db";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

// Distinct YYYY-MM months that have at least one transaction (newest first),
// plus the period status: past months are closed ("frozen") unless listed in
// openMonths; the current month is always open.
export async function GET() {
  try {
    await ensureSchema();
    const d1 = getD1();
    const [rows, open] = await Promise.all([
      d1
        .prepare(
          `SELECT DISTINCT substr(t.date, 1, 7) AS month
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           WHERE a.archived_at IS NULL
           ORDER BY month DESC`
        )
        .all<{ month: string }>(),
      d1
        .prepare("SELECT month FROM open_periods ORDER BY month DESC")
        .all<{ month: string }>(),
    ]);
    return Response.json({
      periods: (rows.results ?? []).map((row) => row.month),
      openMonths: (open.results ?? []).map((row) => row.month),
      currentMonth: currentMonthKey(),
    });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

// POST { month: "YYYY-MM", open: boolean } — reopen a closed past month for
// edits, or close it back. Only past months have a toggle; the current month
// is open by definition.
export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = (await request.json().catch(() => ({}))) as {
      month?: unknown;
      open?: unknown;
    };
    const month = String(payload.month ?? "").trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return Response.json({ error: "Некорректный период" }, { status: 400 });
    }
    if (month >= currentMonthKey()) {
      return Response.json(
        { error: "Текущий период ещё идёт — закрывать и переоткрывать можно только прошедшие месяцы" },
        { status: 400 }
      );
    }

    const open = Boolean(payload.open);
    if (open) {
      await getD1()
        .prepare("INSERT OR IGNORE INTO open_periods (month) VALUES (?)")
        .bind(month)
        .run();
    } else {
      await getD1()
        .prepare("DELETE FROM open_periods WHERE month = ?")
        .bind(month)
        .run();
    }
    return Response.json({ month, open });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
