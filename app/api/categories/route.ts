import { normalizeColor } from "../../../lib/finance";
import { ensureSchema, getD1 } from "../../../db";

type CategoryRow = {
  id: number;
  name: string;
  color: string;
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

export async function GET() {
  try {
    await ensureSchema();
    const rows = await getD1()
      .prepare("SELECT id, name, color FROM categories ORDER BY LOWER(name)")
      .all<CategoryRow>();
    return Response.json({ categories: rows.results ?? [] });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const name = String(payload.name ?? "").trim();
    const color = normalizeColor(payload.color);

    if (!name) {
      return Response.json({ error: "Название категории обязательно" }, { status: 400 });
    }

    const d1 = getD1();
    const existing = await d1
      .prepare("SELECT id, name, color FROM categories WHERE LOWER(name) = LOWER(?)")
      .bind(name)
      .first<CategoryRow>();

    if (existing) {
      return Response.json({ category: existing });
    }

    const created = await d1
      .prepare(
        "INSERT INTO categories (name, color) VALUES (?, ?) RETURNING id, name, color"
      )
      .bind(name, color)
      .first<CategoryRow>();

    return Response.json({ category: created }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const id = parseId(new URL(request.url).searchParams.get("id"));
    if (!id) {
      return Response.json({ error: "Некорректная категория" }, { status: 400 });
    }
    await getD1().prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
