// Mtime-keyed cache. Returns the cached value when the file's mtime hasn't
// changed since the last successful read. Re-reads on any change.
//
// Each consumer module used to keep its own copy of this pattern. The DAL
// centralises it so Phase 4 (Postgres backend) only has to change the
// reader function — caching behaviour stays identical.

import fs from "node:fs";

export function mtimeCached(filePath, loader) {
  let cache = null; // { mtimeMs, data }
  return function read() {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;
    let data;
    try {
      data = loader(filePath);
    } catch {
      return null;
    }
    if (data == null) return null;
    cache = { mtimeMs: stat.mtimeMs, data };
    return data;
  };
}

// Per-key variant for directory-backed lookups (deep/{TICKER}.json).
// One Map of (key → { mtimeMs, data }) shared across keys.
export function mtimeCachedByKey(filePathOf, loader) {
  const store = new Map();
  return function read(key) {
    const fp = filePathOf(key);
    if (!fp) return null;
    let stat;
    try {
      stat = fs.statSync(fp);
    } catch {
      return null;
    }
    const cached = store.get(key);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
    let data;
    try {
      data = loader(fp);
    } catch {
      return null;
    }
    if (data == null) return null;
    store.set(key, { mtimeMs: stat.mtimeMs, data });
    return data;
  };
}

export function clearAllCachesOf(...readers) {
  for (const r of readers) {
    if (typeof r?.__clear === "function") r.__clear();
  }
}
