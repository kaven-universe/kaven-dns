package history

import (
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"kaven.xyz/kaven/kaven-dns/internal/persist"
)

type Entry struct {
	Time      int64  `json:"t"`
	Sequence  uint64 `json:"seq"`
	Client    string `json:"client"`
	Domain    string `json:"domain"`
	Type      string `json:"type"`
	Source    string `json:"source"`
	Rcode     int    `json:"rcode"`
	LatencyMS int64  `json:"latencyMs"`
	Answers   string `json:"answers"`
	Rule      string `json:"rule"`
	Upstream  string `json:"upstream"`
	Error     string `json:"error"`
}
type Stats struct {
	StartedAt        int64   `json:"startedAt"`
	Total            uint64  `json:"total"`
	Fixed            uint64  `json:"fixed"`
	Cache            uint64  `json:"cache"`
	Forward          uint64  `json:"forward"`
	Servfail         uint64  `json:"servfail"`
	NXDomain         uint64  `json:"nxdomain"`
	TotalLatencyMS   int64   `json:"totalLatencyMs"`
	ForwardLatencyMS int64   `json:"forwardLatencyMs"`
	UptimeMS         int64   `json:"uptimeMs"`
	AvgLatencyMS     float64 `json:"avgLatencyMs"`
	ForwardAvgMS     float64 `json:"forwardAvgMs"`
}
type Filter struct {
	Limit                                      int
	Domain, Source, Status, Type, Client, Rule string
	Since, Until                               int64
}
type Store struct {
	mu        sync.RWMutex
	max       int
	retention time.Duration
	entries   []Entry
	sequence  uint64
	stats     Stats
	path      string
}

func New(maxEntries, retentionDays int) *Store {
	if maxEntries < 1 {
		maxEntries = 1
	}
	return &Store{max: maxEntries, retention: time.Duration(retentionDays) * 24 * time.Hour, entries: make([]Entry, 0, min(maxEntries, 1024)), stats: Stats{StartedAt: time.Now().UnixMilli()}}
}

func Load(path string, maxEntries, retentionDays int) (*Store, error) {
	store := New(maxEntries, retentionDays)
	store.path = path
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	var snapshot struct {
		Entries  []Entry `json:"entries"`
		Stats    Stats   `json:"stats"`
		Sequence uint64  `json:"sequence"`
	}
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, err
	}
	store.entries, store.stats, store.sequence = snapshot.Entries, snapshot.Stats, snapshot.Sequence
	if store.stats.StartedAt == 0 {
		store.stats.StartedAt = time.Now().UnixMilli()
	}
	store.trimLocked(time.Now())
	return store, nil
}

func (s *Store) Persist() error {
	s.mu.RLock()
	snapshot := struct {
		Entries  []Entry `json:"entries"`
		Stats    Stats   `json:"stats"`
		Sequence uint64  `json:"sequence"`
	}{append([]Entry(nil), s.entries...), s.stats, s.sequence}
	path := s.path
	s.mu.RUnlock()
	if path == "" {
		return nil
	}
	return persist.WriteJSON(path, snapshot)
}
func (s *Store) Record(e Entry) Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sequence++
	e.Sequence = s.sequence
	if e.Time == 0 {
		e.Time = time.Now().UnixMilli()
	}
	s.entries = append(s.entries, e)
	s.stats.Total++
	s.stats.TotalLatencyMS += e.LatencyMS
	switch e.Source {
	case "fixed":
		s.stats.Fixed++
	case "cache":
		s.stats.Cache++
	case "forward":
		s.stats.Forward++
		s.stats.ForwardLatencyMS += e.LatencyMS
	}
	if e.Rcode == 2 {
		s.stats.Servfail++
	}
	if e.Rcode == 3 {
		s.stats.NXDomain++
	}
	s.trimLocked(time.Now())
	return e
}
func (s *Store) trimLocked(now time.Time) {
	drop := max(0, len(s.entries)-s.max)
	if s.retention > 0 {
		cutoff := now.Add(-s.retention).UnixMilli()
		for drop < len(s.entries) && s.entries[drop].Time < cutoff {
			drop++
		}
	}
	if drop > 0 {
		copy(s.entries, s.entries[drop:])
		clear(s.entries[len(s.entries)-drop:])
		s.entries = s.entries[:len(s.entries)-drop]
	}
}
func (s *Store) List(limit int) []Entry { return s.Search(Filter{Limit: limit}) }
func (s *Store) Search(f Filter) []Entry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if f.Limit < 1 {
		f.Limit = 200
	}
	out := make([]Entry, 0, min(f.Limit, len(s.entries)))
	domain := strings.ToLower(strings.TrimSpace(f.Domain))
	for i := len(s.entries) - 1; i >= 0 && len(out) < f.Limit; i-- {
		e := s.entries[i]
		if domain != "" && !strings.Contains(e.Domain, domain) {
			continue
		}
		if f.Source != "" && e.Source != f.Source {
			continue
		}
		if f.Status == "ok" && e.Rcode != 0 {
			continue
		}
		if f.Status == "fail" && e.Rcode == 0 {
			continue
		}
		if f.Type != "" && e.Type != f.Type {
			continue
		}
		if f.Client != "" && e.Client != f.Client {
			continue
		}
		if f.Rule != "" && e.Rule != f.Rule && e.Upstream != f.Rule && e.Error != f.Rule {
			continue
		}
		if f.Since > 0 && e.Time < f.Since {
			continue
		}
		if f.Until > 0 && e.Time > f.Until {
			continue
		}
		out = append(out, e)
	}
	return out
}
func (s *Store) Len() int { s.mu.RLock(); defer s.mu.RUnlock(); return len(s.entries) }
func (s *Store) Reset() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.entries)
	s.entries = nil
	s.stats = Stats{StartedAt: time.Now().UnixMilli()}
	return n
}
func (s *Store) SetLimits(maxEntries, retentionDays int) {
	if maxEntries < 1 {
		maxEntries = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.max = maxEntries
	s.retention = time.Duration(retentionDays) * 24 * time.Hour
	s.trimLocked(time.Now())
}
func (s *Store) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v := s.stats
	v.UptimeMS = time.Now().UnixMilli() - v.StartedAt
	if v.Total > 0 {
		v.AvgLatencyMS = float64(v.TotalLatencyMS) / float64(v.Total)
	}
	if v.Forward > 0 {
		v.ForwardAvgMS = float64(v.ForwardLatencyMS) / float64(v.Forward)
	}
	return v
}

type RankedDomain struct {
	Domain   string `json:"domain"`
	Count    int    `json:"count"`
	Failures int    `json:"failures"`
}
type RankedClient struct {
	Client   string `json:"client"`
	Count    int    `json:"count"`
	Failures int    `json:"failures"`
	LastSeen int64  `json:"lastSeen"`
}
type Bucket struct {
	Time         int64   `json:"t"`
	Total        int     `json:"total"`
	Failures     int     `json:"failures"`
	AvgLatencyMS float64 `json:"avgLatencyMs"`
	latency      int64
}
type Analytics struct {
	Trend struct {
		WindowMinutes int      `json:"windowMinutes"`
		BucketMinutes int      `json:"bucketMinutes"`
		Buckets       []Bucket `json:"buckets"`
	} `json:"trend"`
	TopDomains        []RankedDomain `json:"topDomains"`
	ActiveClients     []RankedClient `json:"activeClients"`
	TopDomainCount    int            `json:"topDomainCount"`
	ActiveClientCount int            `json:"activeClientCount"`
	ActiveMinutes     int            `json:"activeMinutes"`
	SampledQueries    int            `json:"sampledQueries"`
	RetainedQueries   int            `json:"retainedQueries"`
}

func (s *Store) Analytics() Analytics {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now()
	start := now.Add(-60 * time.Minute).UnixMilli()
	active := now.Add(-5 * time.Minute).UnixMilli()
	bucketMS := int64(5 * time.Minute / time.Millisecond)
	const count = 12
	var out Analytics
	out.Trend.WindowMinutes = 60
	out.Trend.BucketMinutes = 5
	out.Trend.Buckets = make([]Bucket, count)
	out.ActiveMinutes = 5
	out.RetainedQueries = len(s.entries)
	for i := range count {
		out.Trend.Buckets[i].Time = start + int64(i)*bucketMS
	}
	domains := map[string]*RankedDomain{}
	clients := map[string]*RankedClient{}
	for _, e := range s.entries {
		if e.Time >= start {
			idx := int((e.Time - start) / bucketMS)
			if idx >= 0 && idx < count {
				b := &out.Trend.Buckets[idx]
				b.Total++
				b.latency += e.LatencyMS
				if e.Rcode != 0 {
					b.Failures++
				}
				out.SampledQueries++
				d := domains[e.Domain]
				if d == nil {
					d = &RankedDomain{Domain: e.Domain}
					domains[e.Domain] = d
				}
				d.Count++
				if e.Rcode != 0 {
					d.Failures++
				}
			}
		}
		if e.Time >= active && e.Client != "" && e.Client != "web-ui" {
			c := clients[e.Client]
			if c == nil {
				c = &RankedClient{Client: e.Client}
				clients[e.Client] = c
			}
			c.Count++
			if e.Rcode != 0 {
				c.Failures++
			}
			if e.Time > c.LastSeen {
				c.LastSeen = e.Time
			}
		}
	}
	for i := range out.Trend.Buckets {
		b := &out.Trend.Buckets[i]
		if b.Total > 0 {
			b.AvgLatencyMS = float64(b.latency) / float64(b.Total)
		}
	}
	for _, d := range domains {
		out.TopDomains = append(out.TopDomains, *d)
	}
	for _, c := range clients {
		out.ActiveClients = append(out.ActiveClients, *c)
	}
	sort.Slice(out.TopDomains, func(i, j int) bool { return out.TopDomains[i].Count > out.TopDomains[j].Count })
	sort.Slice(out.ActiveClients, func(i, j int) bool { return out.ActiveClients[i].Count > out.ActiveClients[j].Count })
	out.TopDomainCount = len(out.TopDomains)
	out.ActiveClientCount = len(out.ActiveClients)
	if len(out.TopDomains) > 500 {
		out.TopDomains = out.TopDomains[:500]
	}
	if len(out.ActiveClients) > 500 {
		out.ActiveClients = out.ActiveClients[:500]
	}
	return out
}
