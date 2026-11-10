/**
 * Round 6b: project cards keep the order the page first saw them in, so a card never moves under
 * the cursor when the server re-sorts by "last changed" (opening a project makes it the newest).
 * Cards the page has not seen yet (a new project, a copy) go first; the order lasts while the page
 * is open.
 */
const seen: string[] = [];

export function stableOrder<T extends { id: string }>(cards: readonly T[], memory: string[] = seen): T[] {
  const known = new Map(memory.map((id, i) => [id, i]));
  const fresh = cards.filter((c) => !known.has(c.id));
  const old = cards.filter((c) => known.has(c.id)).sort((a, b) => known.get(a.id)! - known.get(b.id)!);
  if (fresh.length) memory.unshift(...fresh.map((c) => c.id));
  return [...fresh, ...old];
}
