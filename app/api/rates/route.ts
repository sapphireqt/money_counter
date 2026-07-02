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
 * Frankfurter v2 API, and whatever it does not cover (crypto tickers like
 * TRX/USDT/BTC) is looked up on Kraken's keyless public OHLC API. Currencies
 * neither upstream covers are simply omitted from the response, so the client
 * can flag them.
 *
 *   GET /api/rates?date=YYYY-MM-DD&currencies=EUR,USD,THB,TRX
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
          .filter((code) => /^[A-Z]{3,5}$/.test(code))
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

    // Frankfurter rejects the WHOLE request with 422 when any unknown code is
    // in `quotes` (it does not skip them), so partition by its supported-
    // currencies list first. Codes it does not support (crypto tickers) go to
    // the Kraken fallback below — and ONLY those, so a transient Frankfurter
    // failure never caches a fiat currency from an exchange's spot price.
    let fiatToFetch = toFetch;
    let cryptoCandidates: string[] | null = null;
    if (toFetch.length > 0) {
      try {
        const response = await fetch("https://api.frankfurter.dev/v2/currencies", {
          headers: { "User-Agent": "money-counter" },
        });
        if (response.ok) {
          // v2 answers an ARRAY of {iso_code, ...}; v1 answered a {code: name}
          // map. Accept both so an upstream shape change degrades gracefully.
          const data = (await response.json()) as unknown;
          const supported = new Set<string>();
          if (Array.isArray(data)) {
            for (const item of data) {
              const code = (item as { iso_code?: unknown })?.iso_code;
              if (typeof code === "string") supported.add(code.toUpperCase());
            }
          } else if (data && typeof data === "object") {
            for (const code of Object.keys(data)) supported.add(code.toUpperCase());
          }
          if (supported.size > 0) {
            fiatToFetch = toFetch.filter((code) => supported.has(code));
            cryptoCandidates = toFetch.filter((code) => !supported.has(code));
          }
        }
      } catch {
        // Could not partition: try the full list below (all-fiat requests
        // still succeed) and let the fallback pick up whatever stays missing.
      }
    }

    if (fiatToFetch.length > 0) {
      // Frankfurter v2 (multi-provider, keyless) covers RUB/AED unlike the ECB
      // legacy v1. Weekend/holiday dates resolve to the prior trading day.
      try {
        const url =
          `https://api.frankfurter.dev/v2/rates?date=${date}` +
          `&base=USD&quotes=${fiatToFetch.join(",")}`;
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

    // Crypto fallback: codes the fiat upstream does not support are looked up
    // on Kraken's keyless public OHLC API, which quotes directly in USD and
    // accepts common ticker aliases (BTC -> XXBT pair). Daily candles reach
    // back only ~720 days; older dates stay missing and get flagged by the
    // client. Same base as fiat: 1 USD = 1/close units of the coin.
    const cryptoMissing = (cryptoCandidates ?? toFetch).filter(
      (code) => !(code in rates)
    );
    if (cryptoMissing.length > 0) {
      const [year, month, day] = date.split("-").map(Number);
      const dayStart = Date.UTC(year, month - 1, day) / 1000;
      // Today's daily candle is still forming: its close is just the latest
      // trade. Return it for display, but never write it into the immutable
      // historical cache — the day's real close would be masked forever.
      const now = new Date();
      const todayStart =
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
      const cacheable = dayStart < todayStart;
      const inserts = [];
      // Sequential on purpose — Kraken's public rate limit is ~1 req/sec, and
      // results are cached in D1 so each (date, coin) pair is fetched once.
      for (const code of cryptoMissing) {
        try {
          const url =
            `https://api.kraken.com/0/public/OHLC?pair=${code}USD` +
            `&interval=1440&since=${dayStart - 86400}`;
          const response = await fetch(url, {
            headers: { "User-Agent": "money-counter" },
          });
          if (!response.ok) continue;
          const data = (await response.json()) as {
            error?: string[];
            result?: Record<string, unknown>;
          };
          if ((data.error ?? []).length > 0) continue; // e.g. unknown pair
          // The result key is Kraken's canonical pair name (XXBTZUSD for
          // BTCUSD), so take the lone non-"last" entry instead of guessing.
          const candles = Object.entries(data.result ?? {}).find(
            ([key]) => key !== "last"
          )?.[1];
          if (!Array.isArray(candles)) continue;
          // Candle time is the UTC day start. Prefer the exact day; allow the
          // prior day as a gap fallback, never a candle after the requested
          // date (that would cache a wrong "historical" price).
          let close = 0;
          let bestTime = -Infinity;
          for (const candle of candles) {
            if (!Array.isArray(candle)) continue;
            const time = Number(candle[0]);
            if (time > dayStart || time <= bestTime) continue;
            bestTime = time;
            close = Number(candle[4]);
          }
          if (!Number.isFinite(close) || close <= 0) continue;
          rates[code] = 1 / close;
          if (cacheable) {
            inserts.push(
              d1
                .prepare(
                  "INSERT OR REPLACE INTO exchange_rates (date, currency, usd_rate) VALUES (?, ?, ?)"
                )
                .bind(date, code, 1 / close)
            );
          }
        } catch {
          // Same policy as the fiat upstream: return what we have.
        }
      }
      if (inserts.length > 0) await d1.batch(inserts);
    }

    return Response.json({ date, base: "USD", rates });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
