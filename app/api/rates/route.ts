import { normalizeDateInput } from "../../../lib/finance";
import { ensureSchema, getD1 } from "../../../db";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
}

/**
 * Historical FX rates for a single date, base USD (1 USD = rate units of the
 * currency). Results are cached in D1 (historical rates are immutable); on a
 * cache miss the missing currencies are fetched in one call from the keyless
 * Frankfurter v2 API and stored. Currencies the upstream does not cover are
 * simply omitted from the response, so the client can flag them.
 *
 *   GET /api/rates?date=YYYY-MM-DD&currencies=EUR,USD,THB,RUB
 *   -> { date, base: "USD", rates: { EUR: 0.9461, USD: 1, THB: 34.317, ... } }
 */
export async function GET(request: Request) {
  try {
    await ensureSchema();
    const params = new URL(request.url).searchParams;

    const date = normalizeDateInput(params.get("date") ?? "");
    if (!date) {
      return Response.json({ error: "Некорректная дата" }, { status: 400 });
    }

    const requested = [
      ...new Set(
        (params.get("currencies") ?? "")
          .split(",")
          .map((code) => code.trim().toUpperCase())
          .filter((code) => /^[A-Z]{3}$/.test(code))
      ),
    ];
    if (requested.length === 0) {
      return Response.json({ date, base: "USD", rates: {} });
    }

    const d1 = getD1();
    const placeholders = requested.map(() => "?").join(",");
    const existing = await d1
      .prepare(
        `SELECT currency, usd_rate FROM exchange_rates
         WHERE date = ? AND currency IN (${placeholders})`
      )
      .bind(date, ...requested)
      .all<{ currency: string; usd_rate: number }>();

    const rates: Record<string, number> = {};
    for (const row of existing.results ?? []) {
      rates[row.currency] = row.usd_rate;
    }

    const missing = requested.filter((code) => !(code in rates));

    // USD is the base, so it is always 1 — no need to ask the upstream.
    if (missing.includes("USD")) {
      rates.USD = 1;
      await d1
        .prepare(
          "INSERT OR IGNORE INTO exchange_rates (date, currency, usd_rate) VALUES (?, 'USD', 1)"
        )
        .bind(date)
        .run();
    }

    const toFetch = missing.filter((code) => code !== "USD");
    if (toFetch.length > 0) {
      // Frankfurter v2 (multi-provider, keyless) covers RUB/AED unlike the ECB
      // legacy v1. Weekend/holiday dates resolve to the prior trading day.
      try {
        const url =
          `https://api.frankfurter.dev/v2/rates?date=${date}` +
          `&base=USD&quotes=${toFetch.join(",")}`;
        const response = await fetch(url, {
          headers: { "User-Agent": "money-counter" },
        });
        if (response.ok) {
          const data = (await response.json()) as Array<{
            quote?: string;
            rate?: number;
          }>;
          const inserts = [];
          for (const item of Array.isArray(data) ? data : []) {
            if (typeof item.quote === "string" && typeof item.rate === "number") {
              const currency = item.quote.toUpperCase();
              rates[currency] = item.rate;
              inserts.push(
                d1
                  .prepare(
                    "INSERT OR REPLACE INTO exchange_rates (date, currency, usd_rate) VALUES (?, ?, ?)"
                  )
                  .bind(date, currency, item.rate)
              );
            }
          }
          if (inserts.length > 0) await d1.batch(inserts);
        }
      } catch {
        // Upstream/egress failure: return whatever is cached; the client flags
        // the currencies that could not be converted.
      }
    }

    return Response.json({ date, base: "USD", rates });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
