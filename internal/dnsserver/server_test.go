package dnsserver

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"

	"kaven.xyz/kaven/kaven-dns/internal/cache"
	"kaven.xyz/kaven/kaven-dns/internal/config"
	"kaven.xyz/kaven/kaven-dns/internal/history"
	"kaven.xyz/kaven/kaven-dns/internal/resolver"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
)

func TestAnswersUDPAndTCP(t *testing.T) {
	port := availablePort(t)
	cfg := config.Defaults()
	store := rules.New([]rules.Rule{{Domains: []string{"fixed.test"}, Type: "A", Mode: "fixed", Value: "10.0.0.1", TTL: 60, Enabled: true}})
	queries := history.New(10, 0)
	server := New(&resolver.Resolver{Rules: store, Cache: cache.New(10), Config: func() config.Config { return cfg }}, queries)
	if err := server.Start("127.0.0.1", port); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Shutdown)

	endpoint := net.JoinHostPort("127.0.0.1", fmt.Sprint(port))
	for _, network := range []string{"udp", "tcp"} {
		t.Run(network, func(t *testing.T) {
			message := new(dns.Msg)
			message.SetQuestion("fixed.test.", dns.TypeA)
			client := &dns.Client{Net: network, Timeout: time.Second}
			response, _, err := client.ExchangeContext(context.Background(), message, endpoint)
			if err != nil {
				t.Fatal(err)
			}
			if response.Rcode != dns.RcodeSuccess || len(response.Answer) != 1 {
				t.Fatalf("response = %#v", response)
			}
		})
	}
	if queries.Len() != 2 {
		t.Fatalf("query history length = %d", queries.Len())
	}
}

func availablePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}
