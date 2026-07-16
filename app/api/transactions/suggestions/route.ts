import { ensureSchema, getD1 } from "../../../../db";
import {
  descriptionHistoryWindowStart,
  rankDescriptionSuggestions,
  type DescriptionHistoryRow,
} from "../../../../lib/operations";

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    if ([...query].length < 2) return Response.json({ suggestions: [] });

    const rows = await getD1()
      .prepare(
        `SELECT description, category, date
         FROM transactions
         WHERE date >= ?
           AND transfer_group IS NULL
           AND TRIM(description) <> ''
         ORDER BY date DESC, id DESC`
      )
      .bind(descriptionHistoryWindowStart(new Date()))
      .all<DescriptionHistoryRow>();

    return Response.json({
      suggestions: rankDescriptionSuggestions(rows.results ?? [], query, 8),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ error: message }, { status: 500 });
  }
}
