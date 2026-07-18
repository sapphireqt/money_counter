import assert from "node:assert/strict";
import test from "node:test";

import {
  accountIsActiveOn,
  buildCategoryPresentation,
  buildTransferRowPresentation,
  groupOperationItemsByDate,
  groupOperationItemsByYear,
  hasOperationListFilters,
  selectActiveAccountsOn,
  shouldLoadOperationHistory,
  sortOperationItems,
} from "../lib/phase1.ts";

test("transfer row presentation is the account pair plus money-only amounts", () => {
  const same = buildTransferRowPresentation(
    { accountName: "Основной счёт", accountCurrency: "EUR", amountCents: -21000 },
    { accountName: "Семейный счёт", accountCurrency: "EUR", amountCents: 21000 },
    "EUR"
  );
  assert.deepEqual(same, {
    accountLabel: "Основной счёт → Семейный счёт",
    debitAmountCents: 21000,
    debitCurrency: "EUR",
    creditAmountCents: 21000,
    creditCurrency: "EUR",
    showDebitNative: false,
    showCredited: false,
  });

  const cross = buildTransferRowPresentation(
    { accountName: "KAST AK", accountCurrency: "USD", amountCents: -600000 },
    { accountName: "BBVA", accountCurrency: "EUR", amountCents: 524580 },
    "EUR"
  );
  assert.deepEqual(cross, {
    accountLabel: "KAST AK → BBVA",
    debitAmountCents: 600000,
    debitCurrency: "USD",
    creditAmountCents: 524580,
    creditCurrency: "EUR",
    showDebitNative: true,
    showCredited: true,
  });
});

test("transfer amount visibility depends on currencies only", () => {
  const leg = (currency: string, cents: number) => ({
    accountName: `${currency} счёт`,
    accountCurrency: currency,
    amountCents: cents,
  });

  // USD → USD при display EUR: основная сумма EUR + одна дополнительная
  // строка списания в USD, строка «→» не показывается.
  const usdToUsd = buildTransferRowPresentation(leg("USD", -10000), leg("USD", 10000), "EUR");
  assert.equal(usdToUsd.showDebitNative, true);
  assert.equal(usdToUsd.debitCurrency, "USD");
  assert.equal(usdToUsd.showCredited, false);

  // EUR → EUR при display EUR: только основная сумма EUR — дополнительный
  // блок отсутствует, даже при равных числовых суммах.
  const eurToEur = buildTransferRowPresentation(leg("EUR", -10000), leg("EUR", 10000), "EUR");
  assert.equal(eurToEur.showDebitNative, false);
  assert.equal(eurToEur.showCredited, false);

  // USD → EUR при display EUR: основная сумма EUR + списание USD +
  // строка «→» с зачислением EUR.
  const usdToEur = buildTransferRowPresentation(leg("USD", -10000), leg("EUR", 9150), "EUR");
  assert.equal(usdToEur.showDebitNative, true);
  assert.equal(usdToEur.debitCurrency, "USD");
  assert.equal(usdToEur.showCredited, true);
  assert.equal(usdToEur.creditCurrency, "EUR");

  // Валюта списания совпадает с валютой отображения → дополнительного блока
  // нет вообще, даже когда валюта зачисления другая (EUR → USD при EUR).
  const eurToUsd = buildTransferRowPresentation(leg("EUR", -10000), leg("USD", 10900), "EUR");
  assert.equal(eurToUsd.showDebitNative, false);
  assert.equal(eurToUsd.showCredited, false);

  // Не выбрана display currency → ведёт себя как отображение в валюте
  // списания: блока нет.
  const noDisplay = buildTransferRowPresentation(leg("USD", -10000), leg("EUR", 9150), "");
  assert.equal(noDisplay.showDebitNative, false);
  assert.equal(noDisplay.showCredited, false);
});

test("account availability includes both lifetime boundary dates", () => {
  const account = { openedAt: "2026-03-10", closedAt: "2026-07-16" };

  assert.equal(accountIsActiveOn(account, "2026-03-09"), false);
  assert.equal(accountIsActiveOn(account, "2026-03-10"), true);
  assert.equal(accountIsActiveOn(account, "2026-07-16"), true);
  assert.equal(accountIsActiveOn(account, "2026-07-17"), false);
});

test("account options contain only accounts active on the selected date", () => {
  const accounts = [
    { id: 1, openedAt: "2026-01-01", closedAt: null },
    { id: 2, openedAt: "2026-08-01", closedAt: null },
    { id: 3, openedAt: null, closedAt: "2026-06-30" },
  ];

  assert.deepEqual(
    selectActiveAccountsOn(accounts, "2026-07-16").map((account) => account.id),
    [1]
  );
});

test("history scope expands only when search or filters are active", () => {
  const empty = {
    query: "",
    accountId: "all",
    type: "all",
    category: "",
    flaggedOnly: false,
  };

  assert.equal(hasOperationListFilters(empty), false);
  assert.equal(shouldLoadOperationHistory("history", empty), false);
  assert.equal(shouldLoadOperationHistory("period", { ...empty, query: "Mercado" }), false);
  assert.equal(shouldLoadOperationHistory("history", { ...empty, query: "Mercado" }), true);
  assert.equal(shouldLoadOperationHistory("history", { ...empty, flaggedOnly: true }), true);
});

test("category presentation keeps every non-zero slice and limits only the legend", () => {
  const input = [
    { label: "A", cents: 100, color: "#1" },
    { label: "B", cents: 500, color: "#2" },
    { label: "C", cents: 300, color: "#3" },
    { label: "D", cents: 200, color: "#4" },
    { label: "E", cents: 400, color: "#5" },
    { label: "Zero", cents: 0, color: "#6" },
  ];

  const result = buildCategoryPresentation(input);

  assert.deepEqual(result.slices.map((item) => item.label), ["B", "E", "C", "D", "A"]);
  assert.deepEqual(result.legend.map((item) => item.label), ["B", "E", "C", "D"]);
  assert.equal(result.totalCents, 1500);
  assert.equal(result.slices.some((item) => item.label === "Остальное"), false);
});

test("amount sorting is absolute and date sorting restores day order", () => {
  const rows = [
    { id: 1, date: "2026-07-12", amountCents: -200 },
    { id: 2, date: "2026-07-11", amountCents: 900 },
    { id: 3, date: "2026-07-12", amountCents: -100 },
  ];
  const read = (row: (typeof rows)[number]) => row;

  assert.deepEqual(sortOperationItems(rows, "amount-desc", read).map((row) => row.id), [2, 1, 3]);
  assert.deepEqual(sortOperationItems(rows, "amount-asc", read).map((row) => row.id), [3, 1, 2]);
  const byDate = sortOperationItems(rows, "date", read);
  assert.deepEqual(byDate.map((row) => row.id), [3, 1, 2]);
  assert.deepEqual(
    groupOperationItemsByDate(byDate, (row) => row.date).map((group) => ({
      date: group.date,
      ids: group.items.map((row) => row.id),
    })),
    [
      { date: "2026-07-12", ids: [3, 1] },
      { date: "2026-07-11", ids: [2] },
    ]
  );
});

test("history date mode groups descending operations by year", () => {
  const rows = [
    { id: 4, date: "2026-07-12" },
    { id: 3, date: "2026-01-02" },
    { id: 2, date: "2025-12-31" },
    { id: 1, date: "2024-03-08" },
  ];

  assert.deepEqual(
    groupOperationItemsByYear(rows, (row) => row.date).map((group) => ({
      year: group.year,
      ids: group.items.map((row) => row.id),
    })),
    [
      { year: "2026", ids: [4, 3] },
      { year: "2025", ids: [2] },
      { year: "2024", ids: [1] },
    ]
  );
});
