# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# AutoMail — multi-stage production image
#
# Stage 1 (deps)    installs node_modules only, so it caches on lockfile changes
# Stage 2 (builder) generates the Prisma client and builds the standalone bundle
# Stage 3 (runner)  ships only .next/standalone, the static assets and the
#                   generated Prisma client — no dev dependencies, no source,
#                   and no Prisma CLI
#
# Debian slim rather than Alpine: the Prisma query engine links against glibc
# and OpenSSL 3, which avoids a whole category of musl runtime surprises.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
# openssl is required by the Prisma query engine at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- Stage 1: dependencies --------------------------------------------------
FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma
# `npm ci` runs the postinstall that generates the Prisma client, so the schema
# has to be copied first.
RUN npm ci --no-audit --no-fund

# --- Stage 2: build ---------------------------------------------------------
FROM base AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# A dummy URL satisfies Prisma at build time; the real one is injected at run
# time. No queries run during the build — every data page is force-dynamic.
ENV DATABASE_URL="file:/app/data/automail.db"

RUN npx prisma generate

# Emit a plain-SQL schema so the runtime can create the database without
# shipping the Prisma CLI and its dependency tree into the standalone image.
RUN npx prisma migrate diff \
    --from-empty \
    --to-schema-datamodel prisma/schema.prisma \
    --script > prisma/schema.sql

RUN npm run build

# --- Stage 3: runtime -------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run unprivileged. The node image already ships a `node` user (uid 1000).
RUN mkdir -p /app/data && chown -R node:node /app

# The standalone output bundles its own minimal node_modules.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Schema SQL plus the generated client and its query engine. The Prisma CLI is
# deliberately not copied: it is unusable in a standalone bundle, and the
# entrypoint applies the schema through the client instead.
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

USER node

EXPOSE 3000

# The database lives on a mounted volume so it survives image rebuilds.
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
