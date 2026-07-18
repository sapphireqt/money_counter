export type AccountLifetime = {
  openedAt?: string | null;
  closedAt?: string | null;
};

export type CategoryDatum = {
  label: string;
  cents: number;
  color: string;
};

export type Phase1OperationSort = "date" | "amount-desc" | "amount-asc";
export type OperationListScope = "period" | "history";

export type OperationListFilterState = {
  query: string;
  accountId: string;
  type: string;
  category: string;
  flaggedOnly: boolean;
};

export function hasOperationListFilters(filters: OperationListFilterState): boolean {
  return (
    Boolean(filters.query.trim()) ||
    filters.accountId !== "all" ||
    filters.type !== "all" ||
    Boolean(filters.category) ||
    filters.flaggedOnly
  );
}

export function shouldLoadOperationHistory(
  scope: OperationListScope,
  filters: OperationListFilterState
): boolean {
  return scope === "history" && hasOperationListFilters(filters);
}

export function accountIsActiveOn(account: AccountLifetime, dateIso: string): boolean {
  return (
    (!account.openedAt || account.openedAt <= dateIso) &&
    (!account.closedAt || account.closedAt >= dateIso)
  );
}

export function selectActiveAccountsOn<T extends AccountLifetime>(
  accounts: readonly T[],
  dateIso: string
): T[] {
  return accounts.filter((account) => accountIsActiveOn(account, dateIso));
}

export function buildCategoryPresentation<T extends CategoryDatum>(items: readonly T[]) {
  const slices = items
    .filter((item) => item.cents > 0)
    .slice()
    .sort((left, right) => right.cents - left.cents);

  return {
    slices,
    legend: slices.slice(0, 4),
    totalCents: slices.reduce((sum, item) => sum + item.cents, 0),
  };
}

export type TransferLegLike = {
  accountName: string;
  accountCurrency: string;
  amountCents: number;
};

export type TransferRowPresentation = {
  accountLabel: string;
  debitAmountCents: number;
  debitCurrency: string;
  creditAmountCents: number;
  creditCurrency: string;
  showDebitNative: boolean;
  showCredited: boolean;
};

// The explicit presentation contract of a collapsed transfer row: the account
// column shows the «source → destination» pair, and the amount column carries
// ONLY money — account names never enter the amount cell.
//
// Line visibility depends on CURRENCIES only, never on numeric amounts:
// - the main amount in the display currency always renders;
// - the native block renders only when the debit-account currency differs
//   from the display currency; its first line is the debited amount in the
//   debit currency;
// - the second line («→ credited amount») renders only inside a visible
//   native block and only when the legs' currencies differ;
// - when the debit currency equals the display currency the native block is
//   not rendered at all. No display currency behaves as debit-currency
//   display.
export function buildTransferRowPresentation(
  out: TransferLegLike,
  incoming: TransferLegLike,
  displayCurrency: string | null
): TransferRowPresentation {
  const display = displayCurrency || out.accountCurrency;
  const showDebitNative = out.accountCurrency !== display;
  return {
    accountLabel: `${out.accountName} → ${incoming.accountName}`,
    debitAmountCents: Math.abs(out.amountCents),
    debitCurrency: out.accountCurrency,
    creditAmountCents: Math.abs(incoming.amountCents),
    creditCurrency: incoming.accountCurrency,
    showDebitNative,
    showCredited:
      showDebitNative && out.accountCurrency !== incoming.accountCurrency,
  };
}

export function sortOperationItems<T>(
  items: readonly T[],
  mode: Phase1OperationSort,
  read: (item: T) => { amountCents: number; date: string; id: number }
): T[] {
  const amountDirection = mode === "amount-asc" ? 1 : -1;
  return items.slice().sort((left, right) => {
    const a = read(left);
    const b = read(right);
    if (mode !== "date") {
      const amountOrder = (Math.abs(a.amountCents) - Math.abs(b.amountCents)) * amountDirection;
      if (amountOrder !== 0) return amountOrder;
    }
    return b.date.localeCompare(a.date) || b.id - a.id;
  });
}

export function groupOperationItemsByDate<T>(
  items: readonly T[],
  getDate: (item: T) => string
): Array<{ date: string; items: T[] }> {
  const groups: Array<{ date: string; items: T[] }> = [];
  for (const item of items) {
    const date = getDate(item);
    const last = groups[groups.length - 1];
    if (last?.date === date) last.items.push(item);
    else groups.push({ date, items: [item] });
  }
  return groups;
}

export function groupOperationItemsByYear<T>(
  items: readonly T[],
  getDate: (item: T) => string
): Array<{ year: string; items: T[] }> {
  const groups: Array<{ year: string; items: T[] }> = [];
  for (const item of items) {
    const year = getDate(item).slice(0, 4);
    const last = groups[groups.length - 1];
    if (last?.year === year) last.items.push(item);
    else groups.push({ year, items: [item] });
  }
  return groups;
}
