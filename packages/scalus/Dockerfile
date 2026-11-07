# SCALVS.ai runtime. Build from the repository root:
#   docker build -f packages/scalus/Dockerfile .
# The image listens on PORT (default 3020) and advertises SCALVS_ORIGIN
# (default https://scalvs.app). It does not deploy or change DNS.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --filter @infinitum/scalus... --frozen-lockfile || pnpm install --filter @infinitum/scalus...
RUN pnpm --filter @infinitum/scalus build
WORKDIR /app/packages/scalus
ENV PORT=3020
ENV SCALVS_ORIGIN=https://scalvs.app
EXPOSE 3020
USER node
CMD ["node", "dist/server.js"]
