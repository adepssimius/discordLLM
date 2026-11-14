# syntax=docker/dockerfile:1
#
# The image for any bot built on discordllm. The build context is the bot's
# repository; `discordllm-build` passes the build args from the bot's
# package.json. See src/build.ts.

ARG NODE_IMAGE=node:24-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.30

FROM ${UV_IMAGE} AS uv

# ---- build -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=11.17.0
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
# NOTE: do not pass --no-optional / --ignore-optional here. The Agent SDK ships
# its Claude Code binary as an npm optional dependency; skipping optionals
# produces an image that fails at runtime with a missing-executable error.
RUN pnpm install --frozen-lockfile

# A bot defined by a discordllm.json alone has no sources and no build script.
COPY . .
RUN pnpm run --if-present build && mkdir -p dist

# ---- tools -------------------------------------------------------------------
# MCP servers distributed as Python packages, pinned. uv fetches a standalone
# Python so the image does not depend on what Debian ships. Everything lives
# under /opt/uv so the runtime stage can copy it across with its paths intact —
# a tool's venv points at the interpreter by absolute path.
FROM ${NODE_IMAGE} AS tools
ARG UV_TOOLS=""
ARG UV_PYTHON=3.13
ARG TOOLS_SMOKE=""
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/opt/uv/bin \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH=/opt/uv/bin:$PATH
RUN mkdir -p /opt/uv/bin \
 && if [ -n "$UV_TOOLS" ]; then \
      apt-get update \
   && apt-get install -y --no-install-recommends ca-certificates \
   && rm -rf /var/lib/apt/lists/* \
   && for t in $UV_TOOLS; do uv tool install --python "$UV_PYTHON" "$t" || exit 1; done; \
    fi \
 && if [ -n "$TOOLS_SMOKE" ]; then sh -ec "$TOOLS_SMOKE"; fi

# ---- runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION=11.17.0
ARG APT_PACKAGES=""
WORKDIR /app

# Nothing here runs scripts but the bot and its MCP servers: no compiler, and
# no shell tools beyond what the bot asks for by name.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini $APT_PACKAGES \
 && rm -rf /var/lib/apt/lists/*

COPY --from=tools /opt/uv /opt/uv

# Runtime deps only, optionals included so the bundled Claude Code binary (and
# sharp's prebuilt libvips, for a bot that takes photos) are present.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && pnpm install --frozen-lockfile --prod \
 && pnpm store prune

COPY --from=build /app/dist ./dist
COPY discordllm.jso[n] ./

# HOME must be writable and persistent: the SDK keeps session transcripts
# beneath it, and resuming a thread after a restart depends on them still being
# there. /data is the volume mount.
ENV NODE_ENV=production \
    HOME=/data/home \
    DATA_DIR=/data \
    HTTP_PORT=8080 \
    PATH=/opt/uv/bin:$PATH

RUN groupadd -g 10001 app && useradd -u 10001 -g app -d /data -s /usr/sbin/nologin app
USER 10001:10001

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
# A bot with code runs its own main; one defined by discordllm.json runs the library's.
CMD ["sh", "-c", "if [ -f dist/main.js ]; then exec node --enable-source-maps dist/main.js; else exec node --enable-source-maps node_modules/discordllm/dist/cli.js start; fi"]
