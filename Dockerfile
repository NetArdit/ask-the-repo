# Builds the self-contained Next.js server and runs it as one long-lived Node.js process.
# NOT YET BUILT OR RUN ANYWHERE: this file was written from the verified local procedure (npm run build, then
# node .next/standalone/server.js) but no container engine was available to test it.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# `npm run build` runs `next build` and then copies static assets into .next/standalone.
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=10000 \
    INDEX_STORE_DIR=/app/data
COPY --from=build --chown=node:node /app/.next/standalone ./
# A folder the unprivileged user can write indexes to. Its contents are rebuildable, so it does not need to persist.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 10000
# --liftoff-only: with V8 default WASM tier-up, indexing peaks at 0.9-1.7 GB of native memory (measured, Phase 2), far above the
# 512 MB free instance; with it, peaks were 0.11-0.37 GB. It cannot be set through NODE_OPTIONS, so it is a node argument.
CMD ["node", "--liftoff-only", "server.js"]
