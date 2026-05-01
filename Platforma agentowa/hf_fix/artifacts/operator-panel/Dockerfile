# =============================================================================
# Operator Panel — React/Vite SPA served by nginx on port 80
# =============================================================================
# Multi-stage build:
#   builder  — full monorepo context, pnpm + vite build → dist/public/
#   runner   — nginx:alpine serving static files + /api proxy
#
# The /api proxy target is resolved at container start from the
# API_SERVER_URL env var, so the same image works for:
#   docker-compose  → http://api-server:8080         (default)
#   Railway/Fly/etc → https://<api-server>.example.com
# =============================================================================
FROM node:24-alpine AS builder

ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PORT=4173 \
    BASE_PATH=/ \
    PWA_ENABLED=false

RUN corepack enable \
    && corepack prepare pnpm@9.15.4 --activate

WORKDIR /repo

# vite.config.ts exposes an alias `@assets` → ../../attached_assets. That
# directory is .gitignored and not present in the repo. Create an empty
# placeholder so vite can resolve the alias at config-load time.
RUN mkdir -p /repo/attached_assets

COPY . .
RUN mkdir -p attached_assets

RUN pnpm install --frozen-lockfile \
    && pnpm --filter ./artifacts/operator-panel run build

# ---- Runtime stage: nginx serving static SPA --------------------------------
FROM nginx:1.27-alpine AS runner

# gettext provides envsubst used by the entrypoint to render nginx.conf
# from the template at container start.
RUN apk add --no-cache gettext

# Template is rendered to /etc/nginx/conf.d/default.conf at boot.
COPY artifacts/operator-panel/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY artifacts/operator-panel/docker-entrypoint.sh /docker-entrypoint.d/99-render-conf.sh
RUN chmod +x /docker-entrypoint.d/99-render-conf.sh

COPY --from=builder /repo/artifacts/operator-panel/dist/public /usr/share/nginx/html

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
