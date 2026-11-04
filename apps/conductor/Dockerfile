FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY apps/conductor ./apps/conductor
RUN corepack enable && pnpm install --filter @infinitum/conductor...
WORKDIR /app/apps/conductor
ENV PORT=3001
EXPOSE 3001
CMD ["node", "src/server.ts"]
