import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3100";
const accountIds = [];

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
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

async function expectStatus(path, init, status) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`);
  return data;
}

async function createAccount(suffix, currency, lifetime = {}) {
  const data = await request("/api/accounts", {
    method: "POST",
    body: JSON.stringify({
      name: `__phase1_smoke_${Date.now()}_${suffix}`,
      currency,
      type: "bank",
      openingBalance: "0",
      openedAt: lifetime.openedAt ?? "2026-01-01",
      closedAt: lifetime.closedAt ?? "",
    }),
  });
  accountIds.push(data.account.id);
  return data.account;
}

async function transfer(group) {
  return request(`/api/transfers?group=${encodeURIComponent(group)}`);
}

async function transactionsFor(accountId) {
  const data = await request(
    `/api/transactions?accountId=${accountId}&from=2026-01-01&to=2026-12-31&limit=500`
  );
  return data.transactions;
}

try {
  const eurFrom = await createAccount("eur_from", "EUR");
  const eurTo = await createAccount("eur_to", "EUR");
  const usdTo = await createAccount("usd_to", "USD");
  const future = await createAccount("future", "EUR", { openedAt: "2026-08-01" });

  const same = await request("/api/transfers", {
    method: "POST",
    body: JSON.stringify({
      create: {
        fromAccountId: eurFrom.id,
        toAccountId: eurTo.id,
        date: "2026-07-01",
        amount: "10,00",
        amountIn: "99,99",
        description: "Same currency",
        notes: "same note",
        flagged: true,
      },
    }),
  });
  let pair = (await transfer(same.group)).transactions;
  assert.deepEqual(pair.map((item) => item.amountCents), [-1000, 1000]);
  assert.deepEqual(pair.map((item) => item.notes), ["same note", "same note"]);
  assert.deepEqual(pair.map((item) => item.flagged), [true, true]);

  await request("/api/transfers", {
    method: "PATCH",
    body: JSON.stringify({
      group: same.group,
      date: "2026-07-02",
      fromAccountId: eurFrom.id,
      toAccountId: eurTo.id,
      amount: "12,50",
      amountIn: "999,00",
      description: "Debit side",
      descriptionIn: "Credit side",
      notes: "edited note",
      flagged: false,
    }),
  });
  pair = (await transfer(same.group)).transactions;
  assert.deepEqual(pair.map((item) => item.amountCents), [-1250, 1250]);
  assert.deepEqual(pair.map((item) => item.description), ["Debit side", "Credit side"]);
  assert.deepEqual(pair.map((item) => item.notes), ["edited note", "edited note"]);
  assert.deepEqual(pair.map((item) => item.flagged), [false, false]);

  await request(`/api/transfers?group=${encodeURIComponent(same.group)}`, {
    method: "DELETE",
  });
  await expectStatus(`/api/transfers?group=${encodeURIComponent(same.group)}`, {}, 404);

  const cross = await request("/api/transfers", {
    method: "POST",
    body: JSON.stringify({
      create: {
        fromAccountId: eurFrom.id,
        toAccountId: usdTo.id,
        date: "2026-07-03",
        amount: "20,00",
        amountIn: "23,45",
        description: "Cross currency",
      },
    }),
  });
  pair = (await transfer(cross.group)).transactions;
  assert.deepEqual(pair.map((item) => item.amountCents), [-2000, 2345]);
  await request("/api/transfers", {
    method: "PATCH",
    body: JSON.stringify({
      group: cross.group,
      amount: "21,00",
      amountIn: "24,56",
    }),
  });
  pair = (await transfer(cross.group)).transactions;
  assert.deepEqual(pair.map((item) => item.amountCents), [-2100, 2456]);
  await request(`/api/transfers?group=${encodeURIComponent(cross.group)}`, {
    method: "DELETE",
  });

  const inactiveError = await expectStatus(
    "/api/transfers",
    {
      method: "POST",
      body: JSON.stringify({
        create: {
          fromAccountId: eurFrom.id,
          toAccountId: future.id,
          date: "2026-07-01",
          amount: "1,00",
        },
      }),
    },
    400
  );
  assert.match(inactiveError.error, /дата перевода раньше/);

  const sameAccountError = await expectStatus(
    "/api/transfers",
    {
      method: "POST",
      body: JSON.stringify({
        create: {
          fromAccountId: eurFrom.id,
          toAccountId: eurFrom.id,
          date: "2026-07-01",
          amount: "1,00",
        },
      }),
    },
    400
  );
  assert.equal(sameAccountError.error, "Счета должны быть разными");

  const source = await request("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      accountId: eurFrom.id,
      date: "2026-07-04",
      amount: "30,00",
      direction: "expense",
      description: "Link source",
      category: "Test",
      notes: "source note",
      flagged: true,
    }),
  });
  const partner = await request("/api/transactions", {
    method: "POST",
    body: JSON.stringify({
      accountId: eurTo.id,
      date: "2026-07-04",
      amount: "30,00",
      direction: "income",
      description: "Link partner",
      category: "Test",
      notes: "partner note",
      flagged: false,
    }),
  });
  await request("/api/transfers", {
    method: "POST",
    body: JSON.stringify({ outId: source.transaction.id, inId: partner.transaction.id }),
  });
  const linkedRows = [
    ...(await transactionsFor(eurFrom.id)),
    ...(await transactionsFor(eurTo.id)),
  ].filter((item) => item.id === source.transaction.id || item.id === partner.transaction.id);
  assert.equal(linkedRows.length, 2);
  assert.ok(linkedRows[0].transferGroup);
  assert.equal(linkedRows[0].transferGroup, linkedRows[1].transferGroup);
  assert.deepEqual(new Set(linkedRows.map((item) => item.notes)), new Set(["source note", "partner note"]));
  assert.deepEqual(linkedRows.map((item) => item.category), ["", ""]);

  await request(`/api/transfers?group=${encodeURIComponent(linkedRows[0].transferGroup)}`, {
    method: "DELETE",
  });
  const unlinkedRows = [
    ...(await transactionsFor(eurFrom.id)),
    ...(await transactionsFor(eurTo.id)),
  ].filter((item) => item.id === source.transaction.id || item.id === partner.transaction.id);
  const debit = unlinkedRows.find((item) => item.amountCents < 0);
  const credit = unlinkedRows.find((item) => item.amountCents > 0);
  assert.equal(debit.transferGroup, null);
  assert.equal(credit.transferGroup, null);
  assert.equal(debit.notes, "source note\npartner note");
  assert.equal(debit.flagged, true);
  assert.equal(credit.notes, "");
  assert.equal(credit.flagged, false);

  console.log("phase1 transfer API smoke: PASS");
} finally {
  for (const accountId of accountIds) {
    try {
      const rows = await transactionsFor(accountId);
      for (const row of rows) {
        await request(`/api/transactions?id=${row.id}`, { method: "DELETE" });
      }
      await request(`/api/accounts?id=${accountId}`, { method: "DELETE" });
    } catch {
      // The test runs in an isolated temporary D1; cleanup is best-effort.
    }
  }
}
