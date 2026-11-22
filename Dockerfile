# Images for developing and running the service.
#
#   dev      The shared development environment. The dev container uses it.
#   build    Builds the service with the dev stage's tools.
#   runtime  The image published for servers. It contains only what the
#            service needs to run.
#
# See .devcontainer/README.md and docs/guides/self-hosting.md.

ARG UBUNTU_VERSION=26.04
ARG NODE_VERSION=24.22.3

# The official Node.js image supplies the node binary for the dev and runtime
# stages, so both use the same pinned version.
FROM node:${NODE_VERSION}-bookworm-slim AS node

# ---------------------------------------------------------------------------
# dev
# ---------------------------------------------------------------------------
FROM ubuntu:${UBUNTU_VERSION} AS dev

ARG USERNAME=dev

ENV LANG=C.UTF-8

# General tools for working in any repository. Python 3 runs the repository
# checks in tools/scripts/.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash-completion \
        ca-certificates \
        curl \
        git \
        less \
        nano \
        openssh-client \
        python3 \
        sudo \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# A C++ toolchain lets npm compile native modules, such as better-sqlite3,
# when it does not use a prebuilt binary.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node.js and npm build and run the bot. Bump NODE_VERSION above to upgrade.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Ubuntu images include a user named ubuntu with ID 1000, the usual ID of the
# first user on a Linux host. Rename it so the container user owns files in
# the mounted workspace the same way the host user does. The user can run sudo
# without a password, to try out packages before adding them to this file.
RUN usermod --login "${USERNAME}" --move-home --home "/home/${USERNAME}" ubuntu \
    && groupmod --new-name "${USERNAME}" ubuntu \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}"

USER ${USERNAME}

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM dev AS build

WORKDIR /home/dev/src

# Install dependencies before copying the source, so that source changes
# reuse the cached install.
COPY --chown=dev:dev package.json package-lock.json ./
RUN npm ci

# Compile the TypeScript, then keep only what the bot needs at run time.
COPY --chown=dev:dev . .
RUN npm run build \
    && npm prune --omit=dev \
    && mkdir -p out \
    && cp -r package.json node_modules build assets out/

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
# Use the same base as the dev stage, so that programs built there run here.
FROM ubuntu:${UBUNTU_VERSION} AS runtime

# Install only what the service needs at run time. CA certificates let it
# make HTTPS connections.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user. /data holds files that must survive updates,
# and compose.yaml mounts a volume there.
RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /app /data \
    && chown app:app /data

WORKDIR /app

# Copy the built bot from the build stage.
COPY --from=build /home/dev/src/out/ /app/

USER app

# The bot keeps its SQLite database in the /data volume.
ENV NODE_ENV=production \
    DATA_DIR=/data

CMD ["node", "build/main.js"]
