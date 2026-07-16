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
