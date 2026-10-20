import mongoose from 'mongoose';

// Team membership. "Team" maps to a sprint in this codebase (same convention
// as TaskHistory.teamId), so `teamId` references the sprint and `memberId`
// references a user. The owner is implicitly part of their own team and is
// not stored here.
const teamMemberSchema = new mongoose.Schema(
  {
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Sprint',
      required: true,
      index: true
    },
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    addedBy: {
      // Authenticated actor that created the membership (owner/admin, or the
      // member themselves when they join).
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    joinedAt: {
      type: Date,
      required: true,
      default: Date.now
    }
  },
  { timestamps: true }
);

// A member can belong to a team at most once; the unique index also makes
// concurrent joins race-safe (the loser sees E11000, not a duplicate row).
teamMemberSchema.index({ teamId: 1, memberId: 1 }, { unique: true });

export const TeamMember = mongoose.model('TeamMember', teamMemberSchema);
