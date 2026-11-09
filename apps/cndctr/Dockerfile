FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --filter @infinitum/cndctr... --frozen-lockfile
RUN pnpm --filter @infinitum/cndctr build

FROM node:22-bookworm-slim
RUN useradd --system --uid 10001 --home /app cndctr
WORKDIR /app
COPY --from=build --chown=cndctr:cndctr /app/apps/cndctr/dist ./dist
COPY --from=build --chown=cndctr:cndctr /app/apps/cndctr/public ./public
ENV PORT=3011 \
    CNDCTR_BIND=0.0.0.0 \
    NODE_ENV=production
EXPOSE 3011
USER cndctr
CMD ["node", "dist/server.js"]
