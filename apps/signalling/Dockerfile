# Freilauf signalling server. Build from this directory:
#   docker build -t freilauf-signalling apps/signalling
#   docker run -d --name freilauf-signalling -p 8787:8787 freilauf-signalling
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund
COPY src/protocol.ts src/server.ts src/main.ts ./src/

USER node
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "src/main.ts"]
