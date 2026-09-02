package resolver

import (
	"context"
	"testing"

	"github.com/miekg/dns"

	"kaven.xyz/kaven/kaven-dns/internal/cache"
	"kaven.xyz/kaven/kaven-dns/internal/config"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
)

func testConfig() config.Config {
	cfg := config.Defaults()
	cfg.Upstreams = []string{"192.0.2.53"}
	return cfg
}

func TestFixedAAnswer(t *testing.T) {
	store := rules.New([]rules.Rule{{Domains: []string{"fixed.test"}, Type: "A", Mode: "fixed", Value: "10.0.0.1,10.0.0.2", TTL: 60, Enabled: true}})
	r := &Resolver{Rules: store, Cache: cache.New(10), Config: testConfig}
	result, err := r.Resolve(context.Background(), "fixed.test", dns.TypeA)
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "fixed" || len(result.Answers) != 2 {
		t.Fatalf("result = %#v", result)
	}
}

func TestFixedCNAMEIncludesTargetAnswer(t *testing.T) {
	store := rules.New([]rules.Rule{
		{Domains: []string{"alias.test"}, Type: "CNAME", Mode: "fixed", Value: "target.test", TTL: 60, Enabled: true},
		{Domains: []string{"target.test"}, Type: "A", Mode: "fixed", Value: "10.0.0.9", TTL: 30, Enabled: true},
	})
	r := &Resolver{Rules: store, Cache: cache.New(10), Config: testConfig}
	result, err := r.Resolve(context.Background(), "alias.test", dns.TypeA)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Answers) != 2 {
		t.Fatalf("answers = %#v", result.Answers)
	}
	if _, ok := result.Answers[0].(*dns.CNAME); !ok {
		t.Fatalf("first answer = %T", result.Answers[0])
	}
	if _, ok := result.Answers[1].(*dns.A); !ok {
		t.Fatalf("second answer = %T", result.Answers[1])
	}
}
