ARG NODE_IMAGE=node:24.4.1-alpine
FROM ${NODE_IMAGE} AS build
ARG RELEASE_SHA
ENV RELEASE_SHA=${RELEASE_SHA}
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci

COPY apps/api apps/api
COPY policy policy
RUN node -e "if (!/^[0-9a-f]{40}$/.test(process.env.RELEASE_SHA || '')) throw new Error('RELEASE_SHA must be a 40-character lowercase commit SHA')"
RUN npm run api:build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ARG RELEASE_SHA
ENV NODE_ENV=production
ENV RELEASE_SHA=${RELEASE_SHA}
LABEL org.opencontainers.image.revision=${RELEASE_SHA}
LABEL ai.clawad.emergency-stop-compatible=true
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/policy ./policy
COPY --chown=node:node server/lib ./server/lib

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
