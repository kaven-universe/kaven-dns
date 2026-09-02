package rules

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"kaven.xyz/kaven/kaven-dns/internal/config"
	"kaven.xyz/kaven/kaven-dns/internal/persist"
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
	path  string
}

func Load(path string) (*Store, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return &Store{path: path}, nil
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
	return &Store{rules: loaded, path: path}, nil
}

func New(items []Rule) *Store { return &Store{rules: append([]Rule(nil), items...)} }

func (s *Store) Add(rule Rule) (Rule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixMilli()
	if rule.ID == "" {
		rule.ID = newID()
	}
	rule.CreatedAt = now
	rule.UpdatedAt = now
	s.rules = append(s.rules, rule)
	return rule, s.persistLocked()
}
func (s *Store) Update(id string, rule Rule) (Rule, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.rules {
		if s.rules[i].ID == id {
			rule.ID = id
			rule.CreatedAt = s.rules[i].CreatedAt
			rule.UpdatedAt = time.Now().UnixMilli()
			s.rules[i] = rule
			return rule, true, s.persistLocked()
		}
	}
	return Rule{}, false, nil
}
func (s *Store) Remove(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.rules {
		if s.rules[i].ID == id {
			s.rules = append(s.rules[:i], s.rules[i+1:]...)
			return true, s.persistLocked()
		}
	}
	return false, nil
}
func (s *Store) ReplaceAll(items []Rule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rules = append([]Rule(nil), items...)
	return s.persistLocked()
}
func (s *Store) persistLocked() error {
	if s.path == "" {
		return nil
	}
	return persist.WriteJSON(s.path, s.rules)
}

var domainRE = regexp.MustCompile(`^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

func Validate(rule Rule) (Rule, []string) {
	var problems []string
	seen := map[string]bool{}
	var domains []string
	for _, raw := range rule.Domains {
		for _, part := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t' }) {
			d := NormalizeDomain(part)
			if d != "" && !seen[d] {
				seen[d] = true
				domains = append(domains, d)
			}
		}
	}
	rule.Domains = domains
	if len(domains) == 0 {
		problems = append(problems, "At least one domain is required")
	} else if len(domains) > 500 {
		problems = append(problems, "At most 500 domains per rule")
	} else {
		for _, d := range domains {
			if len(d) > 253 || !domainRE.MatchString(d) {
				problems = append(problems, "Invalid domain: "+d)
				break
			}
		}
	}
	if rule.Type != "A" && rule.Type != "AAAA" && rule.Type != "CNAME" {
		problems = append(problems, "Unsupported record type")
	}
	if rule.Mode != "fixed" && rule.Mode != "forward" {
		problems = append(problems, "Unsupported rule mode")
	}
	if rule.TTL < 1 || rule.TTL > 86400 {
		problems = append(problems, "TTL must be between 1 and 86400")
	}
	if rule.Upstream != "" {
		if _, err := config.ParseUpstream(rule.Upstream); err != nil {
			problems = append(problems, "Invalid upstream")
		}
	}
	if rule.Mode == "fixed" {
		values := strings.FieldsFunc(rule.Value, func(r rune) bool { return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t' })
		if len(values) == 0 {
			problems = append(problems, "A fixed answer is required")
		}
		for _, v := range values {
			if rule.Type == "A" && net.ParseIP(v).To4() == nil {
				problems = append(problems, "A records require IPv4 addresses")
				break
			}
			if rule.Type == "AAAA" && (net.ParseIP(v) == nil || net.ParseIP(v).To4() != nil) {
				problems = append(problems, "AAAA records require IPv6 addresses")
				break
			}
		}
		if rule.Type == "CNAME" && (len(values) != 1 || !domainRE.MatchString(NormalizeDomain(rule.Value))) {
			problems = append(problems, "CNAME requires one hostname")
		}
	}
	rule.Remark = strings.TrimSpace(rule.Remark)
	if len(rule.Remark) > 200 {
		rule.Remark = rule.Remark[:200]
	}
	return rule, problems
}
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

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
