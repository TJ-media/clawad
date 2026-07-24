ARG CADDY_IMAGE=caddy:2.10.0-alpine
FROM ${CADDY_IMAGE}

ARG RELEASE_SHA
RUN test -n "$RELEASE_SHA"

LABEL org.opencontainers.image.revision=$RELEASE_SHA

COPY deploy/production/Caddyfile /etc/caddy/Caddyfile
COPY apps/admin-web/Caddyfile /etc/caddy/admin-web.Caddyfile
COPY apps/admin-web/index.html apps/admin-web/mascot.svg /srv/

HEALTHCHECK --interval=10s --timeout=5s --retries=20 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
