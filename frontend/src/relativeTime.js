export function formatRelativeTime(timestamp, now = Date.now()) {
  const time = Number(timestamp);
  if (!Number.isFinite(time) || time <= 0) return 'No activity yet';

  const elapsed = Math.max(0, now - time);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
