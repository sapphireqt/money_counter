import {
  matchCategoryRule,
  normalizeCurrency,
  normalizeDateInput,
  resolveSignedAmountCents,
  type CategoryRule,
} from "../../../lib/finance";
import { ensureSchema, findClosedMonths, getD1 } from "../../../db";

type ImportRow = {
  accountName?: string;
  currency?: string;
  date?: string;
  amount?: string | number;
  amountCents?: string | number;
  direction?: string;
  description?: string;
  category?: string;
  payee?: string;
  notes?: string;
};

type AccountLookup = {
  id: number;
  name: string;
  currency: string;
};

const palette = [
  "#2563eb",
  "#0f766e",
  "#b45309",
  "#be123c",
  "#6d28d9",
  "#0369a1",
  "#4d7c0f",
];

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";

  if (message.includes("no such table")) {
    return "База данных еще не готова. Сгенерируйте и примените миграции D1, затем откройте сайт снова.";
  }

  return message;
}

function accountKey(name: string, currency: string) {
  return `${name.trim().toLowerCase()}::${currency}`;
}

async function readPayload(request: Request) {
  try {
    return (await request.json()) as {
      rows?: ImportRow[];
      accountId?: number | string;
    };
  } catch {
    return {};
  }
}

function parseId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function dedupeKey(accountId: number, date: string, amountCents: number, description: string) {
  return `${accountId}::${date}::${amountCents}::${description.trim().toLowerCase()}`;
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const payload = await readPayload(request);
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const forcedAccountId = parseId(payload.accountId);

    if (rows.length === 0) {
      return Response.json({ error: "Нет строк для импорта" }, { status: 400 });
    }

    if (rows.length > 2000) {
      return Response.json(
        { error: "За один импорт можно загрузить до 2000 строк" },
        { status: 400 }
      );
    }

    // Freeze guard, checked up front (the main loop creates accounts as a side
    // effect, so rejecting mid-way would leave partial state). All-or-nothing:
    // a single row inside a closed month blocks the whole import until the
    // month is reopened or the rows are removed from the file.
    const closedMonths = await findClosedMonths(
      rows
        .map((row) => normalizeDateInput(row.date) ?? "")
        .filter((date) => date !== "")
    );
    if (closedMonths.length > 0) {
      return Response.json(
        {
          error:
            `Импорт затрагивает закрытые периоды: ${closedMonths.join(", ")}. ` +
            "Переоткройте их или уберите эти строки из файла.",
        },
        { status: 409 }
      );
    }

    const d1 = getD1();
    const existingAccounts = await d1
      .prepare(
        "SELECT id, name, currency FROM accounts WHERE archived_at IS NULL ORDER BY id"
      )
      .all<AccountLookup>();
    const accountsByKey = new Map<string, AccountLookup>();
    const accountsById = new Map<number, AccountLookup>();

    for (const account of existingAccounts.results ?? []) {
      accountsByKey.set(accountKey(account.name, account.currency), account);
      accountsById.set(account.id, account);
    }

    let forcedAccount: AccountLookup | null = null;
    if (forcedAccountId !== null) {
      forcedAccount = accountsById.get(forcedAccountId) ?? null;
      if (!forcedAccount) {
        return Response.json({ error: "Выбранный счет не найден" }, { status: 400 });
      }
    }

    // Auto-categorization rules — applied when a row has no category of its own.
    const ruleRows = await d1
      .prepare("SELECT pattern, category FROM category_rules ORDER BY id")
      .all<CategoryRule>();
    const rules = ruleRows.results ?? [];

    // Fingerprints of transactions ALREADY in the DB per account, so re-importing
    // an overlapping period is idempotent. Seeded from the DB only — fingerprints
    // are NOT added during this import, so two genuinely identical rows in one
    // file (e.g. two coffees same day/price) both import.
    const existingKeys = new Map<number, Set<string>>();
    const loadExistingKeys = async (accountId: number) => {
      const cached = existingKeys.get(accountId);
      if (cached) {
        return cached;
      }
      const set = new Set<string>();
      const existing = await d1
        .prepare(
          "SELECT date, amount_cents, description FROM transactions WHERE account_id = ?"
        )
        .bind(accountId)
        .all<{ date: string; amount_cents: number; description: string }>();
      for (const tx of existing.results ?? []) {
        set.add(dedupeKey(accountId, tx.date, tx.amount_cents, tx.description));
      }
      existingKeys.set(accountId, set);
      return set;
    };

    const insertSql = `INSERT INTO transactions (
      account_id,
      date,
      description,
      category,
      payee,
      amount_cents,
      notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)`;

    let createdAccounts = 0;
    let duplicates = 0;
    const rejected: Array<{ row: number; reason: string }> = [];
    const inserts: Array<ReturnType<typeof d1.prepare>> = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = index + 1;
      const date = normalizeDateInput(row.date);
      const amountCents = resolveSignedAmountCents(
        row.amount ?? row.amountCents,
        row.direction
      );

      if (!date) {
        rejected.push({ row: rowNumber, reason: "некорректная дата" });
        continue;
      }

      if (amountCents === null || amountCents === 0) {
        rejected.push({ row: rowNumber, reason: "некорректная сумма" });
        continue;
      }

      let account = forcedAccount;

      if (account) {
        // Currency lives on the account, not the row — flag rows that belong to
        // a different currency so they aren't silently mislabeled.
        const rowCurrency = String(row.currency ?? "").trim();
        if (rowCurrency && normalizeCurrency(rowCurrency) !== account.currency) {
          rejected.push({ row: rowNumber, reason: "другая валюта" });
          continue;
        }
      } else {
        const accountName = String(row.accountName ?? "").trim();
        const currency = normalizeCurrency(row.currency);

        if (!accountName) {
          rejected.push({ row: rowNumber, reason: "не указан счет" });
          continue;
        }

        const key = accountKey(accountName, currency);
        account = accountsByKey.get(key) ?? null;

        if (!account) {
          const created = await d1
            .prepare(
              `INSERT INTO accounts (name, currency, color)
               VALUES (?, ?, ?)
               RETURNING id, name, currency`
            )
            .bind(
              accountName,
              currency,
              palette[accountsByKey.size % palette.length]
            )
            .first<AccountLookup>();

          if (!created) {
            rejected.push({ row: rowNumber, reason: "счет не создан" });
            continue;
          }

          account = created;
          accountsByKey.set(key, created);
          accountsById.set(created.id, created);
          createdAccounts += 1;
        }
      }

      const description =
        String(row.description ?? "").trim() ||
        (amountCents > 0 ? "Поступление" : "Расход");
      const payee = String(row.payee ?? "").trim();
      const category =
        String(row.category ?? "").trim() ||
        matchCategoryRule(description, rules) ||
        matchCategoryRule(payee, rules);

      const keys = await loadExistingKeys(account.id);
      const fingerprint = dedupeKey(account.id, date, amountCents, description);
      if (keys.has(fingerprint)) {
        duplicates += 1;
        continue;
      }

      inserts.push(
        d1
          .prepare(insertSql)
          .bind(
            account.id,
            date,
            description,
            category,
            payee,
            amountCents,
            String(row.notes ?? "").trim()
          )
      );
    }

    // One batch = one implicit transaction in D1, so the whole import is
    // all-or-nothing (the row cap above keeps it within batch limits).
    if (inserts.length > 0) {
      await d1.batch(inserts);
    }

    return Response.json({
      createdAccounts,
      createdTransactions: inserts.length,
      duplicates,
      rejected,
    });
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}
