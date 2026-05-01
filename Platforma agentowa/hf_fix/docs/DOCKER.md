# Running Hyperflow-PLATFORM

Two ways to run the full platform:

1. **[GitLab Workspaces](#running-on-gitlab-workspaces-recommended-from-mobile)** — zero local setup, works from a phone browser.
2. **[Docker Compose locally](#running-locally-with-docker-compose)** — requires a machine with Docker Desktop / Docker Engine.

## Running on GitLab Workspaces (recommended from mobile)

GitLab Workspaces runs the stack inside a browser-accessible VS Code
environment. No local Docker, no VPS, no CLI — works from a phone.

**Prerequisites:** a merge to `main` (or any branch pipeline) must have
already built and pushed the three images to the Container Registry:
`core`, `api-server`, `operator-panel`. The devfile pulls them by
`:latest`.

### How to open a workspace

1. Open: <https://gitlab.com/hyperflow1/Hyperflow-PLATFORM/-/workspaces/new>
2. **Cluster Agent**: pick any shared agent your group has available.
3. **Project ref**: pick the branch you want to run (usually `main`).
4. **Devfile location**: `.devfile.yaml` is auto-detected.
5. Click **Create workspace**.
6. Wait ~2 minutes. The `postStart` event runs `drizzle-kit push` automatically.
7. In the Workspaces sidebar, find the `operator-panel` endpoint and click it
   — that's your public URL.

### Troubleshooting Workspace startup

- **operator-panel shows 502 Bad Gateway**: the api-server container is
  probably still starting. Wait 30s and refresh.
- **operator-panel returns JSON errors on /api/\***: open the terminal in VS
  Code and check `curl http://localhost:8080/api/livez`. If it fails, run
  `pnpm --filter @workspace/db run push` manually in case `postStart` didn't fire.
- **Editor opens but nothing else runs**: images may be missing. Check
  <https://gitlab.com/hyperflow1/Hyperflow-PLATFORM/container_registry> —
  you need `core`, `api-server`, and `operator-panel` all with a `latest`
  tag (built automatically by the pipeline on main branch).

## Running locally with Docker Compose

This stack runs the full 3-layer platform locally with one command:

```bash
docker compose up --build
```

## Services

| Service          | Host URL                                | Purpose                             |
|------------------|-----------------------------------------|-------------------------------------|
| `postgres`       | `localhost:5432`                        | PostgreSQL for api-server           |
| `core`           | <http://localhost:8000/v1/health>       | Python FastAPI runtime              |
| `api-server`     | <http://localhost:8080/api/livez>       | Express shell (auth, persistence)   |
| `operator-panel` | <http://localhost:8082>                 | React UI (nginx)                    |

The operator panel proxies `/api/*` to `api-server:8080` via nginx, so the
browser only needs to talk to `localhost:8082`.

## Configuration

Copy `.env.example` to `.env` and adjust values. Main knobs:

- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — database credentials.
  These are interpolated into both the `postgres` service and the
  `DATABASE_URL` passed to `api-server`, so they're declared once.
  Override `POSTGRES_PASSWORD` for any shared or production environment.
- `OPENROUTER_API_KEY` — when empty, the Python core runs in a deterministic
  stub mode. All 6 EDDE phases still execute; LLM output is stubbed.
- `API_TOKEN` — required only when `HARDENED_MODE=true` in the api-server.
  Left at `false` in `docker-compose.yml` for dev convenience.

## Database schema initialization

The api-server calls `verifySchema()` on startup (`SELECT id FROM agents`)
and refuses to start if tables don't exist. `docker-compose.yml` includes a
one-shot `db-migrate` service that runs `drizzle-kit push` against the
running postgres before api-server starts. You should never need to run
this manually.

## Images in GitLab Container Registry

Every pipeline on `main` or a git tag builds and pushes three images:

```
registry.gitlab.com/hyperflow1/hyperflow-platform/core:<sha|tag|latest>
registry.gitlab.com/hyperflow1/hyperflow-platform/api-server:<sha|tag|latest>
registry.gitlab.com/hyperflow1/hyperflow-platform/operator-panel:<sha|tag|latest>
```

These are built with Kaniko (no DinD required) — see the `package` stage in
`.gitlab-ci.yml`.

## Known documentation inconsistencies

Follow `replit.md` + this doc as the source of truth — the
`docker-compose.yml` here is aligned with them:

- `docs/LOCAL_DEV.md` mentions api-server on port `8080`, which matches here;
  the root `package.json` `start:shell` script uses `8081` for native dev and
  is not used by the Docker stack.
- The env variable for the Python core URL is **`HYPERFLOW_CORE_URL`**
  (as read by `artifacts/api-server/src/lib/config.ts`), not `CORE_URL` as
  mentioned in `replit.md`.

## Deploying to Railway

Railway is a platform-as-a-service that pulls Docker images and runs them.
This stack is designed to work there out of the box — the `api-server`
image self-migrates the database, and the `operator-panel` image picks up
the backend URL from an env var at boot.

### What you need

- A Railway account with a payment method on file (even for the trial).
- All three images built and tagged `:latest` in GitLab Container Registry
  (done automatically by the `main` pipeline).
- A **GitLab deploy token** with `read_registry` scope so Railway can pull
  the private images.

### High-level flow

1. Create a Railway project.
2. Add a Postgres service from the Railway templates.
3. Add three "Deploy from Docker image" services:
   - `core` ← `registry.gitlab.com/hyperflow1/hyperflow-platform/core:latest`
   - `api-server` ← `registry.gitlab.com/hyperflow1/hyperflow-platform/api-server:latest`
   - `operator-panel` ← `registry.gitlab.com/hyperflow1/hyperflow-platform/operator-panel:latest`
4. For each service, add the registry credentials (deploy token username +
   token value) in Railway's image source dialog.
5. Set environment variables (see table below).
6. Generate a public domain for `operator-panel` only.

### Environment variables on Railway

| Service         | Variable              | Value                                         |
|-----------------|-----------------------|-----------------------------------------------|
| `core`          | `PORT`                | `8000`                                        |
| `core`          | `HOST`                | `0.0.0.0`                                     |
| `api-server`    | `PORT`                | `8080`                                        |
| `api-server`    | `NODE_ENV`            | `production`                                  |
| `api-server`    | `HARDENED_MODE`       | `false`                                       |
| `api-server`    | `DATABASE_URL`        | `${{Postgres.DATABASE_URL}}` (Railway reference) |
| `api-server`    | `HYPERFLOW_CORE_URL`  | `http://${{core.RAILWAY_PRIVATE_DOMAIN}}:8000` |
| `operator-panel`| `API_SERVER_URL`      | `https://${{api-server.RAILWAY_PUBLIC_DOMAIN}}` |

> The `${{...}}` syntax is Railway's built-in reference system. You type it
> directly in the variable value field and Railway resolves it at deploy.

### Why the operator-panel needs the public api-server URL

The browser talks to `operator-panel` over the public domain; its nginx
proxies `/api/*` server-side to `$API_SERVER_URL`. Using the public
Railway domain for api-server avoids CORS and works with browsers on any
network.

### Verifying

After the first deploy:

1. Open the `api-server` service logs — you should see:
   `🔄 Running drizzle-kit push...` → `✅ Schema sync complete.` → `🚀 Starting api-server...`
2. Hit `https://<api-server-domain>/api/livez` — should return `{"status":"alive",...}`.
3. Open the `operator-panel` public URL — you should see the React UI
   loading agents (or an empty list if you haven't seeded any yet).

### Seeding default agents

Once `api-server` is up, seed the three default agents by calling the seed
endpoint from a terminal or any HTTP client:

```
curl -X POST https://<api-server-domain>/api/agents/seed
```

## Rebuilding a single service

```bash
docker compose build api-server
docker compose up -d api-server
```

## Tearing down

```bash
docker compose down           # keep database volume
docker compose down -v        # wipe database volume too
```
