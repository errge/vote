export function formatRemaining(deadline: number, now = Date.now() / 1000): string {
  const s = Math.round(deadline - now);
  if (s <= 0) return 'now';
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 2) return `in ${d} days`;
  if (h >= 1) return `in ${h} h ${m % 60} min`;
  if (m >= 1) return `in ${m} min`;
  return 'in less than a minute';
}
