import { ensureSchema, getD1 } from "../../../db";

type RuleRow = {
  id: number;
  pattern: string;
  category: string;
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
      .prepare("SELECT id, pattern, category FROM category_rules ORDER BY id")
      .all<RuleRow>();
    return Response.json({ rules: rows.results ?? [] });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const pattern = String(payload.pattern ?? "").trim();
    const category = String(payload.category ?? "").trim();

    if (!pattern) {
      return Response.json({ error: "Укажите текст для поиска" }, { status: 400 });
    }
    if (!category) {
      return Response.json({ error: "Укажите категорию" }, { status: 400 });
    }

    const d1 = getD1();
    // Make sure the target category exists so it appears in the picker — match
    // case-insensitively (consistent with POST /api/categories) so a rule for
    // "food" doesn't spawn a duplicate of an existing "Food".
    const existingCategory = await d1
      .prepare("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)")
      .bind(category)
      .first<{ id: number }>();
    if (!existingCategory) {
      await d1.prepare("INSERT INTO categories (name) VALUES (?)").bind(category).run();
    }

    const created = await d1
      .prepare(
        "INSERT INTO category_rules (pattern, category) VALUES (?, ?) RETURNING id, pattern, category"
      )
      .bind(pattern, category)
      .first<RuleRow>();

    return Response.json({ rule: created }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const id = parseId(payload.id);
    const pattern = String(payload.pattern ?? "").trim();
    const category = String(payload.category ?? "").trim();
    if (!id) {
      return Response.json({ error: "Некорректное правило" }, { status: 400 });
    }
    if (!pattern) {
      return Response.json({ error: "Укажите текст для поиска" }, { status: 400 });
    }
    if (!category) {
      return Response.json({ error: "Укажите категорию" }, { status: 400 });
    }

    const d1 = getD1();
    // Same as POST: make sure the target category exists in the vocabulary.
    const existingCategory = await d1
      .prepare("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)")
      .bind(category)
      .first<{ id: number }>();
    if (!existingCategory) {
      await d1.prepare("INSERT INTO categories (name) VALUES (?)").bind(category).run();
    }

    await d1
      .prepare("UPDATE category_rules SET pattern = ?, category = ? WHERE id = ?")
      .bind(pattern, category, id)
      .run();
    const rule = await d1
      .prepare("SELECT id, pattern, category FROM category_rules WHERE id = ?")
      .bind(id)
      .first<RuleRow>();
    return Response.json({ rule });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const id = parseId(new URL(request.url).searchParams.get("id"));
    if (!id) {
      return Response.json({ error: "Некорректное правило" }, { status: 400 });
    }
    await getD1().prepare("DELETE FROM category_rules WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
