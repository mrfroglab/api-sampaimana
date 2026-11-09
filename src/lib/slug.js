const slugify = (text) =>
  String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

/** Returns a slug unique in the given prisma model (expects a `slug` unique column). */
const uniqueSlug = async (delegate, text, excludeId) => {
  const base = slugify(text) || 'kasus';
  let candidate = base;
  for (let i = 2; i < 1000; i += 1) {
    const existing = await delegate.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing || existing.id === excludeId) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v));

module.exports = { slugify, uniqueSlug, isUuid };
