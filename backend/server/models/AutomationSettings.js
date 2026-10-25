import mongoose from 'mongoose';

export const DEFAULT_AUTOMATION_RULES = Object.freeze({
  taskAssignmentNotification: true,
  taskReviewAlert: true,
  smartMemberReassignment: false,
  autoCompleteSubtasks: false,
  overduePriorityEscalation: true,
  sprintKickoffBroadcast: true
});

const automationSettingsSchema = new mongoose.Schema({
  boardId: { type: String, required: true, unique: true, index: true },
  rules: {
    taskAssignmentNotification: { type: Boolean, default: true },
    taskReviewAlert: { type: Boolean, default: true },
    smartMemberReassignment: { type: Boolean, default: false },
    autoCompleteSubtasks: { type: Boolean, default: false },
    overduePriorityEscalation: { type: Boolean, default: true },
    sprintKickoffBroadcast: { type: Boolean, default: true }
  }
}, { timestamps: true });

export const AutomationSettings = mongoose.model('AutomationSettings', automationSettingsSchema);
