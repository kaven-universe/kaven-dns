FROM node:22-alpine AS dependencies

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@9.15.9
RUN pnpm install --prod --frozen-lockfile


FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node src ./src

RUN mkdir -p /app/data \
    && chown node:node /app/data

ENV NODE_ENV=production \
    KAVEN_DATA_DIR=/app/data

LABEL org.opencontainers.image.title="kaven-dns" \
    org.opencontainers.image.description="Node.js DNS server with a Web management console" \
    org.opencontainers.image.version="1.2.0" \
    org.opencontainers.image.authors="Kaven <kaven@wuwenkai.com>"

VOLUME ["/app/data"]
EXPOSE 53/tcp 53/udp 8080/tcp

USER node

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "src/index.js"]
