import { ensureSchema, getD1 } from "../../../../db";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

// POST { ids: number[] } — persist the manual order from Настройки: each
// category gets sort_order = its index. Ids not in the list keep 9999 and
// fall back to the alphabetical tail.
export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = (await request.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(payload.ids)
      ? payload.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (ids.length === 0 || ids.length > 500) {
      return Response.json({ error: "Некорректный порядок" }, { status: 400 });
    }
    const d1 = getD1();
    await d1.batch(
      ids.map((id, index) =>
        d1
          .prepare("UPDATE categories SET sort_order = ? WHERE id = ?")
          .bind(index, id)
      )
    );
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
