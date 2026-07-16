import { ensureSchema, getD1 } from "../../../../db";
import {
  rankDescriptionSuggestions,
  type DescriptionHistoryRow,
} from "../../../../lib/operations";

function twelveMonthsAgo(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(year - 1, month, day));
  return target.toISOString().slice(0, 10);
}

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
      .bind(twelveMonthsAgo(new Date()))
      .all<DescriptionHistoryRow>();

    return Response.json({
      suggestions: rankDescriptionSuggestions(rows.results ?? [], query, 8),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ error: message }, { status: 500 });
  }
}
