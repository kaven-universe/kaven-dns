package config

import "testing"

func TestSanitizeUsesRouterBounds(t *testing.T) {
	cfg := Config{DNSPort: 53, WebPort: 8080, BindAddress: "0.0.0.0", WebBindAddress: "0.0.0.0", Upstreams: []string{"1.1.1.1", "[2001:4860:4860::8888]:53"}, ForwardTimeoutMS: 3000, TTLMin: 10, TTLMax: 3600, QueryRetentionDays: 1, QueryHistoryMaxEntries: 10_000, CacheMaxEntries: 2_000, SessionTTLHours: 24}
	cfg.Sanitize()
	if cfg.QueryHistoryMaxEntries != 10_000 {
		t.Fatalf("query limit = %d", cfg.QueryHistoryMaxEntries)
	}
	if cfg.CacheMaxEntries != 2_000 {
		t.Fatalf("cache limit = %d", cfg.CacheMaxEntries)
	}
	if len(cfg.Upstreams) != 2 {
		t.Fatalf("upstreams = %#v", cfg.Upstreams)
	}
}

func TestParseUpstream(t *testing.T) {
	cases := map[string]string{"1.1.1.1": "1.1.1.1:53", "1.1.1.1:5353": "1.1.1.1:5353", "2001:4860:4860::8888": "[2001:4860:4860::8888]:53"}
	for input, expected := range cases {
		actual, err := ParseUpstream(input)
		if err != nil || actual != expected {
			t.Errorf("ParseUpstream(%q) = %q, %v", input, actual, err)
		}
	}
}

func TestLoadAppliesPortEnvironment(t *testing.T) {
	t.Setenv("KAVEN_DNS_PORT", "5353")
	t.Setenv("KAVEN_WEB_PORT", "8181")
	cfg, err := Load(t.TempDir() + "/missing.json")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DNSPort != 5353 || cfg.WebPort != 8181 {
		t.Fatalf("ports = %d, %d", cfg.DNSPort, cfg.WebPort)
	}
}
