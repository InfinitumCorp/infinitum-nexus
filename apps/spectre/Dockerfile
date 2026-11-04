FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY apps/spectre ./apps/spectre
RUN corepack enable && pnpm install --filter @infinitum/spectre...
WORKDIR /app/apps/spectre
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server/main.ts"]
