# LeadAI
LeadAI is a project with the purpose of saving time and increasing efficency. This project aims to help teams plan better and more efficeiently. We use a KanBan board as the default, this board can be eddited manully or by the help of an AI agent. This Agent can convert your simple minimal instructions and convert it into a KanBan board with tasks while keeping the skill sets of the memebers of the team into consideration.

## Part 1: Problem

Managing skill sets and task boards is a time-consuming, friction-heavy challenge for professional and general teams alike. When a leader forms a new team, they must quickly account for critical variables like unfamiliar team members, varying skill sets, and shifting schedules. Manually collecting skills, mapping dependencies, and assigning work is an exhausting, labor-intensive process. Left unsolved, this leads to misallocated talent, severe project delays, burn-out from administrative overhead, and costly productivity losses from unaligned workflows.

## Part 2: Idea

Our AI platform eliminates this administrative friction by automatically generating optimized task boards based on pre-configured team skill profiles. By mapping task requirements directly to individual capabilities, the AI creates an ideal schedule in seconds rather than hours. Beyond setup, the system provides dynamic, real-time workload management: users can fine-tune assignments manually, or let the AI automatically redistribute tasks and notify affected team members whenever someone joins or leaves the group.

## What AI does with it:

The AI ingests unstructured project goals alongside team member profiles, using Natural Language Processing (NLP) to analyze and classify individual skill sets, experience levels, and availability. It then uses predictive modeling and constraint optimization to judge task complexity, estimate completion timelines, and decide the optimal distribution of workload across the team.

## What comes out as a result:

A fully optimized, ready-to-use task board with intelligently assigned roles and balanced workloads. When changes occur—such as team members joining or leaving—the AI dynamically predicts project bottlenecks, recalculates dependencies, and decides how to instantly reallocate tasks and issue automated notifications to keep the workflow seamless.

## Figma 
https://www.figma.com/design/b1TtQjgqK0SzCqi0mn2wAf/LeadAI?node-id=1-3&t=8JU2KGrmYrX10Kmm-1

## Run the app

The functional MERN implementation is split into `frontend/` and `backend/`. The `stitch_ai_kanban_task_manager/` directory now contains only the retained Stitch design components.

```bash
npm run install:all   # first time only (installs root + backend + frontend)
npm run dev           # runs backend (:4000) + frontend (:5173) together
```

Open `http://localhost:5173`. The API runs on port 4000. Copy `backend/.env.example` to `backend/.env` and set `MONGODB_URI` to the team's shared development database (see below). The API refuses to start with a missing or unreachable database; `ALLOW_MEMORY_DB=true` is the only (offline-only) way to run on throwaway in-memory data. See `instructions/` for API, environment, and navigation details.

To run the applications separately, use two terminals:

```bash
# Terminal 1: backend API
cd backend
npm run dev

# Terminal 2: frontend Vite server
cd frontend
npm run dev
```

The app requires an account. Authentication uses short-lived bearer sessions; sign-up always creates a member account. Task attachments are stored under `backend/uploads/` and are excluded from public static serving. Password reset requests intentionally return the same response for known and unknown email addresses; configure an email delivery adapter before using reset links in production.

## Shared development database

All five developers connect to one development MongoDB database. Git carries code, schema/index definitions and seed scripts; it never carries database files, dumps or credentials.

```text
Developer 1 ──┐
Developer 2 ──┤
Developer 3 ──┼──> Shared development MongoDB (Atlas, database `leadai_dev`)
Developer 4 ──┤
Developer 5 ──┘
```

One-time Atlas setup (requires Atlas account access, do this together):

1. Create a project and a free cluster, then a database named `leadai_dev`. Keep a separate `leadai_prod` database/cluster for production and never point development at it.
2. Create one database user per developer (Database Access → Add New Database User). Grant `readWrite` on `leadai_dev` only, not `Atlas admin`.
3. In Network Access, allow only the team's egress IPs. Only use `0.0.0.0/0` for a short-lived demo, and remove it afterwards.
4. Give each developer their own `mongodb+srv://.../leadai_dev?...` URI through a password manager. Do not post URIs in chat, issues or commits.
5. Each developer copies `backend/.env.example` to `backend/.env`, replaces `<your-name>`, `<password>` and `<cluster>`, then runs the commands below.

Commands after cloning and after every pull that changes schemas:

```bash
npm run install:all                 # first time only
npm --prefix backend run db:check   # confirms which database and indexes you are using
npm --prefix backend run db:setup   # creates missing indexes; never edits data
npm --prefix backend run db:seed -- --email=you@example.com   # optional, idempotent
npm run dev
```

What is shared and how:

- **Schema and indexes** live in `backend/server/models/` and are applied with `db:setup` (`createIndexes`, no drops).
- **Sample data** is added by `db:seed`, which upserts by stable key and never overwrites edits or duplicates rows.
- **Live development data** lives only in the shared database, so a `git pull` never changes it.
- **Migrations**: this app has no versioned migration runner; when a schema change needs a data backfill, add a script under `backend/scripts/` and document it in the pull request. Keep it idempotent.
- **Never** commit `.env` files, `mongodump` output, uploads or user records. `.gitignore` blocks them.
- **Tests** use `ALLOW_MEMORY_DB=1` (in-memory) and `npm --prefix backend run test:db`, which uses a disposable `leadai_test_*` database on the local MongoDB server.

If MongoDB is unreachable the API exits with a clear error instead of silently switching to in-memory storage. That fallback was the reason teammates saw different data and lost it on restart.