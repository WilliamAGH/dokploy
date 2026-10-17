# syntax=docker/dockerfile:1
FROM node:24.18.0-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
# Node 24.4.0's Corepack runs bin/pnpm.cjs, which pnpm >=11 no longer
# ships. This copy is baked into the image because the runtime stage runs pnpm;
# `pnpm --version` fetches pnpm's native binary now rather than at container start.
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate && pnpm --version

FROM base AS build
ARG TARGETARCH
# The store is a cache mount, so the global virtual store would leave node_modules
# linked into a directory that later steps and the final image do not have.
ENV pnpm_config_virtual_store_type=project
ENV pnpm_config_store_dir=/pnpm/store
COPY . /usr/src/app
WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y python3 make g++ git python3-pip pkg-config libsecret-1-dev && rm -rf /var/lib/apt/lists/*

# Install dependencies
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=corepack-${TARGETARCH},target=/root/.cache/node/corepack \
    pnpm install --frozen-lockfile

# Deploy only the dokploy app

ENV NODE_ENV=production
RUN --mount=type=cache,id=corepack-${TARGETARCH},target=/root/.cache/node/corepack \
    pnpm --filter=@dokploy/server build
RUN --mount=type=cache,id=corepack-${TARGETARCH},target=/root/.cache/node/corepack \
    pnpm --filter=./apps/dokploy run build

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=corepack-${TARGETARCH},target=/root/.cache/node/corepack \
    pnpm --filter=./apps/dokploy --prod deploy --legacy /prod/dokploy

RUN cp -R /usr/src/app/apps/dokploy/.next /prod/dokploy/.next
RUN cp -R /usr/src/app/apps/dokploy/dist /prod/dokploy/dist

FROM base AS dokploy
ARG MONITORING_IMAGE=""
ENV MONITORING_IMAGE=${MONITORING_IMAGE}
WORKDIR /app

# Set production
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y tini curl unzip zip apache2-utils iproute2 rsync git-lfs && git lfs install && rm -rf /var/lib/apt/lists/*

# Copy only the necessary files
COPY --from=build /prod/dokploy/.next ./.next
COPY --from=build /prod/dokploy/dist ./dist
COPY --from=build /prod/dokploy/next.config.mjs ./next.config.mjs
COPY --from=build /prod/dokploy/public ./public
COPY --from=build /prod/dokploy/package.json ./package.json
COPY --from=build /prod/dokploy/drizzle ./drizzle
COPY .env.production ./.env
COPY --from=build /prod/dokploy/components.json ./components.json
COPY --from=build /prod/dokploy/node_modules ./node_modules


# Install docker
RUN curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh --version 28.5.2 && rm get-docker.sh && curl https://rclone.org/install.sh | bash

# Install Nixpacks and tsx
# | VERBOSE=1 VERSION=1.21.0 bash

ARG NIXPACKS_VERSION=1.41.0
RUN curl -sSL https://nixpacks.com/install.sh -o install.sh \
    && chmod +x install.sh \
    && ./install.sh \
    && pnpm install -g tsx

# Install Railpack
ARG RAILPACK_VERSION=0.15.4
RUN curl -sSL https://railpack.com/install.sh | bash

# Install buildpacks
COPY --from=buildpacksio/pack:0.39.1 /usr/local/bin/pack /usr/local/bin/pack

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/trpc/settings.health || exit 1

# tini reaps HEALTHCHECK child processes that Node (as PID 1) leaves defunct.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Ejecutar node directamente: pnpm como wrapper queda residente (~100MB RSS)
  CMD ["sh", "-c", "node -r dotenv/config dist/wait-for-postgres.mjs && node -r dotenv/config dist/migration.mjs && exec node -r dotenv/config dist/server.mjs"]
