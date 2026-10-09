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

Open `http://localhost:5173`. The API runs on port 4000 and uses the seeded board in memory by default. Copy `backend/.env.example` to `backend/.env` and set `MONGODB_URI` to persist tasks in MongoDB. See `instructions/` for API, environment, and navigation details.