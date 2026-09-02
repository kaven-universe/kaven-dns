#!/bin/sh


if pidof kaven-dns >/dev/null 2>&1; then
	exit 0
fi

mkdir -p /tmp/dnsmasq.d
printf '%s\n' 'add-subnet=32,128' >/tmp/dnsmasq.d/kaven-dns-ecs.conf
/etc/init.d/dnsmasq restart >/data/kaven-dns-dnsmasq.log 2>&1 || true

export KAVEN_DATA_DIR=/data/kaven-dns-data
export KAVEN_WEB_PORT=18080
export GOMEMLIMIT=64MiB
export GOMAXPROCS=2

exec /data/kaven-dns >>/data/kaven-dns.log 2>&1
