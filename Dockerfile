FROM node:24-slim AS deps

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable && corepack prepare pnpm@11.5.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder

COPY . .
RUN pnpm run build

FROM node:24-slim AS runner

WORKDIR /app

ENV HOME=/tmp
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PORT=8787
ENV WRANGLER_LOG_PATH=/tmp/wrangler.log
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable \
  && corepack prepare pnpm@11.5.3 --activate \
  && mkdir -p /data /tmp \
  && chown -R node:node /app /data /tmp

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder --chown=node:node /app/scripts ./scripts

USER node

EXPOSE 8787
VOLUME ["/data"]

CMD ["sh", "scripts/start-docker.sh"]
