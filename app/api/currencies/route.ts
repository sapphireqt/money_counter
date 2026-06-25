import { normalizeCurrency } from "../../../lib/finance";
import { ensureSchema, getD1 } from "../../../db";

type CurrencyRow = {
  code: string;
  name: string;
  symbol: string;
};

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }
  return message;
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
      .prepare("SELECT code, name, symbol FROM currencies ORDER BY code")
      .all<CurrencyRow>();
    return Response.json({ currencies: rows.results ?? [] });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const code = normalizeCurrency(payload.code);
    if (!code) {
      return Response.json({ error: "Код валюты обязателен (3 буквы)" }, { status: 400 });
    }
    const name = String(payload.name ?? "").trim();
    const symbol = String(payload.symbol ?? "").trim();

    const d1 = getD1();
    const existing = await d1
      .prepare("SELECT code, name, symbol FROM currencies WHERE code = ?")
      .bind(code)
      .first<CurrencyRow>();
    if (existing) {
      return Response.json({ currency: existing });
    }

    const created = await d1
      .prepare(
        "INSERT INTO currencies (code, name, symbol) VALUES (?, ?, ?) RETURNING code, name, symbol"
      )
      .bind(code, name, symbol)
      .first<CurrencyRow>();
    return Response.json({ currency: created }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const code = normalizeCurrency(payload.code);
    if (!code) {
      return Response.json({ error: "Некорректный код валюты" }, { status: 400 });
    }

    // The code is the identity, so only the label fields are editable.
    const assignments: string[] = [];
    const values: string[] = [];
    if ("name" in payload) {
      assignments.push("name = ?");
      values.push(String(payload.name ?? "").trim());
    }
    if ("symbol" in payload) {
      assignments.push("symbol = ?");
      values.push(String(payload.symbol ?? "").trim());
    }
    if (assignments.length === 0) {
      return Response.json({ error: "Нет изменений" }, { status: 400 });
    }

    const d1 = getD1();
    await d1
      .prepare(`UPDATE currencies SET ${assignments.join(", ")} WHERE code = ?`)
      .bind(...values, code)
      .run();
    const currency = await d1
      .prepare("SELECT code, name, symbol FROM currencies WHERE code = ?")
      .bind(code)
      .first<CurrencyRow>();
    return Response.json({ currency });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureSchema();
    const code = normalizeCurrency(new URL(request.url).searchParams.get("code"));
    if (!code) {
      return Response.json({ error: "Некорректный код валюты" }, { status: 400 });
    }
    const d1 = getD1();
    // Don't orphan accounts: refuse to delete a currency still in use.
    const inUse = await d1
      .prepare(
        "SELECT COUNT(*) AS n FROM accounts WHERE currency = ? AND archived_at IS NULL"
      )
      .bind(code)
      .first<{ n: number }>();
    if ((inUse?.n ?? 0) > 0) {
      return Response.json(
        { error: `Валюта ${code} используется счетами — сначала смените её на счетах` },
        { status: 400 }
      );
    }
    await d1.prepare("DELETE FROM currencies WHERE code = ?").bind(code).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
