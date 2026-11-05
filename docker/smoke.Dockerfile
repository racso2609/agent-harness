FROM node:22-alpine

# pnpm is needed to pack the workspace (and to rewrite `workspace:^`); npm,
# already in the image, is what the smoke test uses to install the tarballs,
# exactly like an end user would. Pinned to the workspace's major so the
# lockfile and its settings are honoured.
RUN npm install -g pnpm@11

WORKDIR /app

# The whole repo is copied in: no host mount, so the run is fully isolated and
# `dist` is built here instead of reusing whatever the host has. .dockerignore
# keeps node_modules, dist, .git and *.tgz from the host out of the image.
COPY . .

# strictDepBuilds=false: pnpm 11.28 added the build-script allowlist check, and
# a non-interactive install fails on it; the allowlist in pnpm-workspace.yaml
# still applies, so only esbuild's script runs.
RUN pnpm install --frozen-lockfile --config.strictDepBuilds=false
RUN pnpm -r build

# HOME points at a throwaway directory, so nothing of the run can reach a real
# ~/.racso-harness/. The smoke test already redirects the HOME of every child
# process; this makes the image self-contained too.
ENV HOME=/smoke-home
RUN mkdir -p /smoke-home

CMD ["node", "scripts/smoke-install.mjs"]
