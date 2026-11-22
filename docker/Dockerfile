# Freilauf web app + group-ride signalling on one port.
#
#   docker compose up -d            (uses ../docker-compose.yml)
#   docker build -f docker/Dockerfile -t freilauf-web .
#   docker run -d -p 8080:8080 --read-only --tmpfs /tmp freilauf-web
#
# Build context: the repository root.

# ── build: install only what the web app needs (no Electron) and build it;
#    then collect the runtime files in /out: the server sources, dist/, and
#    the signalling package with its one production dependency (ws). ──
FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@freilauf/web..." \
 && pnpm --filter @freilauf/web build \
 && pnpm --filter @freilauf/signalling deploy --prod --legacy /out/apps/signalling \
 && mkdir -p /out/apps/web/src/server \
 && cp apps/web/package.json /out/apps/web/ \
 && cp apps/web/src/server/main.ts apps/web/src/server/webServer.ts \
       apps/web/src/server/securityHeaders.ts /out/apps/web/src/server/ \
 && cp -r apps/web/dist /out/apps/web/dist

# ── runtime: plain Node (runs the .ts server directly), no build tools ──
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
# Same relative layout as the repository, so the server's imports resolve.
COPY --from=build /out/ ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "apps/web/src/server/main.ts"]
