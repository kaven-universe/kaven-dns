Kaven DNS for OpenWrt arm64
===========================

This package requires arm64 OpenWrt and a root shell. It is not an installer
for the standard Xiaomi stock-firmware Web interface.

Install
-------

1. Copy this extracted directory to the router.
2. Run: sh install.sh
3. Verify Kaven DNS before changing dnsmasq:

   nslookup -port=5330 openwrt.org 127.0.0.1

   Some BusyBox nslookup versions do not accept a custom port. In that case,
   check "logread -e kaven-dns" and confirm that TCP and UDP port 5330 are
   listening with "netstat -ln" or "ss -ln".

4. Save the current dnsmasq values so you can restore them if necessary:

   uci -q get dhcp.@dnsmasq[0].noresolv
   uci -q get dhcp.@dnsmasq[0].server

5. Route dnsmasq through Kaven DNS:

   uci set dhcp.@dnsmasq[0].noresolv='1'
   uci -q del_list dhcp.@dnsmasq[0].server='127.0.0.1#5330'
   uci add_list dhcp.@dnsmasq[0].server='127.0.0.1#5330'
   uci set dhcp.@dnsmasq[0].add_subnet='32,128'
   uci commit dhcp
   /etc/init.d/dnsmasq restart

6. Test normal port-53 resolution:

   nslookup openwrt.org 127.0.0.1

7. Open http://<router-address>:8080 and complete first-run setup.

The add_subnet setting lets the Web console attribute relayed queries to the
originating LAN client. If your dnsmasq build does not support it, remove that
option; DNS resolution will still work, but clients may appear as 127.0.0.1.

Low-memory settings
-------------------

The service starts with GOMEMLIMIT=64MiB and GOMAXPROCS=2. Its initial JSON
configuration retains at most 2,000 queries and 1,000 cache entries. Edit
/etc/config/kaven-dns to change the Go runtime limits, then run:

   /etc/init.d/kaven-dns restart

Upgrade and removal
-------------------

Run a newer package's install.sh to upgrade. Existing configuration and data
are retained. Run "sh uninstall.sh" to remove the program and service. The
uninstaller deliberately preserves /etc/kaven-dns and does not modify dnsmasq.

Troubleshooting
---------------

   /etc/init.d/kaven-dns status
   logread -e kaven-dns
   /etc/init.d/kaven-dns restart

If dnsmasq resolution fails, restore the values recorded in step 4 or remove
the forwarding override, then commit and restart dnsmasq:

   uci -q delete dhcp.@dnsmasq[0].noresolv
   uci -q del_list dhcp.@dnsmasq[0].server='127.0.0.1#5330'
   uci -q delete dhcp.@dnsmasq[0].add_subnet
   uci commit dhcp
   /etc/init.d/dnsmasq restart
