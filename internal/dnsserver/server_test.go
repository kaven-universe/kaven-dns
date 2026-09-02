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

func TestRestartMovesBothTransportsAndRollsBackOnFailure(t *testing.T) {
	first := availablePort(t)
	second := availablePort(t)
	cfg := config.Defaults()
	store := rules.New([]rules.Rule{{Domains: []string{"fixed.test"}, Type: "A", Mode: "fixed", Value: "10.0.0.1", TTL: 60, Enabled: true}})
	server := New(&resolver.Resolver{Rules: store, Cache: cache.New(10), Config: func() config.Config { return cfg }}, history.New(10, 0))
	if err := server.Start("127.0.0.1", first); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Shutdown)
	if err := server.Restart("127.0.0.1", second); err != nil {
		t.Fatal(err)
	}
	queryServer(t, second, "udp")
	queryServer(t, second, "tcp")
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	busyPort := busy.Addr().(*net.TCPAddr).Port
	defer busy.Close()
	if err := server.Restart("127.0.0.1", busyPort); err == nil {
		t.Fatal("restart unexpectedly succeeded")
	}
	queryServer(t, second, "udp")
	queryServer(t, second, "tcp")
	if status := server.Status(); !status.Listening || status.Port != second {
		t.Fatalf("status=%#v", status)
	}
}

func queryServer(t *testing.T, port int, network string) {
	t.Helper()
	message := new(dns.Msg)
	message.SetQuestion("fixed.test.", dns.TypeA)
	client := &dns.Client{Net: network, Timeout: time.Second}
	response, _, err := client.Exchange(message, net.JoinHostPort("127.0.0.1", fmt.Sprint(port)))
	if err != nil {
		t.Fatal(err)
	}
	if response.Rcode != dns.RcodeSuccess || len(response.Answer) != 1 {
		t.Fatalf("response=%#v", response)
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

type testAddress string

func (testAddress) Network() string  { return "udp" }
func (a testAddress) String() string { return string(a) }
func TestTrustsECSOnlyFromLoopback(t *testing.T) {
	message := new(dns.Msg)
	message.SetQuestion("example.com.", dns.TypeA)
	option := &dns.OPT{Hdr: dns.RR_Header{Name: ".", Rrtype: dns.TypeOPT}}
	option.Option = append(option.Option, &dns.EDNS0_SUBNET{Code: dns.EDNS0SUBNET, Family: 1, SourceNetmask: 24, Address: net.ParseIP("192.0.2.0")})
	message.Extra = append(message.Extra, option)
	if got := resolveClientIP(message, testAddress("127.0.0.1:1234")); got != "192.0.2.0/24" {
		t.Fatalf("loopback ECS=%q", got)
	}
	if got := resolveClientIP(message, testAddress("198.51.100.2:1234")); got != "198.51.100.2" {
		t.Fatalf("remote ECS trusted: %q", got)
	}
}
