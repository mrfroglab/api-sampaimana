/** Tiny in-memory TTL cache for public aggregates (single API process per instance). */
const store = new Map();

const cached = async (key, ttlMs, load) => {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
};

const clearInsightsCache = () => store.clear();

module.exports = { cached, clearInsightsCache };
