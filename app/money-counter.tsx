"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  accountTypes,
  centsToInputValue,
  formatDateShort,
  formatMoney,
  normalizeCurrency,
  resolveSignedAmountCents,
} from "../lib/finance";

type Account = {
  id: number;
  name: string;
  bankName: string;
  currency: string;
  type: string;
  openingBalanceCents: number;
  color: string;
  balanceCents: number;
  transactionCount: number;
};

type Transaction = {
  id: number;
  accountId: number;
  accountName: string;
  accountCurrency: string;
  date: string;
  description: string;
  category: string;
  payee: string;
  amountCents: number;
  status: string;
  notes: string;
};

type AccountForm = {
  name: string;
  bankName: string;
  currency: string;
  type: string;
  openingBalance: string;
  color: string;
};

type TransactionForm = {
  accountId: string;
  date: string;
  direction: "expense" | "income";
  amount: string;
  description: string;
  category: string;
  payee: string;
  notes: string;
};

type ImportRow = {
  accountName: string;
  currency: string;
  date: string;
  amount: string;
  direction: string;
  description: string;
  category: string;
  payee: string;
  notes: string;
};

const accountPalette = [
  "#2563eb",
  "#0f766e",
  "#b45309",
  "#be123c",
  "#6d28d9",
  "#0369a1",
  "#4d7c0f",
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error ?? "Запрос не выполнен");
  }

  return data as T;
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace("ё", "е");
}

function parseDelimited(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [";", ",", "\t"].sort(
    (a, b) => firstLine.split(b).length - firstLine.split(a).length
  )[0];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && next === '"' && inQuotes) {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell.trim());
      if (row.some(Boolean)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some(Boolean)) {
    rows.push(row);
  }

  return rows;
}

function readColumn(
  record: string[],
  headers: string[],
  names: string[],
  fallback = ""
) {
  const index = headers.findIndex((header) => names.includes(header));
  return index >= 0 ? record[index] ?? fallback : fallback;
}

function parseCsvImport(text: string): ImportRow[] {
  const [headerRow, ...records] = parseDelimited(text);
  if (!headerRow) {
    return [];
  }

  const headers = headerRow.map(normalizeHeader);

  return records
    .map((record) => {
      const direction = readColumn(record, headers, [
        "type",
        "тип",
        "direction",
        "направление",
      ]);

      return {
        accountName: readColumn(record, headers, [
          "account",
          "account name",
          "счет",
          "счёт",
          "банк",
        ]),
        currency: normalizeCurrency(
          readColumn(record, headers, ["currency", "валюта"], "EUR")
        ),
        date: readColumn(record, headers, ["date", "дата"]),
        amount: readColumn(record, headers, ["amount", "сумма", "sum"]),
        direction,
        description: readColumn(record, headers, [
          "description",
          "описание",
          "comment",
          "комментарий",
        ]),
        category: readColumn(record, headers, ["category", "категория"]),
        payee: readColumn(record, headers, [
          "payee",
          "merchant",
          "контрагент",
          "получатель",
        ]),
        notes: readColumn(record, headers, ["notes", "заметки", "note"]),
      };
    })
    .filter((row) => row.accountName || row.date || row.amount);
}

function groupTotalsByCurrency(accounts: Account[]) {
  return accounts.reduce<Record<string, number>>((totals, account) => {
    totals[account.currency] = (totals[account.currency] ?? 0) + account.balanceCents;
    return totals;
  }, {});
}

function monthKey(date: string) {
  return date.slice(0, 7);
}

export default function MoneyCounter() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [editingTransactionId, setEditingTransactionId] = useState<number | null>(
    null
  );
  const [accountForm, setAccountForm] = useState<AccountForm>({
    name: "",
    bankName: "",
    currency: "EUR",
    type: "checking",
    openingBalance: "",
    color: accountPalette[0],
  });
  const [transactionForm, setTransactionForm] = useState<TransactionForm>({
    accountId: "",
    date: today(),
    direction: "expense",
    amount: "",
    description: "",
    category: "",
    payee: "",
    notes: "",
  });
  const [importRows, setImportRows] = useState<ImportRow[]>([]);

  const selectedAccount =
    selectedAccountId === "all"
      ? null
      : accounts.find((account) => String(account.id) === selectedAccountId) ??
        null;
  const activeCurrency = selectedAccount?.currency ?? accounts[0]?.currency ?? "EUR";

  const loadAccounts = useCallback(async () => {
    const data = await requestJson<{ accounts: Account[] }>("/api/accounts");
    setAccounts(data.accounts);
    setTransactionForm((current) => ({
      ...current,
      accountId:
        current.accountId || (data.accounts[0] ? String(data.accounts[0].id) : ""),
    }));
  }, []);

  const loadTransactions = useCallback(async () => {
    const params = new URLSearchParams();
    if (selectedAccountId !== "all") {
      params.set("accountId", selectedAccountId);
    }
    if (query.trim()) {
      params.set("q", query.trim());
    }
    if (typeFilter !== "all") {
      params.set("type", typeFilter);
    }
    params.set("limit", "300");

    const data = await requestJson<{ transactions: Transaction[] }>(
      `/api/transactions?${params.toString()}`
    );
    setTransactions(data.transactions);
  }, [query, selectedAccountId, typeFilter]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadAccounts(), loadTransactions()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  }, [loadAccounts, loadTransactions]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [refresh]);

  const totalsByCurrency = useMemo(() => groupTotalsByCurrency(accounts), [accounts]);
  const totalOperations = useMemo(
    () => accounts.reduce((sum, account) => sum + account.transactionCount, 0),
    [accounts]
  );
  const currentMonth = monthKey(today());
  const monthIncome = useMemo(
    () =>
      transactions
        .filter(
          (transaction) =>
            monthKey(transaction.date) === currentMonth && transaction.amountCents > 0
        )
        .reduce((sum, transaction) => sum + transaction.amountCents, 0),
    [currentMonth, transactions]
  );
  const monthExpense = useMemo(
    () =>
      transactions
        .filter(
          (transaction) =>
            monthKey(transaction.date) === currentMonth && transaction.amountCents < 0
        )
        .reduce((sum, transaction) => sum + transaction.amountCents, 0),
    [currentMonth, transactions]
  );
  const cashflowBars = useMemo(() => {
    const buckets = new Map<string, { income: number; expense: number }>();
    for (const transaction of transactions) {
      const key = monthKey(transaction.date);
      const bucket = buckets.get(key) ?? { income: 0, expense: 0 };
      if (transaction.amountCents > 0) {
        bucket.income += transaction.amountCents;
      } else {
        bucket.expense += Math.abs(transaction.amountCents);
      }
      buckets.set(key, bucket);
    }

    return [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-6)
      .map(([key, value]) => ({
        key,
        label: key.slice(5),
        ...value,
      }));
  }, [transactions]);
  const largestFlow = Math.max(
    1,
    ...cashflowBars.flatMap((bar) => [bar.income, bar.expense])
  );
  const importTotal = useMemo(
    () =>
      importRows.reduce(
        (sum, row) => sum + (resolveSignedAmountCents(row.amount, row.direction) ?? 0),
        0
      ),
    [importRows]
  );

  async function handleCreateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await requestJson("/api/accounts", {
        method: "POST",
        body: JSON.stringify(accountForm),
      });
      setNotice("Счет добавлен");
      setAccountForm({
        name: "",
        bankName: "",
        currency: accountForm.currency,
        type: "checking",
        openingBalance: "",
        color: accountPalette[accounts.length % accountPalette.length],
      });
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Счет не добавлен");
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmitTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const method = editingTransactionId ? "PATCH" : "POST";
      const url = editingTransactionId
        ? `/api/transactions?id=${editingTransactionId}`
        : "/api/transactions";

      await requestJson(url, {
        method,
        body: JSON.stringify(transactionForm),
      });
      setNotice(editingTransactionId ? "Операция обновлена" : "Операция добавлена");
      setEditingTransactionId(null);
      setTransactionForm({
        accountId:
          transactionForm.accountId || (accounts[0] ? String(accounts[0].id) : ""),
        date: today(),
        direction: "expense",
        amount: "",
        description: "",
        category: "",
        payee: "",
        notes: "",
      });
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Операция не сохранена");
    } finally {
      setSaving(false);
    }
  }

  function startEditTransaction(transaction: Transaction) {
    setEditingTransactionId(transaction.id);
    setTransactionForm({
      accountId: String(transaction.accountId),
      date: transaction.date,
      direction: transaction.amountCents < 0 ? "expense" : "income",
      amount: centsToInputValue(Math.abs(transaction.amountCents)),
      description: transaction.description,
      category: transaction.category,
      payee: transaction.payee,
      notes: transaction.notes,
    });
  }

  async function removeTransaction(transaction: Transaction) {
    if (!window.confirm("Удалить операцию?")) {
      return;
    }

    try {
      await requestJson(`/api/transactions?id=${transaction.id}`, { method: "DELETE" });
      setNotice("Операция удалена");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Операция не удалена");
    }
  }

  async function archiveAccount(account: Account) {
    if (!window.confirm(`Архивировать счет ${account.name}?`)) {
      return;
    }

    try {
      await requestJson(`/api/accounts?id=${account.id}`, { method: "DELETE" });
      setNotice("Счет архивирован");
      setSelectedAccountId("all");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Счет не архивирован");
    }
  }

  async function handleCsvFile(file: File | null) {
    if (!file) {
      return;
    }

    const text = await file.text();
    const rows = parseCsvImport(text);
    setImportRows(rows);
    setNotice(rows.length ? `Готово к импорту: ${rows.length}` : "Строки не найдены");
  }

  async function handleImport() {
    if (importRows.length === 0) {
      return;
    }

    setSaving(true);
    try {
      const result = await requestJson<{
        createdAccounts: number;
        createdTransactions: number;
        rejected: Array<{ row: number; reason: string }>;
      }>("/api/import", {
        method: "POST",
        body: JSON.stringify({ rows: importRows }),
      });
      setNotice(
        `Импорт: ${result.createdTransactions}, счетов: ${result.createdAccounts}, ошибок: ${result.rejected.length}`
      );
      setImportRows([]);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Импорт не выполнен");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <p className="eyebrow">Money Counter</p>
          <h1>Счета и движение средств</h1>
        </div>
        <button className="iconButton" type="button" onClick={refresh} title="Обновить">
          ↻
        </button>
      </header>

      {notice ? <div className="notice">{notice}</div> : null}

      <section className="summaryGrid" aria-label="Сводка">
        <article className="metric">
          <span>Баланс</span>
          <strong>
            {Object.keys(totalsByCurrency).length === 0
              ? formatMoney(0, activeCurrency)
              : Object.entries(totalsByCurrency)
                  .map(([currency, amount]) => formatMoney(amount, currency))
                  .join(" · ")}
          </strong>
        </article>
        <article className="metric">
          <span>Поступления месяца</span>
          <strong>{formatMoney(monthIncome, activeCurrency)}</strong>
        </article>
        <article className="metric">
          <span>Расходы месяца</span>
          <strong>{formatMoney(Math.abs(monthExpense), activeCurrency)}</strong>
        </article>
        <article className="metric">
          <span>Операции</span>
          <strong>{totalOperations}</strong>
        </article>
      </section>

      <div className="workspace">
        <aside className="sidebar">
          <section className="surface">
            <div className="sectionHead">
              <h2>Счета</h2>
              <span>{accounts.length}</span>
            </div>
            <button
              className={`accountRow ${selectedAccountId === "all" ? "active" : ""}`}
              type="button"
              onClick={() => setSelectedAccountId("all")}
            >
              <span className="accountDot all" />
              <span>
                <b>Все счета</b>
                <small>{totalOperations} операций</small>
              </span>
            </button>
            <div className="accountList">
              {accounts.map((account) => (
                <button
                  className={`accountRow ${
                    selectedAccountId === String(account.id) ? "active" : ""
                  }`}
                  key={account.id}
                  type="button"
                  onClick={() => {
                    setSelectedAccountId(String(account.id));
                    setTransactionForm((current) => ({
                      ...current,
                      accountId: String(account.id),
                    }));
                  }}
                >
                  <span
                    className="accountDot"
                    style={{ background: account.color }}
                  />
                  <span>
                    <b>{account.name}</b>
                    <small>{formatMoney(account.balanceCents, account.currency)}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="surface">
            <div className="sectionHead">
              <h2>Новый счет</h2>
            </div>
            <form className="stackForm" onSubmit={handleCreateAccount}>
              <label>
                Название
                <input
                  required
                  value={accountForm.name}
                  onChange={(event) =>
                    setAccountForm({ ...accountForm, name: event.target.value })
                  }
                />
              </label>
              <label>
                Банк
                <input
                  value={accountForm.bankName}
                  onChange={(event) =>
                    setAccountForm({ ...accountForm, bankName: event.target.value })
                  }
                />
              </label>
              <div className="formGrid two">
                <label>
                  Валюта
                  <input
                    maxLength={3}
                    value={accountForm.currency}
                    onChange={(event) =>
                      setAccountForm({
                        ...accountForm,
                        currency: event.target.value.toUpperCase(),
                      })
                    }
                  />
                </label>
                <label>
                  Цвет
                  <input
                    className="colorInput"
                    type="color"
                    value={accountForm.color}
                    onChange={(event) =>
                      setAccountForm({ ...accountForm, color: event.target.value })
                    }
                  />
                </label>
              </div>
              <label>
                Тип
                <select
                  value={accountForm.type}
                  onChange={(event) =>
                    setAccountForm({ ...accountForm, type: event.target.value })
                  }
                >
                  {accountTypes.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Начальный баланс
                <input
                  inputMode="decimal"
                  value={accountForm.openingBalance}
                  onChange={(event) =>
                    setAccountForm({
                      ...accountForm,
                      openingBalance: event.target.value,
                    })
                  }
                />
              </label>
              <button className="primaryButton" disabled={saving} type="submit">
                <span>+</span> Добавить счет
              </button>
            </form>
          </section>
        </aside>

        <section className="mainColumn">
          <section className="surface flowSurface">
            <div className="sectionHead">
              <h2>Движение</h2>
              <span>{selectedAccount?.name ?? "Все счета"}</span>
            </div>
            <div className="flowBars" aria-label="Помесячное движение">
              {cashflowBars.length === 0 ? (
                <div className="emptyBars">Нет операций</div>
              ) : (
                cashflowBars.map((bar) => (
                  <div className="flowBar" key={bar.key}>
                    <div className="barPair">
                      <span
                        className="incomeBar"
                        style={{
                          height: `${Math.max(6, (bar.income / largestFlow) * 92)}%`,
                        }}
                      />
                      <span
                        className="expenseBar"
                        style={{
                          height: `${Math.max(6, (bar.expense / largestFlow) * 92)}%`,
                        }}
                      />
                    </div>
                    <small>{bar.label}</small>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="surface">
            <div className="sectionHead">
              <h2>{editingTransactionId ? "Правка операции" : "Новая операция"}</h2>
              {editingTransactionId ? (
                <button
                  className="textButton"
                  type="button"
                  onClick={() => {
                    setEditingTransactionId(null);
                    setTransactionForm({
                      accountId: accounts[0] ? String(accounts[0].id) : "",
                      date: today(),
                      direction: "expense",
                      amount: "",
                      description: "",
                      category: "",
                      payee: "",
                      notes: "",
                    });
                  }}
                >
                  Сброс
                </button>
              ) : null}
            </div>
            <form className="transactionForm" onSubmit={handleSubmitTransaction}>
              <label>
                Счет
                <select
                  required
                  disabled={accounts.length === 0}
                  value={transactionForm.accountId}
                  onChange={(event) =>
                    setTransactionForm({
                      ...transactionForm,
                      accountId: event.target.value,
                    })
                  }
                >
                  <option value="">Выберите счет</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Дата
                <input
                  required
                  type="date"
                  value={transactionForm.date}
                  onChange={(event) =>
                    setTransactionForm({ ...transactionForm, date: event.target.value })
                  }
                />
              </label>
              <label>
                Тип
                <select
                  value={transactionForm.direction}
                  onChange={(event) =>
                    setTransactionForm({
                      ...transactionForm,
                      direction: event.target.value as TransactionForm["direction"],
                    })
                  }
                >
                  <option value="expense">Расход</option>
                  <option value="income">Поступление</option>
                </select>
              </label>
              <label>
                Сумма
                <input
                  required
                  inputMode="decimal"
                  value={transactionForm.amount}
                  onChange={(event) =>
                    setTransactionForm({
                      ...transactionForm,
                      amount: event.target.value,
                    })
                  }
                />
              </label>
              <label className="wideField">
                Описание
                <input
                  value={transactionForm.description}
                  onChange={(event) =>
                    setTransactionForm({
                      ...transactionForm,
                      description: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Категория
                <input
                  value={transactionForm.category}
                  onChange={(event) =>
                    setTransactionForm({
                      ...transactionForm,
                      category: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Контрагент
                <input
                  value={transactionForm.payee}
                  onChange={(event) =>
                    setTransactionForm({ ...transactionForm, payee: event.target.value })
                  }
                />
              </label>
              <label className="wideField">
                Заметка
                <input
                  value={transactionForm.notes}
                  onChange={(event) =>
                    setTransactionForm({ ...transactionForm, notes: event.target.value })
                  }
                />
              </label>
              <button
                className="primaryButton"
                disabled={saving || accounts.length === 0}
                type="submit"
              >
                <span>{editingTransactionId ? "✓" : "+"}</span>
                {editingTransactionId ? "Сохранить" : "Добавить"}
              </button>
            </form>
          </section>

          <section className="surface">
            <div className="sectionHead">
              <h2>Операции</h2>
              <span>{loading ? "Загрузка" : transactions.length}</span>
            </div>
            <div className="filters">
              <input
                aria-label="Поиск"
                placeholder="Поиск"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                aria-label="Тип операций"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
              >
                <option value="all">Все</option>
                <option value="expense">Расходы</option>
                <option value="income">Поступления</option>
              </select>
            </div>

            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Счет</th>
                    <th>Описание</th>
                    <th>Категория</th>
                    <th className="amountCell">Сумма</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {transactions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="emptyTable">
                        Нет операций
                      </td>
                    </tr>
                  ) : (
                    transactions.map((transaction) => (
                      <tr key={transaction.id}>
                        <td>{formatDateShort(transaction.date)}</td>
                        <td>{transaction.accountName}</td>
                        <td>
                          <b>{transaction.description}</b>
                          {transaction.payee ? <small>{transaction.payee}</small> : null}
                        </td>
                        <td>{transaction.category || "—"}</td>
                        <td
                          className={`amountCell ${
                            transaction.amountCents < 0 ? "negative" : "positive"
                          }`}
                        >
                          {formatMoney(
                            transaction.amountCents,
                            transaction.accountCurrency
                          )}
                        </td>
                        <td className="rowActions">
                          <button
                            className="iconButton small"
                            type="button"
                            onClick={() => startEditTransaction(transaction)}
                            title="Править"
                          >
                            ✎
                          </button>
                          <button
                            className="iconButton small danger"
                            type="button"
                            onClick={() => removeTransaction(transaction)}
                            title="Удалить"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </section>

        <aside className="rightRail">
          <section className="surface">
            <div className="sectionHead">
              <h2>Импорт CSV</h2>
              <span>{importRows.length}</span>
            </div>
            <label className="fileDrop">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => void handleCsvFile(event.target.files?.[0] ?? null)}
              />
              <span>Выбрать файл</span>
            </label>
            <div className="importStats">
              <span>Строк</span>
              <b>{importRows.length}</b>
              <span>Сумма</span>
              <b>{formatMoney(importTotal, activeCurrency)}</b>
            </div>
            <button
              className="primaryButton"
              type="button"
              disabled={saving || importRows.length === 0}
              onClick={handleImport}
            >
              <span>↓</span> Импортировать
            </button>
          </section>

          <section className="surface accountDetails">
            <div className="sectionHead">
              <h2>Детали счета</h2>
            </div>
            {selectedAccount ? (
              <>
                <div className="detailHero">
                  <span
                    className="accountDot large"
                    style={{ background: selectedAccount.color }}
                  />
                  <div>
                    <b>{selectedAccount.name}</b>
                    <span>
                      {formatMoney(
                        selectedAccount.balanceCents,
                        selectedAccount.currency
                      )}
                    </span>
                  </div>
                </div>
                <dl>
                  <dt>Банк</dt>
                  <dd>{selectedAccount.bankName || "—"}</dd>
                  <dt>Операции</dt>
                  <dd>{selectedAccount.transactionCount}</dd>
                  <dt>Начальный баланс</dt>
                  <dd>
                    {formatMoney(
                      selectedAccount.openingBalanceCents,
                      selectedAccount.currency
                    )}
                  </dd>
                </dl>
                <button
                  className="secondaryButton danger"
                  type="button"
                  onClick={() => archiveAccount(selectedAccount)}
                >
                  <span>×</span> Архивировать
                </button>
              </>
            ) : (
              <div className="mutedBlock">Выберите счет</div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
