export const FIBONACCI_STORY_POINTS = Object.freeze([0, 1, 2, 3, 5, 8, 13]);
const VALID_AI_STORY_POINTS = new Set(FIBONACCI_STORY_POINTS.filter((points) => points > 0));

export function isValidStoryPoints(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

export function estimateStoryPoints(task = {}) {
  const labels = Array.isArray(task.labels) ? task.labels.join(' ') : '';
  const text = `${task.title || ''} ${task.description || ''} ${labels}`.toLowerCase();
  if (/\b(architecture|migration|pipeline|distributed|multi-system|platform overhaul|data model redesign)\b/.test(text)) return 13;
  if (/\b(integration|authentication|authorization|database|refactor|workflow|complex|end-to-end)\b/.test(text)) return 5;
  if (/\b(feature|component|api|endpoint|validation|responsive|search|dashboard)\b/.test(text)) return 3;
  if (/\b(documentation|copy|typo|minor|simple|quick fix|small ui|color|label)\b/.test(text)) return 1;
  return 2;
}

export function aiStoryPoints(value, task) {
  return VALID_AI_STORY_POINTS.has(value) ? value : estimateStoryPoints(task);
}
