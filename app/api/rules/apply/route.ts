import { matchCategoryRule, type CategoryRule } from "../../../../lib/finance";
import { ensureSchema, getD1 } from "../../../../db";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

// Apply every rule to transactions that have no category yet, matching against
// description and payee. Returns how many transactions were categorized.
export async function POST() {
  try {
    await ensureSchema();
    const d1 = getD1();

    const ruleRows = await d1
      .prepare("SELECT pattern, category FROM category_rules ORDER BY id")
      .all<CategoryRule>();
    const rules = ruleRows.results ?? [];

    if (rules.length === 0) {
      return Response.json({ updated: 0 });
    }

    const txRows = await d1
      .prepare(
        "SELECT id, description, payee FROM transactions WHERE category = '' OR category IS NULL"
      )
      .all<{ id: number; description: string; payee: string }>();

    const updates: Array<ReturnType<typeof d1.prepare>> = [];
    for (const tx of txRows.results ?? []) {
      const category =
        matchCategoryRule(tx.description, rules) ||
        matchCategoryRule(tx.payee, rules);
      if (category) {
        updates.push(
          d1
            .prepare(
              "UPDATE transactions SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
            )
            .bind(category, tx.id)
        );
      }
    }

    const BATCH_SIZE = 100;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      await d1.batch(updates.slice(i, i + BATCH_SIZE));
    }

    return Response.json({ updated: updates.length });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
