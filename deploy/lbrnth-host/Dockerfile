# syntax=docker/dockerfile:1
# Labyrinth *LBRNTH hosted service for Google Cloud Run. Build from the repository root:
#   gcloud builds submit --config deploy/lbrnth-host/cloudbuild.yaml .
FROM node:22.23.4-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/lbrnth-host ./apps/lbrnth-host
RUN corepack prepare pnpm@10.28.0 --activate && \
    pnpm install --prod --filter @infinitum/lbrnth-host... --frozen-lockfile --ignore-scripts && \
    rm -rf /root/.cache/node/corepack /root/.local/share/pnpm /root/.cache/pnpm
# Fail the build, not the first request, if a module does not load.
RUN node --experimental-strip-types --input-type=module -e "await import('./apps/lbrnth-host/src/server.ts'); await import('./apps/lbrnth-host/src/pg.ts')"
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "--experimental-strip-types", "apps/lbrnth-host/src/main.ts"]
