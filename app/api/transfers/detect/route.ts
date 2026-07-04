import { ensureSchema, getD1 } from "../../../../db";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

type CandidateRow = {
  id: number;
  account_id: number;
  account_name: string;
  currency: string;
  date: string;
  description: string;
  amount_cents: number;
};

function dayNumber(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
}

const MAX_DAY_GAP = 3;

/**
 * Conservative auto-detection of transfer pairs among unlinked operations:
 * same currency, same absolute amount, opposite signs, different accounts,
 * dates within ±3 days. Each leg is used at most once; for every expense the
 * closest-by-date candidate wins. The client shows the result for review —
 * nothing is linked here.
 */
export async function GET() {
  try {
    await ensureSchema();
    const rows = await getD1()
      .prepare(
        `SELECT t.id, t.account_id, a.name AS account_name, a.currency,
                t.date, t.description, t.amount_cents
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.archived_at IS NULL AND t.transfer_group IS NULL
         ORDER BY t.date, t.id`
      )
      .all<CandidateRow>();

    const legs = rows.results ?? [];
    // Incoming legs indexed by (currency, amount) for O(1) candidate lookup.
    const incomingByKey = new Map<string, CandidateRow[]>();
    for (const leg of legs) {
      if (leg.amount_cents <= 0) continue;
      const key = `${leg.currency}::${leg.amount_cents}`;
      const bucket = incomingByKey.get(key) ?? [];
      bucket.push(leg);
      incomingByKey.set(key, bucket);
    }

    const used = new Set<number>();
    const pairs: Array<{ out: CandidateRow; incoming: CandidateRow }> = [];
    for (const out of legs) {
      if (out.amount_cents >= 0) continue;
      const key = `${out.currency}::${-out.amount_cents}`;
      const candidates = incomingByKey.get(key) ?? [];
      let best: CandidateRow | null = null;
      let bestGap = MAX_DAY_GAP + 1;
      for (const candidate of candidates) {
        if (used.has(candidate.id)) continue;
        if (candidate.account_id === out.account_id) continue;
        const gap = Math.abs(dayNumber(candidate.date) - dayNumber(out.date));
        if (gap < bestGap) {
          best = candidate;
          bestGap = gap;
        }
      }
      if (best) {
        used.add(best.id);
        pairs.push({ out, incoming: best });
      }
    }

    return Response.json({
      pairs: pairs.map(({ out, incoming }) => ({
        out: {
          id: out.id,
          accountName: out.account_name,
          currency: out.currency,
          date: out.date,
          description: out.description,
          amountCents: out.amount_cents,
        },
        incoming: {
          id: incoming.id,
          accountName: incoming.account_name,
          currency: incoming.currency,
          date: incoming.date,
          description: incoming.description,
          amountCents: incoming.amount_cents,
        },
      })),
    });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
