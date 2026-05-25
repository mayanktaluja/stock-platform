export function filterPicksWithDeepDataFailOpen(sectionKey, items, getStockByTicker, counter) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const withDeep = [];
  for (const it of items) {
    const ticker = it?.ticker;
    if (!ticker) continue;
    if (getStockByTicker(ticker)) {
      withDeep.push(it);
      continue;
    }
    counter.count += 1;
    if (counter.sample.length < 12) counter.sample.push(String(ticker));
  }

  if (withDeep.length > 0) return withDeep;
  counter.failOpenSections.push(sectionKey);
  return items;
}
