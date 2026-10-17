# DegreePath AI

A small, local-first senior-project prototype for exploring degree progress and planning questions. It uses **Node.js 20+**, plain browser JavaScript, and a JSON file for persistence; it has no package dependencies, database server, or paid-service requirement.

## Run it

1. Install Node.js 20 or newer.
2. From the repository folder, run `node server.mjs`.
3. Open [http://localhost:3000](http://localhost:3000), create a demo account, and try the course tracker and planner.

The first run creates `data\degreepath.json` with empty accounts and conversations. Keep the server running to use the app. The data file is local and is excluded from Git. Set `PORT` to change the port.

### Optional AI responses

Without configuration, the app clearly labels responses as **demo planning responses**, generated locally from the current sample progress. To enable AI responses, set `AI_API_KEY` in the server environment and restart. The prototype calls an OpenAI-compatible chat-completions endpoint. Optional settings are `AI_BASE_URL` (defaults to `https://api.openai.com/v1/chat/completions`) and `AI_MODEL` (defaults to `gpt-4o-mini`). Keep the key on the server; it is never sent to the browser.

In PowerShell, configure a key for the current terminal and start the server with:

```powershell
$env:AI_API_KEY = "your-key"
node server.mjs
```

For each AI answer, the server sends the current question plus structured sample course, prerequisite, requirement, and progress data. It does not send account details or conversation messages. The planner does not use previous messages as AI context, including when continuing a saved conversation.

## Prototype scope and important limitations

- All courses, credits, prerequisites, and requirement groups shown are **fictional sample data**. They are not BYU–Idaho catalog information, current requirements, or academic approval. Do not use this prototype to make real enrollment or graduation decisions.
- Accounts, hashed passwords, sessions, completed-course lists, and conversations persist in the local JSON file. Conversation and student data are scoped to the signed-in account by server-side ownership checks.
- This is a single-process, local demo, not production authentication or storage. It lacks production-grade account recovery, rate limiting, deployment hardening, a managed database, and multi-instance coordination. Use HTTPS and replace these pieces before any public or real-student deployment.
- AI output is explanatory only. The prototype's sample course prerequisites and requirement arithmetic are the source of truth for its demo progress; an LLM cannot alter them. AI may be inaccurate and must not be treated as an official advisor.

## Checks

Run the built-in tests with `node --test`.
