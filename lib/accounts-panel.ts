export type AccountPanelItem = {
  id: number;
  balanceCents: number;
};

export function selectAccountPanelItems<T extends AccountPanelItem>(
  accounts: T[],
  expanded: boolean,
  viewedOverflowIds: ReadonlySet<number>,
  limit = 9
) {
  if (expanded || accounts.length <= limit) {
    return {
      visible: accounts,
      hidden: [] as T[],
      promoted: null as T | null,
    };
  }

  const configuredVisible = accounts.slice(0, limit);
  const configuredHidden = accounts.slice(limit);
  const promotedNegative = configuredHidden.find(
    (account) => account.balanceCents < 0 && !viewedOverflowIds.has(account.id)
  );
  const visible = promotedNegative
    ? [...configuredVisible.slice(0, limit - 1), promotedNegative]
    : configuredVisible;
  const visibleIds = new Set(visible.map((account) => account.id));

  return {
    visible,
    hidden: accounts.filter((account) => !visibleIds.has(account.id)),
    promoted: promotedNegative ?? null,
  };
}
