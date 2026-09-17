# syntax=docker/dockerfile:1
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY tsconfig.json eslint.config.js ./
COPY apps apps
COPY packages packages
COPY scripts scripts
COPY tests tests
RUN npm run build

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @voice-action-lab/server --include-workspace-root
COPY --from=build --chown=node:node /app/apps/server /app/apps/server
COPY --from=build --chown=node:node /app/packages /app/packages
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
LABEL org.opencontainers.image.source="https://github.com/yukurash/voice-action-lab"
LABEL org.opencontainers.image.revision="${SOURCE_COMMIT}"
USER node
EXPOSE 3000
CMD ["node", "apps/server/index.ts"]
