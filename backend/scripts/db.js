// Idempotent database tooling shared by the whole team:
//   npm run db:setup                      ensure indexes exist
//   npm run db:check                      verify connection, database name and indexes
//   npm run db:seed -- --email you@x.com  add repeatable sample sprint/tasks for one user
// No command drops collections or overwrites existing documents.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { User } from '../server/models/User.js';
import { Task } from '../server/models/Task.js';
import { Sprint } from '../server/models/Sprint.js';
import { connectDatabase, databaseStatus, disconnectDatabase } from '../server/db.js';
import { endDateForStart, todayIsoDate } from '../server/lib/sprintDates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '../.env') });

const args = process.argv.slice(2);
const command = args.find((value) => !value.startsWith('--'));
const flags = Object.fromEntries(args.filter((value) => value.startsWith('--')).map((value) => {
  const [key, raw = 'true'] = value.replace(/^--/, '').split('=');
  return [key, raw];
}));

const EXPECTED_INDEXES = [
  { collection: 'users', label: 'unique email', key: { email: 1 }, test: (index) => index.unique === true },
  { collection: 'users', label: 'unique sparse username', key: { username: 1 }, test: (index) => index.unique === true && index.sparse === true },
  { collection: 'tasks', label: 'unique task key', key: { key: 1 }, test: (index) => index.unique === true },
  { collection: 'tasks', label: 'owner board order', key: { ownerId: 1, createdAt: 1 }, test: () => true },
  { collection: 'tasks', label: 'sprint lookup', key: { sprintId: 1 }, test: () => true },
  { collection: 'sprints', label: 'owner sprint order', key: { ownerId: 1, createdAt: 1 }, test: () => true }
];

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function guardProduction() {
  if (process.env.NODE_ENV === 'production' && flags.yes !== 'true') {
    fail('NODE_ENV=production. Re-run with --yes only if you intend to touch a production database.');
  }
}

async function connectOrExit() {
  const status = await connectDatabase();
  console.log(`Database: ${status.name} (${status.host})`);
  return status;
}

async function setup() {
  await Promise.all([User.createIndexes(), Task.createIndexes(), Sprint.createIndexes()]);
  console.log('Indexes ensured. Existing data was not modified.\n');
  return checkIndexes();
}

async function checkIndexes() {
  const collections = { users: User.collection, tasks: Task.collection, sprints: Sprint.collection };
  const indexes = {};
  for (const [name, collection] of Object.entries(collections)) indexes[name] = await collection.indexes();

  let missing = 0;
  for (const expected of EXPECTED_INDEXES) {
    const found = indexes[expected.collection].find((index) => JSON.stringify(index.key) === JSON.stringify(expected.key) && expected.test(index));
    if (!found) {
      missing += 1;
      console.error(`  MISSING  ${expected.collection}.${expected.label} (${JSON.stringify(expected.key)})`);
    } else {
      console.log(`  ok       ${expected.collection}.${expected.label}`);
    }
  }
  if (missing) throw new Error(`${missing} required index(es) missing. Run "npm run db:setup".`);
}

async function check() {
  await mongoose.connection.db.admin().ping();
  const status = databaseStatus();
  console.log(`Connection OK · database "${status.name}" · host ${status.host}`);
  if (/prod/i.test(status.name) && process.env.NODE_ENV !== 'production') {
    console.log('Warning: this database name looks like production. Development data belongs in a *_dev database.');
  }
  for (const Model of [User, Task, Sprint]) {
    const count = await Model.countDocuments();
    console.log(`  ${Model.collection.collectionName}: ${count} document(s)`);
  }
  console.log('');
  await checkIndexes();
}

async function seed() {
  const email = String(flags.email || '').trim().toLowerCase();
  if (!email) fail('Usage: npm run db:seed -- --email=you@example.com');
  const user = await User.findOne({ email });
  if (!user) fail(`No account exists for ${email}. Sign up in the app first, then rerun the seed.`);

  const ownerId = String(user._id);
  const startDate = todayIsoDate();
  const sprint = await Sprint.findOneAndUpdate(
    { ownerId, name: 'Shared Development Baseline' },
    { $setOnInsert: { goal: 'Shared sample data so every developer sees the same starting point.', startDate, endDate: endDateForStart(startDate), createdAt: new Date() } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  // Keys derive from the account id so two developers can seed the same database safely.
  const prefix = ownerId.slice(-8).toUpperCase();
  const templates = [
    { title: 'Verify the shared database connection', status: 'done', priority: 'high', labels: ['Setup'], storyPoints: 2, description: 'Run db:check and confirm the API health endpoint reports the shared database.' },
    { title: 'Pull the latest schema and indexes', status: 'todo', priority: 'medium', labels: ['Setup'], storyPoints: 1, description: 'After pulling, run npm run db:setup so new indexes exist for everyone.' },
    { title: 'Invite the rest of the team', status: 'todo', priority: 'low', labels: ['Team'], storyPoints: 1, description: 'Share backend/.env.example values through your team password manager.' }
  ];

  let created = 0;
  let existing = 0;
  for (const [index, template] of templates.entries()) {
    const key = `KAN-${prefix}${index + 1}`;
    try {
      const result = await Task.updateOne(
        { key },
        { $setOnInsert: { key, ownerId, sprintId: sprint._id, comments: [], attachments: [], dependencies: [], dueDate: 'Unscheduled', assignee: user.name || 'Unassigned', ...template } },
        { upsert: true, timestamps: false }
      );
      if (result.upsertedCount) created += 1;
      else existing += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      existing += 1;
    }
  }
  console.log(`Seed complete: sprint "${sprint.name}" ensured, ${created} task(s) created, ${existing} already present.`);
  console.log('Existing documents were not overwritten.');
}

async function main() {
  guardProduction();
  if (!['setup', 'check', 'seed'].includes(command)) {
    fail('Usage: node scripts/db.js <setup|check|seed> [--email=you@example.com]');
  }
  await connectOrExit();
  if (command === 'setup') await setup();
  else if (command === 'check') await check();
  else await seed();
}

main()
  .then(() => disconnectDatabase())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(`\n${error.message}\n`);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
