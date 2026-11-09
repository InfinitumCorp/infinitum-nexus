FROM node:22-bookworm-slim

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --filter @infinitum/fabric-server... --frozen-lockfile \
  && mkdir -p /data \
  && useradd --system --uid 10001 --home /data fabric \
  && chown -R fabric:fabric /data

WORKDIR /app/apps/fabric
ENV PORT=3020 \
    FABRIC_BIND=0.0.0.0 \
    FABRIC_DATA_DIR=/data
EXPOSE 3020
VOLUME ["/data"]
USER fabric
CMD ["node", "--experimental-strip-types", "src/server.ts"]
