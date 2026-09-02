package rules

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
)

type Rule struct {
	ID        string   `json:"id"`
	Domains   []string `json:"domains"`
	Domain    string   `json:"domain,omitempty"`
	Type      string   `json:"type"`
	Mode      string   `json:"mode"`
	Value     string   `json:"value"`
	Upstream  string   `json:"upstream"`
	TTL       uint32   `json:"ttl"`
	Enabled   bool     `json:"enabled"`
	Remark    string   `json:"remark"`
	CreatedAt int64    `json:"createdAt"`
	UpdatedAt int64    `json:"updatedAt"`
}

// UnmarshalJSON preserves the Node implementation's compatibility behavior:
// old rules without an enabled field are enabled, while an explicit false is
// still honored.
func (r *Rule) UnmarshalJSON(data []byte) error {
	type plain Rule
	var value struct {
		plain
		Enabled *bool `json:"enabled"`
	}
	value.Enabled = nil
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*r = Rule(value.plain)
	r.Enabled = value.Enabled == nil || *value.Enabled
	return nil
}

type Match struct {
	Rule    Rule
	Pattern string
}

type Store struct {
	mu    sync.RWMutex
	rules []Rule
}

func Load(path string) (*Store, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return &Store{}, nil
	}
	if err != nil {
		return nil, err
	}
	var loaded []Rule
	if err := json.Unmarshal(data, &loaded); err != nil {
		return nil, err
	}
	for i := range loaded {
		if len(loaded[i].Domains) == 0 && loaded[i].Domain != "" {
			loaded[i].Domains = []string{loaded[i].Domain}
		}
		loaded[i].Domain = ""
		for j := range loaded[i].Domains {
			loaded[i].Domains[j] = NormalizeDomain(loaded[i].Domains[j])
		}
	}
	return &Store{rules: loaded}, nil
}

func New(items []Rule) *Store { return &Store{rules: append([]Rule(nil), items...)} }

func (s *Store) Snapshot() []Rule {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Rule(nil), s.rules...)
}

func (s *Store) Find(domain, queryType string) *Match {
	s.mu.RLock()
	defer s.mu.RUnlock()
	domain = NormalizeDomain(domain)
	bestScore := -1
	var best *Match
	for _, rule := range s.rules {
		if !rule.Enabled {
			continue
		}
		if rule.Type != queryType && !(rule.Type == "CNAME" && (queryType == "A" || queryType == "AAAA")) {
			continue
		}
		for _, pattern := range rule.Domains {
			if !matchDomain(pattern, domain) {
				continue
			}
			score := patternScore(pattern)
			if score >= bestScore {
				copy := rule
				best = &Match{Rule: copy, Pattern: pattern}
				bestScore = score
			}
		}
	}
	return best
}

func NormalizeDomain(value string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(value)), ".")
}

func matchDomain(pattern, domain string) bool {
	if strings.HasPrefix(pattern, "*.") {
		return strings.HasSuffix(domain, "."+strings.TrimPrefix(pattern, "*."))
	}
	return domain == pattern || strings.HasSuffix(domain, "."+pattern)
}

func patternScore(pattern string) int {
	plain := 1
	if strings.HasPrefix(pattern, "*.") {
		pattern = strings.TrimPrefix(pattern, "*.")
		plain = 0
	}
	return len(strings.Split(pattern, "."))*10 + plain
}
