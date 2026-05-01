## Fly.io Deployment (Minimal Notes)

This repository includes two Fly.io configuration files for deploying the Hyperflow platform:

* **`fly.hyperflow-core.toml`** – defines a private FastAPI service with no proxy‑exposed ports.  The core listens on `fly-local-6pn:8000` and is reachable over the 6PN network via `http://hyperflow-core.internal:8000`.
* **`fly.hyperflow-api.toml`** – defines a public Node.js API service that proxies all calls to the core and performs database migrations via a `release_command`.

### Deploy steps

1. **Create the Fly apps (without deploying):**

   ```bash
   fly launch --name hyperflow-core --no-deploy --region ams --no-public-ip -c fly.hyperflow-core.toml
   fly launch --name hyperflow-api  --no-deploy --region ams -c fly.hyperflow-api.toml
   ```

2. **Create and attach a Postgres cluster:**

   ```bash
   fly postgres create --name hyperflow-db --region ams --org <your-org>
   fly postgres attach -a hyperflow-api hyperflow-db
   ```

3. **Set the required secrets:**

   ```bash
   fly -a hyperflow-core secrets set HYPERFLOW_CORE_TOKEN=<random> OPENROUTER_API_KEY=<openrouter-key>
   fly -a hyperflow-api  secrets set HYPERFLOW_CORE_TOKEN=<same-random> API_TOKEN=<client-token> LOG_LEVEL=info
   ```

4. **Deploy the services (core first):**

   ```bash
   fly deploy -c fly.hyperflow-core.toml --remote-only
   fly deploy -c fly.hyperflow-api.toml  --remote-only
   ```

5. **Verify connectivity:** Run `curl http://hyperflow-core.internal:8000/v1/health` from the API machine via SSH or WireGuard to ensure the core is reachable.

These commands are provided for convenience; adjust region names and organisation to your Fly.io setup.