import mongoose from 'mongoose';

// Team membership. `teamId` references a `Team` (the enduring workspace)
// and `userId` references a `User`. The team owner is implicitly part of
// their own team and is not stored here — only invited/joined members are.
//
// `role` distinguishes team administrators (can manage membership, rename the
// team) from ordinary members (can leave, view team tasks/sprints).
const teamMemberSchema = new mongoose.Schema(
  {
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    role: {
      type: String,
      enum: ['admin', 'member'],
      default: 'member',
      required: true
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

// A user can belong to a team at most once; the unique index also makes
// concurrent joins race-safe (the loser sees E11000, not a duplicate row).
teamMemberSchema.index({ teamId: 1, userId: 1 }, { unique: true });

export const TeamMember = mongoose.model('TeamMember', teamMemberSchema);
