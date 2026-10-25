const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
const DATE_LIKE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

export function formatDate(value) {
  if (value === null || value === undefined || value === '') return '';

  const text = String(value).trim();
  if (!text) return '';

  const isoMatch = text.match(ISO_DATE_PREFIX);
  if (!isoMatch) return DATE_LIKE_PREFIX.test(text) ? '' : text;

  const [, year, month, day] = isoMatch;
  const dateOnly = `${year}-${month}-${day}`;
  const parsed = new Date(`${dateOnly}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateOnly) return '';

  if (text.length > 10) {
    const timestamp = new Date(text);
    if (Number.isNaN(timestamp.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(timestamp);
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(parsed);
}
