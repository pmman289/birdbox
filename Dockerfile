FROM node:24-alpine AS web-build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.base.json ./
COPY tsconfig.server.json ./
COPY apps ./apps
COPY packages ./packages
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24-alpine AS bgpq4-build

ARG BGPQ4_VERSION=1.12
ARG BGPQ4_COMMIT=95d3a4c12b18dce45a1fbb62a2327ed302a8f046
RUN apk add --no-cache autoconf automake build-base git libtool \
    && git clone --quiet --depth 1 --branch "${BGPQ4_VERSION}" https://github.com/bgp/bgpq4.git /src/bgpq4 \
    && test "$(git -C /src/bgpq4 rev-parse HEAD)" = "${BGPQ4_COMMIT}" \
    && cd /src/bgpq4 \
    && ./bootstrap \
    && ./configure \
    && make -j"$(getconf _NPROCESSORS_ONLN)" \
    && strip bgpq4

FROM node:24-alpine

ARG BIRDBOX_VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Birdbox" \
      org.opencontainers.image.description="BIRD 2 eBGP management controller" \
      org.opencontainers.image.version="${BIRDBOX_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/pmman289/birdbox"

ENV NODE_ENV=production \
    BIRDBOX_HOST=0.0.0.0 \
    BIRDBOX_PORT=3000 \
    BIRDBOX_DATA_DIR=/var/lib/birdbox \
    BIRDBOX_DB_HOST=db \
    BIRDBOX_DB_PORT=3306 \
    BIRDBOX_DB_NAME=birdbox \
    BIRDBOX_DB_USER=birdbox

RUN apk add --no-cache ca-certificates openssh-client tini \
    && addgroup -S -g 10001 birdbox \
    && adduser -S -D -H -u 10001 -G birdbox -h /var/lib/birdbox -s /sbin/nologin birdbox \
    && install -d -o birdbox -g birdbox -m 0750 /var/lib/birdbox

WORKDIR /app
COPY --from=bgpq4-build /src/bgpq4/bgpq4 /usr/local/bin/bgpq4
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=web-build /app/dist ./dist
COPY --from=web-build /app/public ./public
COPY README.md ./README.md

RUN chown -R birdbox:birdbox /app /var/lib/birdbox
USER birdbox
VOLUME ["/var/lib/birdbox"]
EXPOSE 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.BIRDBOX_PORT + '/api/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/server.js"]
