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

- **Frontend:** React and Vite
- **Backend:** Node.js and Express
- **Database:** MongoDB with Mongoose
- **AI:** Optional OpenRouter API integration

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

## Troubleshooting

- **The backend exits with a MongoDB connection error:** Make sure MongoDB is running and the URI in `backend/.env` is correct and reachable. For Atlas, check the cluster hostname, database credentials, and network access allowlist.
- **The browser cannot reach the API:** Confirm the backend is running on port `4000`, or configure `VITE_API_PROXY_TARGET` to match its port and restart the frontend.
- **AI features are unavailable:** Configure a valid OpenRouter API key in Settings or `backend/.env`. The app can still be used in demo mode without AI.
- **A port is already in use:** Set a different backend `PORT` and update `VITE_API_PROXY_TARGET` to that backend URL before restarting the frontend.

Check the API's database health at [http://localhost:4000/api/health](http://localhost:4000/api/health).

## Design

The original project design is available in [Figma](https://www.figma.com/design/b1TtQjgqK0SzCqi0mn2wAf/LeadAI?node-id=1-3&t=8JU2KGrmYrX10Kmm-1).
