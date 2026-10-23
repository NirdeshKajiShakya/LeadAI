// Notification subscribers for the domain event bus. Only registered in
// non-test mode; the shared emitter must start with zero listeners while the
// test suites run (they attach their own listeners to assert delivery).
import { onEvent, EVENTS } from './events.js';
import mongoose from 'mongoose';
import { notify } from './notificationService.js';

const shouldRegister = process.env.NODE_ENV !== 'test' && process.env.ALLOW_MEMORY_DB !== 'true';

// Helper: get team admins who should receive membership notifications
async function getTeamAdmins(teamId) {
  try {
    const TeamMember = mongoose.models.TeamMember;
    if (!TeamMember) return [];
    const members = await TeamMember.find({ teamId, role: 'admin' }).select('userId');
    return members.map((m) => String(m.userId));
  } catch (error) {
    console.error('[events] getTeamAdmins failed:', error?.message || error);
    return [];
  }
}

// TASK_ASSIGNED: notify the new assignee, but not when they assign it to themselves
if (shouldRegister) {
  onEvent(EVENTS.TASK_ASSIGNED, async (payload) => {
    try {
      console.log('[events] TASK_ASSIGNED event received:', payload);
      const { taskId, teamId, actorId, assigneeId } = payload;

      // Skip if assigneeId is null/empty (unassigned)
      if (!assigneeId) return;

      // Don't notify if the assignee is the actor (self-assignment)
      if (String(assigneeId) === String(actorId)) return;

      // Look up the assignee's email/preferences, notify only the assignee
      await notify({
        userId: String(assigneeId),
        type: 'task_assigned',
        title: 'Task assigned',
        body: `You have been assigned a new task`,
        link: `/task/${taskId}`,
        meta: { taskId, teamId, actorId }
      });
      console.log('[events] TASK_ASSIGNED notification sent to assignee', assigneeId);
    } catch (error) {
      console.error('[events] TASK_ASSIGNED subscriber failed:', error?.message || error);
    }
  });

  // TASK_STATUS_CHANGED: notify the assignee and creator, excluding the actor
  onEvent(EVENTS.TASK_STATUS_CHANGED, async (payload) => {
    try {
      const { taskId, teamId, actorId, from, to } = payload;

      // We need to find the task to get assigneeId and ownerId
      const Task = mongoose.models.Task;
      if (!Task) return;
      const task = await Task.findById(taskId).lean().catch(() => null);
      if (!task) return;

      const recipients = new Set();

      // Add assignee if they exist and are not the actor
      if (task.assigneeId && String(task.assigneeId) !== String(actorId)) {
        recipients.add(String(task.assigneeId));
      }

      // Add creator/owner if they exist and are not the actor
      if (task.ownerId && String(task.ownerId) !== String(actorId)) {
        recipients.add(String(task.ownerId));
      }

      for (const recipientId of recipients) {
        await notify({
          userId: recipientId,
          type: 'task_status_changed',
          title: 'Task status updated',
          body: `Task status changed from "${from}" to "${to}"`,
          link: `/task/${taskId}`,
          meta: { taskId, teamId, actorId, from, to }
        });
      }
    } catch (error) {
      console.error('[events] TASK_STATUS_CHANGED subscriber failed:', error?.message || error);
    }
  });

  // MEMBER_JOINED: notify team admins (exclude the joining member)
  onEvent(EVENTS.MEMBER_JOINED, async (payload) => {
    try {
      const { teamId, memberId, actorId } = payload;

      // Get team admins
      const admins = await getTeamAdmins(teamId).catch(() => []);

      // Exclude the joining member
      const adminIds = admins.filter((id) => String(id) !== String(memberId));

      for (const adminId of adminIds) {
        await notify({
          userId: adminId,
          type: 'member_joined',
          title: 'Team member joined',
          body: 'A new member has joined the team',
          link: `/team/${teamId}`,
          meta: { teamId, memberId, actorId }
        });
      }
    } catch (error) {
      console.error('[events] MEMBER_JOINED subscriber failed:', error?.message || error);
    }
  });

  // MEMBER_LEFT: notify team admins (exclude the leaving member)
  onEvent(EVENTS.MEMBER_LEFT, async (payload) => {
    try {
      const { teamId, memberId, actorId } = payload;

      // Get team admins
      const admins = await getTeamAdmins(teamId).catch(() => []);

      // Exclude the leaving member
      const adminIds = admins.filter((id) => String(id) !== String(memberId));

      for (const adminId of adminIds) {
        await notify({
          userId: adminId,
          type: 'member_left',
          title: 'Team member left',
          body: 'A team member has left the team',
          link: `/team/${teamId}`,
          meta: { teamId, memberId, actorId }
        });
      }
    } catch (error) {
      console.error('[events] MEMBER_LEFT subscriber failed:', error?.message || error);
    }
  });
}

export { getTeamAdmins };
