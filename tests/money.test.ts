import assert from "node:assert/strict";
import test from "node:test";

import { formatMoney, formatMoneyParts } from "../lib/finance.ts";

// Normalize the various non-breaking spaces Intl may emit so assertions do
// not depend on the ICU version, while raw strings are still checked for the
// absence of BREAKABLE spaces separately.
const plain = (cents: number, currency: string) =>
  formatMoney(cents, currency).replace(/[  ]/g, " ");

test("formats EUR, USD and RUB in the ru-RU layout", () => {
  assert.equal(plain(545731, "EUR"), "5 457,31 €");
  assert.equal(plain(123456, "USD"), "1 234,56 $");
  assert.equal(plain(999900, "RUB"), "9 999,00 ₽");
});

test("four- and six-digit amounts keep digit grouping and the trailing currency", () => {
  assert.equal(plain(123456, "EUR"), "1 234,56 €");
  assert.equal(plain(12345678, "EUR"), "123 456,78 €");
});

test("money strings never contain breakable spaces", () => {
  for (const [cents, currency] of [
    [545731, "EUR"],
    [123456, "USD"],
    [999900, "RUB"],
    [12345678, "USDT"],
  ] as const) {
    assert.doesNotMatch(formatMoney(cents, currency), / /u);
  }
});

test("non-ISO tickers fall back to the code-suffixed layout", () => {
  const parts = formatMoneyParts(123456, "USDT");
  const currency = parts.find((part) => part.type === "currency");
  assert.equal(currency?.value, "USDT");
  assert.equal(plain(123456, "USDT"), "1 234,56 USDT");
});
