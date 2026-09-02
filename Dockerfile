FROM golang:1.24-alpine AS build

WORKDIR /src

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=""
ARG COMMIT=""

COPY go.mod go.sum ./
RUN go mod download

COPY VERSION ./
COPY cmd ./cmd
COPY internal ./internal

RUN version="${VERSION#v}"; \
    if [ -z "$version" ]; then version="$(cat VERSION)"; fi; \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath \
    -ldflags="-s -w -X kaven.xyz/kaven/kaven-dns/internal/buildinfo.Version=$version -X kaven.xyz/kaven/kaven-dns/internal/buildinfo.Commit=$COMMIT" \
    -o /out/kaven-dns ./cmd/kaven-dns

FROM alpine:3.22

RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 kaven \
    && adduser -S -D -H -u 10001 -G kaven kaven \
    && mkdir -p /app/data \
    && chown kaven:kaven /app/data

WORKDIR /app

COPY --from=build --chown=kaven:kaven /out/kaven-dns /usr/local/bin/kaven-dns

ENV KAVEN_DATA_DIR=/app/data \
    GOMEMLIMIT=128MiB

LABEL org.opencontainers.image.title="kaven-dns" \
    org.opencontainers.image.description="Go DNS server with a Web management console" \
    org.opencontainers.image.authors="Kaven <kaven@wuwenkai.com>"

VOLUME ["/app/data"]
EXPOSE 53/tcp 53/udp 8080/tcp

USER kaven

ENTRYPOINT ["/usr/local/bin/kaven-dns"]
