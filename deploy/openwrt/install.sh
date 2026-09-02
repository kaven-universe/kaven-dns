#!/bin/sh

set -eu

fail() {
	echo "kaven-dns: $*" >&2
	exit 1
}

[ "$(id -u)" -eq 0 ] || fail 'run this installer as root'
[ -f /etc/openwrt_release ] || fail 'this package is intended for OpenWrt'

PACKAGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

case "$(uname -m)" in
	aarch64|arm64) expected_arch='arm64' ;;
	armv7l|armv7|armhf) expected_arch='armv7' ;;
	*) fail "unsupported architecture: $(uname -m) (expected arm64 or armv7)" ;;
esac

case "$(basename "$PACKAGE_DIR")" in
	*_openwrt_arm64) [ "$expected_arch" = 'arm64' ] || fail 'package architecture is arm64, router is armv7' ;;
	*_openwrt_armv7) [ "$expected_arch" = 'armv7' ] || fail 'package architecture is armv7, router is arm64' ;;
esac

[ -f "$PACKAGE_DIR/kaven-dns" ] || fail 'package is missing kaven-dns'
[ -f "$PACKAGE_DIR/kaven-dns.init" ] || fail 'package is missing kaven-dns.init'
[ -f "$PACKAGE_DIR/kaven-dns.uci" ] || fail 'package is missing kaven-dns.uci'
[ -f "$PACKAGE_DIR/config.router.json" ] || fail 'package is missing config.router.json'

if [ -x /etc/init.d/kaven-dns ]; then
	/etc/init.d/kaven-dns stop || true
fi

mkdir -p /etc/kaven-dns
cp "$PACKAGE_DIR/kaven-dns" /usr/bin/.kaven-dns.new
chmod 0755 /usr/bin/.kaven-dns.new
mv /usr/bin/.kaven-dns.new /usr/bin/kaven-dns

cp "$PACKAGE_DIR/kaven-dns.init" /etc/init.d/.kaven-dns.new
chmod 0755 /etc/init.d/.kaven-dns.new
mv /etc/init.d/.kaven-dns.new /etc/init.d/kaven-dns

if [ ! -f /etc/config/kaven-dns ]; then
	cp "$PACKAGE_DIR/kaven-dns.uci" /etc/config/kaven-dns
	chmod 0600 /etc/config/kaven-dns
fi

if [ ! -f /etc/kaven-dns/config.json ]; then
	cp "$PACKAGE_DIR/config.router.json" /etc/kaven-dns/config.json
	chmod 0600 /etc/kaven-dns/config.json
fi

/etc/init.d/kaven-dns enable
/etc/init.d/kaven-dns start

echo 'Kaven DNS is installed and listening on 127.0.0.1:5330.'
echo 'Next, configure dnsmasq as described in README.txt.'
echo 'The Web console will be at http://<router-address>:8080.'
