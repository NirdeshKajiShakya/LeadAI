// Board generation helpers.
//
// The AI planner itself lives in server/ai.js and is shared with Copilot. This
// module only validates the Home-page request, extracts the validated task plan,
// and creates the board + tasks as one recoverable operation.

export const AI_GOAL_MIN_LENGTH = 10;
export const AI_GOAL_MAX_LENGTH = 2000;
export const AI_BOARD_NAME_MAX_LENGTH = 120;
export const AI_BOARD_MAX_TASKS = 20;

export function normalizeBoardGenerationRequest(body) {
  const goal = typeof body?.goal === 'string' ? body.goal.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';

  if (goal.length < AI_GOAL_MIN_LENGTH) {
    return { error: `Describe the project in at least ${AI_GOAL_MIN_LENGTH} characters.` };
  }
  if (goal.length > AI_GOAL_MAX_LENGTH) {
    return { error: `Project goal must be ${AI_GOAL_MAX_LENGTH} characters or fewer.` };
  }
  if (name.length > AI_BOARD_NAME_MAX_LENGTH) {
    return { error: `Board name must be ${AI_BOARD_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { goal, name };
}

// Reuses the existing Copilot prompt contract: one create_many action containing
// implementation-sized backlog tasks. No second AI flow or secret is involved.
export function planningMessage(goal, name) {
  const label = name ? ` named "${name}"` : '';
  return `Create a focused, implementation-ready project backlog${label} for this goal: ${goal}. `
    + 'Put every task in the Backlog column, give it a concrete description, a risk-based priority, '
    + 'and an ISO date-only due date (YYYY-MM-DD). Do not assign the work to a sprint. '
    + 'Leave every task Unassigned; the owner will assign work on the board.';
}

export function tasksFromAiResult(result) {
  const action = result?.action;
  if (!action || (action.type !== 'create' && action.type !== 'create_many')) return [];
  const raw = action.type === 'create' ? [action] : action.tasks;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, AI_BOARD_MAX_TASKS);
}

// Derives a readable board name from the user's own words when no name is given.
export function boardNameFromGoal(goal) {
  const firstLine = String(goal || '').split(/[.!?\n]/)[0].replace(/\s+/g, ' ').trim();
  const words = firstLine.split(' ');
  let name = '';
  for (const word of words) {
    const candidate = name ? `${name} ${word}` : word;
    if (candidate.length > 70) break;
    name = candidate;
  }
  return (name || 'New AI board').slice(0, AI_BOARD_NAME_MAX_LENGTH);
}

// Board + tasks are created together. If a task fails validation or persistence,
// only the rows created by this call are removed, so a failed generation never
// leaves a half-populated board behind and never touches existing data.
export async function createBoardWithPlan({ boardData, tasks, createBoard, createTask, deleteBoardTasks, deleteBoard }) {
  const board = await createBoard(boardData);
  const id = String(board?._id ?? board?.id ?? '');
  try {
    const created = [];
    for (const task of tasks) {
      created.push(await createTask({ ...task, boardId: id }));
    }
    return { board, created };
  } catch (error) {
    try { await deleteBoardTasks(id); } catch { /* best effort rollback */ }
    try { await deleteBoard(id); } catch { /* best effort rollback */ }
    throw error;
  }
}
