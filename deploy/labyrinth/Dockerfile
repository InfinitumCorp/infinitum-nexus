# syntax=docker/dockerfile:1
FROM node:22.23.4-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/spectre ./apps/spectre
COPY --chown=node:node apps/veil ./apps/veil
COPY --chown=node:node scripts/labyrinth-maintain.ts ./scripts/labyrinth-maintain.ts
# Optional session CA for managed build networks; never stored in an image layer.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    export NODE_USE_ENV_PROXY=1; \
    corepack prepare pnpm@10.28.0 --activate && \
    pnpm install --prod --filter @infinitum/spectre... --frozen-lockfile --ignore-scripts && \
    rm -rf /root/.cache/node/corepack /root/.local/share/pnpm /root/.cache/pnpm
RUN mkdir -p /var/lib/labyrinth && chown node:node /var/lib/labyrinth && chmod 0700 /var/lib/labyrinth
RUN node --experimental-strip-types --input-type=module -e "await import('./apps/spectre/src/server/app.ts'); await import('./apps/veil/server/index.ts')"
USER node
ENV NODE_ENV=production PORT=3000 SPECTRE_DATA_DIR=/var/lib/labyrinth
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "--experimental-strip-types", "apps/spectre/src/server/main.ts"]
