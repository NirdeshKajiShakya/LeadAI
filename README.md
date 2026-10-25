# LeadAI

LeadAI is an AI-assisted project planning and team workspace. It helps teams turn project goals into organized work, keep a shared Kanban board up to date, and match tasks to team members' skills. You can manage work manually or use the AI features to help plan and prioritize it.

## What you can do

- Organize work on boards with Backlog, To Do, In Progress, In Review / QA, and Done columns.
- Create and update tasks with priorities, due dates, labels, story points, checklists, attachments, and comments.
- Plan and track sprints on the selected board; each board has its own sprint list and backlog.
- Use AI Copilot to create a sprint from backlog work, update sprint details, plan boards, estimate story points, and assign work based on member skills.
- Receive notifications and configure task automation.
- Sign up and manage your own workspace with authenticated accounts.

## Technology

- **Frontend:** React, React DOM, and Vite; the browser application is built from `frontend/src`.
- **Backend:** Node.js with ES modules and Express; the API and application startup are in `backend/server`.
- **Database:** MongoDB, accessed through Mongoose schemas and models in `backend/server/models`.
- **AI integration:** The OpenAI JavaScript SDK sends chat-completion requests to OpenRouter. The provider and API key are configured on the backend; the default model is `openrouter/free`, and `OPENROUTER_MODEL` can override it.
- **Other backend services:** `bcrypt`/`bcryptjs` for password hashing, `multer` for task attachments, and `nodemailer` for email delivery.

## Architecture overview

```text
Browser (React / Vite)
        | /api requests
        v
Express API (backend/server/index.js)
  |-- authentication and authorization (auth.js)
  |-- task, board, sprint, team, notification, and automation services
  |-- AI planning and Copilot (ai.js, OpenRouter)
        |
        +--> MongoDB through Mongoose models
        +--> backend/uploads/ for task attachment files
```

The frontend calls the Express API; during development, Vite proxies `/api` requests to the backend. The API validates requests, applies authentication and board/task access checks, and uses Mongoose models and service/helper modules to read and write application data. MongoDB stores users, teams and memberships, boards, tasks, sprints, task history, notifications, and automation settings. Task attachment metadata is stored with the task, while the uploaded file itself is stored on the backend filesystem.

AI is an optional backend integration, not a requirement for manually managing work. The API sends a user's prompt and relevant board context to OpenRouter, validates and normalizes the response, then handles supported actions such as creating tasks or planning a sprint. Board and sprint data are persisted by the normal backend stores. Without an API key, AI-dependent features are unavailable; the core workspace remains usable.

## Requirements

- Node.js and npm
- MongoDB running locally, or access to a MongoDB server such as MongoDB Atlas
- An OpenRouter API key is optional. Without one, the app can run in demo mode without AI-powered features.

## Start locally

1. Clone the repository and open a terminal in the project root.
2. Install the dependencies:

   ```bash
   npm run install:all
   ```

3. Configure the backend database before starting the app:

   ```bash
   cp backend/.env.example backend/.env
   ```

   The example uses `mongodb://localhost:27017/leadai`. Start your local MongoDB service before continuing, or edit `MONGODB_URI` in `backend/.env` to use a reachable MongoDB URI. The backend must be able to connect to MongoDB when it starts; the first-run setup screen cannot be used to configure a remote database if the backend cannot start.

4. Start the backend and frontend together:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:5173](http://localhost:5173). The backend API runs on [http://localhost:4000](http://localhost:4000).

On first use, LeadAI opens a setup screen. Select the local database or enter a cloud MongoDB URI, then provide an OpenRouter API key or choose **Skip / Demo Mode**. Setup is saved to `backend/.env`. Then create an account from the landing page to start using your workspace.

### Configure AI later

You can enter or change the OpenRouter API key in the app's Settings page. You can also set `OPENROUTER_API_KEY` in `backend/.env`. Get an API key from [OpenRouter](https://openrouter.ai/keys). Keep it private and never commit it.

### Run frontend and backend separately

If you prefer separate terminals:

```bash
# Terminal 1: backend API
npm run dev:backend

# Terminal 2: frontend
npm run dev:frontend
```

The Vite development server forwards `/api` requests to `http://localhost:4000`. If the backend uses a different port, set `PORT` in `backend/.env` and set `VITE_API_PROXY_TARGET` in the shell before starting Vite, for example:

```bash
VITE_API_PROXY_TARGET=http://localhost:4101 npm run dev:frontend
```

For a separately hosted API, set `VITE_API_BASE_URL` in `frontend/.env` to the API's base URL. Leave it blank for the local Vite proxy.

## Database setup and data

- The backend reads its environment from `backend/.env`. `backend/.env.example` is a template; never commit `backend/.env` or share its credentials in source control.
- The default database is local MongoDB at `mongodb://localhost:27017/leadai`. Use a separate development database; do not point local development at production.
- If teammates need to collaborate on the same accounts and boards, configure each backend to use the same shared development MongoDB database. Share database credentials privately and grant only the access the team needs.
- Changing the database connection does not copy existing accounts, boards, or tasks.
- Task attachments are stored in `backend/uploads/`, which is local to the backend instance.
- The backend does not silently fall back to in-memory storage when MongoDB is unavailable. The in-memory option is intended for explicit development/testing use only; it is temporary and is not shared between processes.

After a schema or index change, ensure the configured database has the current indexes:

```bash
npm --prefix backend run db:setup
npm --prefix backend run db:check
```

To add optional baseline sample tasks for an account that already exists:

```bash
npm --prefix backend run db:seed -- --email=you@example.com
```

These commands use the `MONGODB_URI` configured in `backend/.env`. The seed command is idempotent and does not overwrite existing task data.

## Build and tests

Build the frontend:

```bash
npm run build
```

Run the backend unit/API test suite:

```bash
npm test
```

Run the AI-related tests:

```bash
npm --prefix backend run test:ai
```

The optional database integration tests use a local MongoDB server and create a disposable database with a `leadai_test_` name:

```bash
npm run test:db
```

Do not point database tests at a production server. To run the production server locally after building the frontend, configure `backend/.env` and run:

```bash
npm start
```

## Limitations and future improvements

Current limitations:

- AI-generated plans and suggestions can be inaccurate; review generated or automatically applied changes in the workspace.
- AI requests require an OpenRouter API key and network access to the provider. Prompts and the board context included in a request are sent to that third party, so avoid including confidential or sensitive information.
- Uploaded attachments live in `backend/uploads/` on the backend instance. They are not automatically shared or synchronized across multiple backend instances, and the repository does not describe a backup or retention service for them.
- MongoDB is required for normal persistent use. Explicit in-memory development/testing data is temporary and is not shared across processes.
- The documented checks cover backend tests and a frontend production build; the repository does not include a documented production deployment, horizontal-scaling, or attachment object-storage setup.

Possible future improvements include configurable persistent object storage for attachments, deployment and backup guidance, broader end-to-end tests, and user controls for reviewing AI-proposed changes before applying them.

## AI usage disclosure

`chatWithContext()` in `backend/server/ai.js` requests and parses AI output. The authenticated route handlers for `POST /api/copilot/chat`, `POST /api/ai/boards`, and `POST /api/ai/sprints` in `backend/server/index.js` consume that output programmatically: they validate supported actions and may persist generated tasks, boards, or sprints. `tasksFromAiResult()` in `backend/server/lib/aiBoardPlan.js` extracts task plans for board and sprint creation. AI configuration and provider requests stay on the backend; prompts and supplied task, sprint, or member context may be sent to OpenRouter.

## Troubleshooting

- **The backend exits with a MongoDB connection error:** Make sure MongoDB is running and the URI in `backend/.env` is correct and reachable. For Atlas, check the cluster hostname, database credentials, and network access allowlist.
- **The browser cannot reach the API:** Confirm the backend is running on port `4000`, or configure `VITE_API_PROXY_TARGET` to match its port and restart the frontend.
- **AI features are unavailable:** Configure a valid OpenRouter API key in Settings or `backend/.env`. The app can still be used in demo mode without AI.
- **A port is already in use:** Set a different backend `PORT` and update `VITE_API_PROXY_TARGET` to that backend URL before restarting the frontend.

Check the API's database health at [http://localhost:4000/api/health](http://localhost:4000/api/health).

## Design

The original project design is available in [Figma](https://www.figma.com/design/b1TtQjgqK0SzCqi0mn2wAf/LeadAI?node-id=1-3&t=8JU2KGrmYrX10Kmm-1).
