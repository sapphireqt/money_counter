import assert from "node:assert/strict";
import test from "node:test";

import { selectAccountPanelItems } from "../lib/accounts-panel.ts";

const accounts = Array.from({ length: 11 }, (_, index) => ({
  id: index + 1,
  balanceCents: index === 10 ? -500 : 100,
}));

test("shows all active accounts when the configured list has at most nine", () => {
  const configured = accounts.slice(0, 9);
  const result = selectAccountPanelItems(configured, false, new Set());
  assert.deepEqual(result.visible.map((account) => account.id), configured.map((account) => account.id));
  assert.equal(result.hidden.length, 0);
});

test("an unseen negative overflow account replaces the ninth account", () => {
  const result = selectAccountPanelItems(accounts, false, new Set());
  assert.equal(result.visible.at(-1)?.id, 11);
  assert.equal(result.promoted?.id, 11);
  assert.deepEqual(result.hidden.map((account) => account.id), [9, 10]);
});

test("viewed overflow returns to configured order", () => {
  const result = selectAccountPanelItems(accounts, false, new Set([11]));
  assert.deepEqual(result.visible.map((account) => account.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(result.promoted, null);
});

test("expanded state shows every account in configured order", () => {
  const result = selectAccountPanelItems(accounts, true, new Set());
  assert.deepEqual(result.visible.map((account) => account.id), accounts.map((account) => account.id));
  assert.equal(result.hidden.length, 0);
});
