# Origin image (Hetzner): runs the API, the recruitment pipeline workers, and the
# Node tracking-edge fallback. The production redirect runs on Cloudflare Workers
# (see deploy/wrangler.toml), NOT from this box. The container runs TypeScript
# directly via tsx — no build step — keeping the image simple.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first for layer caching.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY packages/recruitment/package.json packages/recruitment/
COPY packages/tracking-edge/package.json packages/tracking-edge/
COPY packages/api/package.json packages/api/
RUN npm install --omit=dev --workspaces --include-workspace-root || npm install

# Copy the source.
COPY tsconfig.base.json ./
COPY packages ./packages

EXPOSE 8787
# Default process is the API. docker-compose overrides `command` for the worker.
CMD ["node", "--import", "tsx", "packages/api/src/server.ts"]
