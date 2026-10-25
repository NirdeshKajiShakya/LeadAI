const MAX_SPRINT_TASKS = 20;

export function fallbackSprintPlan(backlog) {
  const selectedTaskKeys = [...new Set((Array.isArray(backlog) ? backlog : [])
    .filter((task) => task?.status === 'backlog' && !task.sprintId && task.key)
    .map((task) => String(task.key)))].slice(0, MAX_SPRINT_TASKS);

  return { selectedTaskKeys, tasks: [] };
}

export function fallbackSprintName(goal, boardName = '') {
  const match = String(goal || '').match(/\b(?:new\s+)?sprint\s+(\d+)\b/i);
  return match ? `Sprint ${match[1]}` : `${String(boardName || '').trim()} Sprint`.trim();
}
