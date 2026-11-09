FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/architect ./apps/architect
RUN pnpm install --filter @infinitum/architect... --frozen-lockfile || pnpm install --filter @infinitum/architect...
WORKDIR /app/apps/architect
ENV PORT=3001
EXPOSE 3001
CMD ["node", "src/server.ts"]
