// Seed script for team workspace data. Intended for development/demo use.
// Seeds teams, memberships, and team-scoped tasks/sprints for a few users.
// Safe to re-run (idempotent by email).
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

import { mongoose } from 'mongoose';
import { User } from '../models/User.js';
import { Team } from '../models/Team.js';
import { TeamMember } from '../models/TeamMember.js';
import { Task } from '../models/Task.js';
import { Sprint } from '../models/Sprint.js';
import { ALLOWED_STATUSES } from './taskMigration.js';
import { convertDueDate, todayIsoDate } from './taskMigration.js';

const USERS = [
  { email: 'alice@example.com', password: 'Password123!', name: 'Alice Chen', role: 'admin' },
  { email: 'bob@example.com', password: 'Password123!', name: 'Bob Rivera' },
  { email: 'carol@example.com', password: 'Password123!', name: 'Carol Nguyen' }
];

const TEAMS = [
  { name: 'LeadAI Platform' },
  { name: 'Growth Squad' },
  { name: 'Design Systems' }
];

const STATUSES = [...ALLOWED_STATUSES];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required to run the seed script.');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB');

  const createdUsers = [];
  for (const u of USERS) {
    let user = await User.findOne({ email: u.email });
    if (!user) {
      const bcrypt = await import('bcryptjs');
      const passwordHash = await bcrypt.hash(u.password, 12);
      user = await User.create({
        email: u.email,
        passwordHash,
        name: u.name,
        role: u.role
      });
      console.log(`Created user ${u.email}`);
    } else {
      console.log(`User ${u.email} already exists`);
    }
    createdUsers.push(user);
  }

  const alice = createdUsers[0];
  const bob = createdUsers[1];
  const carol = createdUsers[2];

  const createdTeams = [];
  for (const t of TEAMS) {
    let team = await Team.findOne({ name: t.name });
    if (!team) {
      team = await Team.create({ name: t.name, ownerId: alice._id });
      console.log(`Created team "${t.name}"`);
    } else {
      console.log(`Team "${t.name}" already exists`);
    }
    createdTeams.push(team);
  }

  const platformTeam = createdTeams[0];
  const growthTeam = createdTeams[1];

  await TeamMember.findOneAndUpdate(
    { teamId: platformTeam._id, userId: bob._id },
    { $setOnInsert: { teamId: platformTeam._id, userId: bob._id, role: 'member', addedBy: alice._id, joinedAt: new Date() } },
    { upsert: true, new: true }
  );
  await TeamMember.findOneAndUpdate(
    { teamId: platformTeam._id, userId: carol._id },
    { $setOnInsert: { teamId: platformTeam._id, userId: carol._id, role: 'member', addedBy: alice._id, joinedAt: new Date() } },
    { upsert: true, new: true }
  );
  await TeamMember.findOneAndUpdate(
    { teamId: growthTeam._id, userId: carol._id },
    { $setOnInsert: { teamId: growthTeam._id, userId: carol._id, role: 'member', addedBy: bob._id, joinedAt: new Date() } },
    { upsert: true, new: true }
  );
  console.log('Seeded team memberships');

  // Seed team-scoped sprints and tasks.
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 7);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = new Date(start);
  endDate.setUTCDate(endDate.getUTCDate() + 13);
  const endIso = endDate.toISOString().slice(0, 10);

  const platformSprint = await Sprint.create({
    teamId: platformTeam._id,
    ownerId: alice._id,
    name: 'Platform Q4 Sprint 1',
    goal: 'Ship team workspace foundations and task events.',
    startDate,
    endDate: endIso
  });
  console.log('Created Platform sprint');

  const growthSprint = await Sprint.create({
    teamId: growthTeam._id,
    ownerId: bob._id,
    name: 'Growth Q4 Sprint 1',
    goal: 'Activate new team members on shared boards.',
    startDate,
    endDate: endIso
  });
  console.log('Created Growth sprint');

  const platformTasks = [
    { title: 'Design team member directory', status: 'todo', priority: 'high', assignee: bob.name, assigneeId: String(bob._id), teamId: String(platformTeam._id), sprintId: String(platformSprint._id) },
    { title: 'Implement team-scoped task queries', status: 'progress', priority: 'urgent', assignee: alice.name, assigneeId: String(alice._id), teamId: String(platformTeam._id), sprintId: String(platformSprint._id) },
    { title: 'Add member.joined / member.left events', status: 'done', priority: 'medium', assignee: carol.name, assigneeId: String(carol._id), teamId: String(platformTeam._id), sprintId: String(platformSprint._id) }
  ];

  const growthTasks = [
    { title: 'Onboard Carol to Growth board', status: 'todo', priority: 'medium', assignee: carol.name, assigneeId: String(carol._id), teamId: String(growthTeam._id), sprintId: String(growthSprint._id) },
    { title: 'Review Growth sprint goals', status: 'review', priority: 'high', assignee: bob.name, assigneeId: String(bob._id), teamId: String(growthTeam._id), sprintId: String(growthSprint._id) }
  ];

  for (const t of [...platformTasks, ...growthTasks]) {
    const exists = await Task.findOne({ title: t.title });
    if (exists) continue;
    const { date } = convertDueDate('Today', todayIsoDate());
    await Task.create({
      key: `KAN-${crypto.randomInt(100, 1000)}`,
      ownerId: String(alice._id),
      title: t.title,
      description: 'Seeded team workspace task.',
      status: t.status,
      priority: t.priority,
      labels: ['Team'],
      assignee: t.assignee,
      assigneeId: t.assigneeId,
      dueDate: date,
      estimateHours: 4,
      sprintId: t.sprintId,
      teamId: t.teamId,
      storyPoints: 5,
      comments: [],
      attachments: [],
      dependencies: []
    });
  }
  console.log('Seeded team-scoped tasks');

  await mongoose.disconnect();
  console.log('Seed complete.');
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});