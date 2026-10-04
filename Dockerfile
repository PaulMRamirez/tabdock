# The relay's container image. It names no host, provider or domain: every
# setting is an environment variable (SPEC section 11, ADR 0018), and
# docs/deploy.md shows one host that meets section 11. The relay has no build
# step, since Node 22 strips TypeScript types itself, so the image is the
# relay's and protocol's sources beside their production dependencies.
#
# Both bases are pinned by digest, looked up on 4 October 2026, and Dependabot
# proposes new ones (.github/dependabot.yml). The build stage installs with the
# lockfile; the runtime stage is distroless (no shell, no package manager) and
# runs as uid 65532, owning none of its files, /app included, so the relay
# cannot change its code even where the root file system stays writable (as
# on Fly), the root can be mounted read-only where a host allows it, and only
# the audit directory needs to be writable. scripts/smoke-image.ts checks both.

# node:22-bookworm-slim, the multi-platform index.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
ENV CI=true
# Corepack installs the pnpm version packageManager names; nothing else is fetched outside the lockfile.
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay/package.json packages/relay/
# The relay and what it depends on, production dependencies only. pnpm deploy
# would copy protocol under node_modules, where Node refuses to strip types,
# so the workspace link stays a link to packages/protocol instead.
RUN pnpm install --prod --frozen-lockfile --filter '@tabdock/relay...'
COPY packages/protocol/src packages/protocol/src
COPY packages/relay/src packages/relay/src
# .dockerignore already leaves tests out; this keeps a stray one out of the image too.
RUN find packages -name '*.test.ts' -delete

# gcr.io/distroless/nodejs22-debian13:nonroot, the multi-platform index.
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
# Owned by root and readable by all: the relay can read its code and never
# change it. The COPY comes first so that it creates /app as root: the base
# runs as 65532, BuildKit makes a missing WORKDIR as that user, and a COPY
# into an existing directory leaves that directory's owner alone, so a WORKDIR
# first would hand /app itself to the relay, which on a writable root (Fly's)
# could then move its code aside and copy it back changed.
COPY --from=build --chown=0:0 /app /app
WORKDIR /app
ENV NODE_ENV=production \
    TABDOCK_PORT=8787
USER 65532:65532
EXPOSE 8787
# The base's entrypoint is node itself. Exec form, so SIGTERM and SIGINT reach
# the relay, which closes within a second (main.ts); no init process is needed,
# since the relay starts only worker threads. The heap cap suits a 512 MB host
# beside the argument worker's own 256 MB cap, and holds TABDOCK_MAX_TOOL_BYTES's
# default with room to spare: packages/relay/test/tool-heap.test.ts reads this
# flag and fills every hosted page slot up to that budget under it (ADR 0018).
CMD ["--max-old-space-size=192", "packages/relay/src/main.ts"]
