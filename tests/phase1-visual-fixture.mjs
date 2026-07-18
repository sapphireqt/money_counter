import assert from "node:assert/strict";

// Deterministic data for Phase 1 visual acceptance. This script deliberately
// refuses the normal development port: it must only be pointed at a fresh,
// isolated server/database created for screenshots.
const baseUrl = process.argv[2];
const isolatedFlag = process.argv[3];
if (!baseUrl || isolatedFlag !== "--isolated") {
  throw new Error(
    "Usage: node tests/phase1-visual-fixture.mjs http://127.0.0.1:3100 --isolated"
  );
}

const url = new URL(baseUrl);
if (!new Set(["127.0.0.1", "localhost"]).has(url.hostname) || url.port === "3000") {
  throw new Error("The visual fixture may only target an isolated loopback server, not port 3000");
}

async function request(path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${data.error ?? ""}`);
  }
  return data;
}

const accountSpecs = [
  ["Основной счёт", "EUR", "12850,40", "2024-01-01", ""],
  ["Семейный счёт", "EUR", "6420,00", "2024-01-01", ""],
  ["Долларовый резерв", "USD", "3650,00", "2024-01-01", ""],
  ["Наличные EUR", "EUR", "840,00", "2024-01-01", ""],
  ["Нулевой счёт", "EUR", "0,00", "2025-01-01", ""],
  ["Отпуск", "EUR", "1200,00", "2025-01-01", ""],
  ["Повседневные расходы", "EUR", "960,00", "2025-01-01", ""],
  ["Копилка", "EUR", "700,00", "2025-01-01", ""],
  ["Резерв 1", "EUR", "510,00", "2025-01-01", ""],
  ["Резерв 2", "EUR", "440,00", "2025-01-01", ""],
  ["Резерв 3", "EUR", "390,00", "2025-01-01", ""],
  ["Скрытый овердрафт", "EUR", "-275,00", "2025-01-01", ""],
  ["Закрытый исторический", "EUR", "80,00", "2024-01-01", "2026-06-30"],
  ["Будущий счёт", "EUR", "100,00", "2026-08-01", ""],
];

const accounts = [];
for (const [name, currency, openingBalance, openedAt, closedAt] of accountSpecs) {
  const data = await request("/api/accounts", {
    method: "POST",
    body: JSON.stringify({
      name,
      bankName: "",
      currency,
      type: "checking",
      openingBalance,
      color: "#8769c8",
      openedAt,
      closedAt,
    }),
  });
  accounts.push(data.account);
}

await request("/api/accounts/reorder", {
  method: "POST",
  body: JSON.stringify({ ids: accounts.map((account) => account.id) }),
});

const categorySpecs = [
  ["Продукты", "#8769c8"],
  ["Дом", "#4f68d9"],
  ["Транспорт", "#d78b1f"],
  ["Покупки", "#d55353"],
  ["Подписки", "#2e9b68"],
  ["Здоровье", "#5f8fa8"],
  ["Досуг", "#a06ba7"],
];

const categories = [];
for (const [name, color] of categorySpecs) {
  const data = await request("/api/categories", {
    method: "POST",
    body: JSON.stringify({ name, color }),
  });
  categories.push(data.category);
}

await request("/api/categories/reorder", {
  method: "POST",
  body: JSON.stringify({ ids: categories.map((category) => category.id) }),
});

async function addTransaction({
  account = accounts[0],
  date = "2026-07-13",
  direction = "expense",
  amount,
  description,
  category = "",
  notes = "",
  flagged = false,
}) {
  return request("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      accountId: account.id,
      date,
      direction,
      amount,
      description,
      category,
      notes,
      flagged,
    }),
  });
}

await addTransaction({
  account: accounts[1],
  date: "2026-07-15",
  direction: "income",
  amount: "4200,00",
  description: "Зарплата",
});

const longDay = [
  ["186,40", "Большая покупка продуктов для семейного ужина", "Продукты", 0],
  ["94,20", "Хозяйственные товары", "Дом", 1],
  ["76,80", "Проездные билеты", "Транспорт", 0],
  ["68,10", "Одежда", "Покупки", 1],
  ["42,90", "Онлайн-сервисы", "Подписки", 0],
  ["37,50", "Аптека", "Здоровье", 0],
  ["31,70", "Кино", "Досуг", 1],
  ["28,40", "Продуктовый магазин", "Продукты", 0],
  ["24,00", "Товары для кухни", "Дом", 1],
  ["18,60", "Такси", "Транспорт", 0],
  ["16,90", "Книга", "Покупки", 1],
  ["12,99", "Музыкальная подписка", "Подписки", 0],
  ["9,70", "Витамины", "Здоровье", 1],
  ["8,40", "Кофе", "Досуг", 0],
];

for (const [amount, description, category, accountIndex] of longDay) {
  await addTransaction({
    account: accounts[accountIndex],
    amount,
    description,
    category,
    flagged: description === "Хозяйственные товары",
    notes: description === "Хозяйственные товары" ? "Проверить чек" : "",
  });
}

await addTransaction({
  account: accounts[0],
  date: "2026-07-12",
  amount: "75,30",
  description: "Перевод в семейный резерв",
  category: "",
});
await addTransaction({
  account: accounts[1],
  date: "2026-07-12",
  direction: "income",
  amount: "75,30",
  description: "Перевод в семейный резерв",
});

await request("/api/transfers", {
  method: "POST",
  body: JSON.stringify({
    create: {
      fromAccountId: accounts[0].id,
      toAccountId: accounts[1].id,
      date: "2026-07-11",
      amount: "210,00",
      description: "Перевод между счетами",
    },
  }),
});

await request("/api/transfers", {
  method: "POST",
  body: JSON.stringify({
    create: {
      fromAccountId: accounts[0].id,
      toAccountId: accounts[2].id,
      date: "2026-07-10",
      amount: "320,00",
      amountIn: "348,25",
      description: "Пополнение долларового резерва",
      notes: "Курс согласован",
    },
  }),
});

// A transfer debited from the USD account: with display currency EUR this is
// the only fixture row whose native block (debit in USD + «→ credited EUR»)
// must be visible per the currency-only visibility rules.
await request("/api/transfers", {
  method: "POST",
  body: JSON.stringify({
    create: {
      fromAccountId: accounts[2].id,
      toAccountId: accounts[0].id,
      date: "2026-07-09",
      amount: "120,00",
      amountIn: "109,80",
      description: "Возврат из долларового резерва",
    },
  }),
});

for (const [date, amount] of [
  ["2026-06-18", "54,20"],
  ["2026-05-21", "49,80"],
  ["2026-04-17", "61,10"],
]) {
  await addTransaction({
    account: accounts[0],
    date,
    amount,
    description: "Mercado Central",
    category: "Продукты",
  });
}

// A row outside the selected July period for the toolbar's «Вся история»
// scope. The prototype has the same Carrefour history-search example.
await addTransaction({
  account: accounts[0],
  date: "2025-03-08",
  amount: "68,20",
  description: "Carrefour",
  category: "Продукты",
});

await request("/api/goals", {
  method: "PUT",
  body: JSON.stringify({ month: "2026-07", amountCents: 250000, currency: "EUR" }),
});

const activeJuly = accounts.filter(
  (account) =>
    (!account.openedAt || account.openedAt <= "2026-07-31") &&
    (!account.closedAt || account.closedAt >= "2026-07-01")
);
assert.equal(activeJuly.length, 12);
assert.equal(activeJuly.at(-1).balanceCents < 0, true);

process.stdout.write(
  JSON.stringify(
    {
      status: "PASS",
      accounts: accounts.length,
      activeJuly: activeJuly.length,
      categories: categories.length,
      period: "2026-07",
    },
    null,
    2
  ) + "\n"
);
