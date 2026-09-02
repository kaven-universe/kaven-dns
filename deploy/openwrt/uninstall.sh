#!/bin/sh

set -eu

if [ "$(id -u)" -ne 0 ]; then
	echo 'kaven-dns: run this uninstaller as root' >&2
	exit 1
fi

if [ -x /etc/init.d/kaven-dns ]; then
	/etc/init.d/kaven-dns stop || true
	/etc/init.d/kaven-dns disable || true
fi

rm -f /etc/init.d/kaven-dns /usr/bin/kaven-dns /etc/config/kaven-dns

echo 'Kaven DNS was removed.'
echo 'Persistent data remains in /etc/kaven-dns and was not deleted.'
echo 'Restore the previous dnsmasq settings before restarting dnsmasq.'
