// Migration script: backfills `teamId` onto existing tasks and sprints,
// and creates a default team per user if none exists.
// Idempotent: safe to run repeatedly.
// Usage: MONGODB_URI=mongodb://... node server/lib/migrateToTeams.js
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

import { mongoose } from 'mongoose';
import { User } from '../models/User.js';
import { Team } from '../models/Team.js';
import { TeamMember } from '../models/TeamMember.js';
import { Task } from '../models/Task.js';
import { Sprint } from '../models/Sprint.js';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required.');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB');

  const users = await User.find().lean();
  console.log(`Found ${users.length} users`);

  for (const user of users) {
    // Create a default personal team if the user has no teams.
    const existingTeams = await Team.find({ ownerId: user._id }).lean();
    if (existingTeams.length === 0) {
      const team = await Team.create({
        name: `${user.name || user.email}'s Workspace`,
        ownerId: user._id
      });
      console.log(`Created default team for ${user.email}`);
    }

    // Backfill teamId on tasks owned by the user that have no teamId.
    const tasksWithoutTeam = await Task.find({ ownerId: String(user._id), teamId: null }).lean();
    for (const task of tasksWithoutTeam) {
      const team = await Team.findOne({ ownerId: user._id }).lean();
      if (team) {
        await Task.updateOne({ _id: task._id }, { $set: { teamId: team._id } });
        console.log(`Backfilled task ${task.key} -> team ${team.name}`);
      }
    }

    // Backfill teamId on sprints owned by the user that have no teamId.
    const sprintsWithoutTeam = await Sprint.find({ ownerId: String(user._id), teamId: null }).lean();
    for (const sprint of sprintsWithoutTeam) {
      const team = await Team.findOne({ ownerId: user._id }).lean();
      if (team) {
        await Sprint.updateOne({ _id: sprint._id }, { $set: { teamId: team._id } });
        console.log(`Backfilled sprint ${sprint.name} -> team ${team.name}`);
      }
    }
  }

  // Migrate legacy TeamMember rows that reference sprints as teamId to teams.
  // Legacy rows have teamId pointing to a Sprint _id; we repoint to the sprint's team.
  const legacyMembers = await TeamMember.find().lean();
  for (const m of legacyMembers) {
    const sprint = await Sprint.findById(m.teamId).lean();
    if (sprint && sprint.teamId) {
      await TeamMember.updateOne(
        { _id: m._id },
        { $set: { teamId: sprint.teamId } }
      );
      console.log(`Migrated membership ${m.userId} from sprint to team ${sprint.teamId}`);
    }
  }

  await mongoose.disconnect();
  console.log('Migration complete.');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});