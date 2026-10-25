# LeadAI

LeadAI is an AI-assisted Kanban and sprint-planning workspace. A team starts with a board, turns a project goal into a reviewed backlog, assigns work using member skills, and tracks the result through five delivery stages: **Backlog → To Do → In Progress → In Review / QA → Done**.

The product is a MERN application:

- **Frontend:** React + Vite, plain CSS, `lucide-react` icons.
- **Backend:** Node.js + Express.
- **Database:** MongoDB with Mongoose. An explicit in-memory mode exists only for offline development and tests.
- **AI:** OpenRouter chat completions, optional per-user keys, with a deterministic local planner when no key is configured.

## What is actually implemented

### Public landing page and account flow

- A responsive product overview (`frontend/src/LandingPage.jsx`) that uses real interface fragments and a local, interactive board preview. It makes no testimonial, customer, or benchmark claims.
- Sign-up collects **full name, username, email, password, and password confirmation**.
- Usernames are normalized to lowercase, validated (`3–30` characters, letters/numbers/hyphens), and unique across the database. The signup form checks availability as you type, but the server and its unique index remain the authority.
- Passwords must be `8–128` characters and include lowercase, uppercase, a number, and a special character. A live checklist mirrors the server policy, which is re-checked on every request.
- Sign-up is completed with a **6-digit email code**, not a verification link. Codes are hashed at rest, expire after 10 minutes, allow five attempts, are single-use, and cannot be reused after a resend. No session exists until the code is verified.
- Unverified accounts that try to sign in receive `403 EMAIL_NOT_VERIFIED` plus a fresh or reused signup challenge.
- Signing in from an unrecognized browser requires a separate email code. Trusted browsers skip that step. Password resets revoke every session and trusted browser.
- Reset requests return the same response for known and unknown email addresses, so they do not reveal which accounts exist.

### Workspace

- **Kanban board:** five columns, drag-and-drop or status-menu moves, task search and filters, board and list views.
- **Tasks:** title, description, priority (`P0–P3`), labels, assignee, due date, estimate, comments, attachments, dependencies, and per-task history.
- **Sprints and backlog:** dated sprints, deterministic backlog ordering by priority and age, and explicit sprint status transitions.
- **Dashboard:** live counts and attention lists computed from accessible boards, not a separate reporting dataset.
- **Boards and teams:** owners can create, rename, delete, invite existing accounts, and remove members. Membership is checked on every board and task request.
- **Profiles:** display name, unique username, bio, location, website, avatar, and skills. Skills feed the planner's assignment suggestions.
- **Settings:** database connection status, server AI key/model status, and an optional personal OpenRouter key. Personal keys are stored per user and are never returned by the API.
- **Copilot:** board-aware chat that can propose task creation, updates, and batch operations. The server validates every proposed action before applying it. Destructive actions such as deletion are refused.

### Deliberate limitations

- **Automations are not built.** The Automations route says so instead of showing a mock editor.
- **No silent AI fallback.** The local rule-based planner runs only when no API key is configured. If a key is configured and the provider fails, the API returns `502 AI_UNAVAILABLE` rather than pretending an AI answer succeeded.
- **Email is used only for authentication.** The previous notification email queue (dummy Ethereal transport, empty recipient) has been removed. The header bell reports overdue tasks from the loaded board; there is no separate notification inbox.
- **No pricing, billing, or customer logos** are displayed anywhere.

## Quick start

Requirements: Node.js 20+ and a reachable MongoDB database (Atlas or local).

```bash
npm run install:all          # install root, backend, and frontend dependencies
cp backend/.env.example backend/.env
# edit backend/.env: set MONGODB_URI and, optionally, email and AI credentials
npm --prefix backend run db:setup
npm run dev                  # backend :4000 + frontend :5173
```

Open `http://localhost:5173`.

To run each half separately:

```bash
cd backend && npm run dev
cd frontend && npm run dev
```

The API refuses to start when `MONGODB_URI` is missing or unreachable. To run completely offline against throwaway in-memory storage, set `ALLOW_MEMORY_DB=1`; all data then disappears when the process exits.

## Environment variables

Copy `backend/.env.example` to `backend/.env`. Never commit the real file.

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string. Required unless `ALLOW_MEMORY_DB=1`. |
| `PORT` | API port (default `4000`). |
| `NODE_ENV` | `development`, `test`, or `production`. |
| `ALLOW_MEMORY_DB` | Set to `1` only for offline development or tests. |
| `EMAIL_FROM` | Sender address, e.g. `LeadAI <no-reply@example.com>`. Required for Resend and SMTP. |
| `RESEND_API_KEY` | Resend HTTP API key. Preferred email provider; no extra dependency. |
| `EMAIL_PROVIDER` | Optional explicit choice: `resend`, `smtp`, or `console`. Invalid values fail fast. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | SMTP fallback. `SMTP_FROM` is used when `EMAIL_FROM` is unset. |
| `OPENROUTER_API_KEY` | Server-wide OpenRouter key for Copilot and generated boards. |
| `OPENROUTER_MODEL` | OpenRouter model ID (default `openrouter/free`). |

### Email delivery

`backend/server/lib/email.js` is the single delivery seam:

1. In development, the console transport is the default: the full message, including the 6-digit code, is printed in the **API terminal** under `[email:development]`. No mailbox or SMTP account is required.
2. Set `EMAIL_PROVIDER=resend` (plus `RESEND_API_KEY` and `EMAIL_FROM`) to test Resend in development. It uses the HTTPS API with a 15-second timeout.
3. Set `EMAIL_PROVIDER=smtp` (plus `SMTP_HOST` and `EMAIL_FROM`) to test SMTP in development. It uses Nodemailer.
4. In production, configure Resend or SMTP. Missing configuration throws instead of writing a code to the log.

Signup, sign-in, and password-reset all use the same 10-minute code. For local testing, start the API, trigger the action, and copy the code from the terminal output.

**SMTP removal status:** Resend support is implemented, but Resend is not the only live mechanism yet. Removing SMTP completely would require a real `RESEND_API_KEY` and verified `EMAIL_FROM` sender in the deployment environment; neither was available in this repository. Until those credentials exist, SMTP remains a documented fallback and email delivery continues to work.

## AI behaviour

- With no key, `chatWithContext` uses the deterministic local planner (`backend/server/ai.js`). This keeps the board usable offline and in tests.
- With a key, the server calls OpenRouter with a 30-second timeout, one retry, JSON response format, and strict server-side validation of the returned action.
- Provider failures, timeouts, and malformed responses surface as `502 AI_UNAVAILABLE`. Only the status or error name is logged, never prompts, request bodies, or keys.
- A personal key is used only when the server has none. It is stored on the user record with `select: false` and is never serialized to the client.

## Database and scripts

```bash
npm run install:all                  # install everything
npm run dev                          # backend + frontend
npm run build                        # production frontend build
npm test                             # full backend test suite
npm run test:db                      # MongoDB-backed profile/index test (needs local MongoDB)

npm --prefix backend run db:check    # connection, document counts, required indexes, username audit
npm --prefix backend run db:setup    # create missing indexes, then run the audit (never edits documents)
npm --prefix backend run db:seed -- --email=you@example.com   # optional, idempotent sample sprint/tasks
```

`db:check` and `db:setup` report duplicate or malformed usernames without changing data. The unique sparse index on `users.username` is what prevents conflicts at write time.

Database rules for the team:

- Schema and indexes live in `backend/server/models/` and are applied with `createIndexes` through `db:setup`; nothing is dropped.
- `db:seed` upserts by stable key and never overwrites edits.
- Live development data lives only in the shared database. A `git pull` does not move data.
- There is no versioned migration runner. A data backfill belongs in an idempotent script under `backend/scripts/`.
- `.env` files, uploads, database dumps, and test databases stay out of Git.

## Tests

The backend suite runs each file in its own process against an in-memory server or pure helpers. It covers:

- auth password/username policy and uniqueness
- one-time code lifecycle, resend cooldown, attempt limits, expiry, and purpose isolation
- the full signup → email code → session flow, duplicate email/username, unverified sign-in, login codes, and password reset
- email provider selection, console/dev behaviour, production refusal, Resend request shape, and safe 502 handling
- AI local fallback, injected-provider success, provider failure, malformed output, and secret-safe logging
- boards, tasks, sprints, backlog ordering, dashboard counts, history, domain events, attachments, profiles, and per-user AI keys

`npm run test:db` is separate because it needs a local MongoDB server and creates a disposable `leadai_test_*` database.

## Project structure

```text
backend/
  server/
    index.js              Express app and HTTP routes
    auth.js               password/username policy, sessions, users
    ai.js                 Copilot prompts, local planner, OpenRouter calls
    models/               Mongoose models (User, Board, Task, Sprint, EmailCode, ...)
    lib/
      authCodes.js        hashed one-time email codes
      email.js            Resend / SMTP / console delivery
      ...                 board, sprint, dashboard, history, profile services
  scripts/db.js           idempotent setup, check, username audit, seed
frontend/
  src/
    LandingPage.jsx       public product overview
    AuthScreen.jsx        sign-in, sign-up, code, and reset flows
    App.jsx               workspace shell and routing
    ...                   board, dashboard, backlog, profile, settings
```

Attachments are stored under `backend/uploads/` and are not served as public static files.

## Design reference

The original design file is available at
<https://www.figma.com/design/b1TtQjgqK0SzCqi0mn2wAf/LeadAI?node-id=1-3&t=8JU2KGrmYrX10Kmm-1>.
The running interface is the source of truth for implemented behaviour.
