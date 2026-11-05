FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/metatron ./apps/metatron
RUN pnpm install --filter @infinitum/metatron-app... --frozen-lockfile || pnpm install --filter @infinitum/metatron-app...
WORKDIR /app/apps/metatron
ENV PORT=3005
EXPOSE 3005
CMD ["node", "src/server.ts"]
