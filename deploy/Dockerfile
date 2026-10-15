# Origin image: one image, three processes — the API (default command), the recruitment
# worker and the Node tracking-edge fallback (deploy/docker-compose.yml overrides `command`
# for the last two). The production redirect runs on Cloudflare Workers
# (deploy/wrangler.toml), NOT from this image. The container runs TypeScript directly via
# tsx — no build step — keeping the image simple.
#
# Build from the repository root:  docker build -f deploy/Dockerfile .
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app
# Run as the image's unprivileged user. Everything is copied with --chown so it stays
# readable whatever permission bits the build context carries.
RUN chown node:node /app
USER node

# Dependencies first, for layer caching. `npm ci` installs exactly what package-lock.json
# pins and fails if the lock is out of sync with the manifests. Every workspace the lock
# describes gets its manifest copied (the web app's too — it adds only its two small runtime
# dependencies, and none of its source is copied) so the workspace set matches the lock.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/core/package.json packages/core/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node packages/integrations/package.json packages/integrations/
COPY --chown=node:node packages/recruitment/package.json packages/recruitment/
COPY --chown=node:node packages/tracking-edge/package.json packages/tracking-edge/
COPY --chown=node:node packages/api/package.json packages/api/
COPY --chown=node:node packages/web/package.json packages/web/
RUN npm ci --omit=dev

# The source (tests, docs, the web app's source and local env files are excluded by
# the repository's .dockerignore).
COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node packages ./packages

EXPOSE 8787 8788
# Default process is the API. docker-compose overrides `command` for the worker and the edge.
CMD ["node", "--import", "tsx", "packages/api/src/server.ts"]
