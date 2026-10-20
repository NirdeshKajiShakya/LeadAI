import mongoose from 'mongoose';

// A Team is a shared workspace: a group of users who collaborate on tasks
// and sprints. A team is distinct from a sprint — a sprint is a time-boxed
// iteration that belongs to a team, while a team is the enduring membership
// boundary. The stable team id is the Mongo `_id`.
const teamSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    // The user who created the team and its initial administrator.
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    }
  },
  { timestamps: true }
);

// Look up every team a user belongs to (owner or member) via memberships.
// The owner is implicitly part of their own team and is not stored in
// TeamMember, so team membership queries combine ownerId + TeamMember lookups.
teamSchema.index({ ownerId: 1, createdAt: -1 });

export const Team = mongoose.model('Team', teamSchema);