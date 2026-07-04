import { matchCategoryRule, type CategoryRule } from "../../../../lib/finance";
import { ensureSchema, getD1 } from "../../../../db";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

// Apply rules to transactions, matching against description and payee.
// By default only uncategorized transactions are touched; with ?overwrite=1 the
// rules run over ALL transactions, overwriting the category wherever a rule
// matches (transactions with no matching rule keep their current category).
// With ?ruleId=N only that rule is applied — the per-rule «применить ко всем»
// action, which implies overwrite. Transfer legs are never touched: a movement
// between own accounts must not sit in a category.
// Returns how many transactions were (re)categorized.
export async function POST(request: Request) {
  try {
    await ensureSchema();
    const d1 = getD1();
    const params = new URL(request.url).searchParams;
    const ruleId = Number(params.get("ruleId"));
    const overwrite =
      params.get("overwrite") === "1" || Number.isInteger(ruleId) && ruleId > 0;

    const ruleRows = await d1
      .prepare("SELECT id, pattern, category FROM category_rules ORDER BY id")
      .all<CategoryRule & { id: number }>();
    let rules = ruleRows.results ?? [];
    if (Number.isInteger(ruleId) && ruleId > 0) {
      rules = rules.filter((rule) => rule.id === ruleId);
      if (rules.length === 0) {
        return Response.json({ error: "Правило не найдено" }, { status: 404 });
      }
    }

    if (rules.length === 0) {
      return Response.json({ updated: 0 });
    }

    const txRows = await d1
      .prepare(
        overwrite
          ? "SELECT id, description, payee, category FROM transactions WHERE transfer_group IS NULL"
          : "SELECT id, description, payee, category FROM transactions WHERE transfer_group IS NULL AND (category = '' OR category IS NULL)"
      )
      .all<{ id: number; description: string; payee: string; category: string }>();

    const updates: Array<ReturnType<typeof d1.prepare>> = [];
    for (const tx of txRows.results ?? []) {
      const category =
        matchCategoryRule(tx.description, rules) ||
        matchCategoryRule(tx.payee, rules);
      // Skip no-op writes so `updated` reflects rows that actually changed.
      if (category && category.toLowerCase() !== String(tx.category ?? "").toLowerCase()) {
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
