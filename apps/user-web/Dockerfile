ARG CADDY_IMAGE=caddy:2.10.0-alpine
FROM ${CADDY_IMAGE}

ARG RELEASE_SHA
RUN test -n "$RELEASE_SHA"

LABEL org.opencontainers.image.revision=$RELEASE_SHA

COPY deploy/production/Caddyfile /etc/caddy/Caddyfile
COPY apps/user-web/Caddyfile /etc/caddy/user-web.Caddyfile
COPY apps/user-web/index.html apps/user-web/install.html apps/user-web/survey.html apps/user-web/session-client.js apps/user-web/games.js apps/user-web/solitaire-solver.js apps/user-web/solitaire-worker.js apps/user-web/logo.png apps/user-web/adward-face.png apps/user-web/mascot.svg apps/user-web/mascot-working.svg apps/user-web/mascot-building.svg /srv/
COPY apps/user-web/creative /srv/creative
COPY apps/user-web/icons /srv/icons
RUN mkdir -p /srv/legal

HEALTHCHECK --interval=10s --timeout=5s --retries=20 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
