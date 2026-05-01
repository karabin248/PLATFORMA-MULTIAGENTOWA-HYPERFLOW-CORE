# =============================================================================
# API Server — Node.js Express shell on port 8080
# =============================================================================
# Clean multi-stage build. Migrations are NOT run by this image — they must
# be applied separately (via `pnpm --filter @workspace/db run push` from a
# dev environment, or via the one-off migration SQL in docs/DOCKER.md).
# =============================================================================
FROM node:24-alpine AS builder

ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable \
    && corepack prepare pnpm@9.15.4 --activate

WORKDIR /repo

COPY . .

RUN pnpm install --frozen-lockfile \
    && pnpm --filter ./artifacts/api-server run build

RUN pnpm --filter ./artifacts/api-server deploy --prod /prod/api-server

# ---- Runtime stage -----------------------------------------------------------
FROM node:24-alpine AS runner

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

RUN apk add --no-cache curl \
    && adduser -D -u 10001 app

COPY --from=builder --chown=app:app /prod/api-server/node_modules ./node_modules
COPY --from=builder --chown=app:app /prod/api-server/package.json ./package.json
COPY --from=builder --chown=app:app /repo/artifacts/api-server/dist ./dist

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/livez" || exit 1

EXPOSE 8080
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
