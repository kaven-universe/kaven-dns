package rules

import (
	"encoding/json"
	"testing"
)

func TestFindPreservesSpecificityAndNewerTieBreaking(t *testing.T) {
	store := New([]Rule{
		{Domains: []string{"example.com"}, Type: "A", Mode: "fixed", Enabled: true},
		{Domains: []string{"*.deep.example.com"}, Type: "A", Mode: "fixed", Enabled: true},
		{Domains: []string{"deep.example.com"}, Type: "A", Mode: "fixed", Enabled: true},
	})
	match := store.Find("host.deep.example.com", "A")
	if match == nil || match.Pattern != "deep.example.com" {
		t.Fatalf("unexpected match: %#v", match)
	}
}

func TestWildcardDoesNotMatchApex(t *testing.T) {
	store := New([]Rule{{Domains: []string{"*.example.com"}, Type: "A", Enabled: true}})
	if match := store.Find("example.com", "A"); match != nil {
		t.Fatalf("wildcard matched apex: %#v", match)
	}
}

func TestMissingEnabledFieldDefaultsToTrue(t *testing.T) {
	var rule Rule
	if err := json.Unmarshal([]byte(`{"domains":["example.com"],"type":"A"}`), &rule); err != nil {
		t.Fatal(err)
	}
	if !rule.Enabled {
		t.Fatal("legacy rule was disabled")
	}
	if err := json.Unmarshal([]byte(`{"domains":["example.com"],"type":"A","enabled":false}`), &rule); err != nil {
		t.Fatal(err)
	}
	if rule.Enabled {
		t.Fatal("explicit false was ignored")
	}
}
