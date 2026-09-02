package history

import (
	"sync"
	"time"
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

type Store struct {
	mu        sync.RWMutex
	max       int
	retention time.Duration
	entries   []Entry
	sequence  uint64
}

func New(maxEntries, retentionDays int) *Store {
	if maxEntries < 1 {
		maxEntries = 1
	}
	return &Store{max: maxEntries, retention: time.Duration(retentionDays) * 24 * time.Hour, entries: make([]Entry, 0, min(maxEntries, 1024))}
}

func (s *Store) Record(entry Entry) Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sequence++
	entry.Sequence = s.sequence
	if entry.Time == 0 {
		entry.Time = time.Now().UnixMilli()
	}
	s.entries = append(s.entries, entry)
	s.trimLocked(time.Now())
	return entry
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
		s.entries = s.entries[:len(s.entries)-drop]
	}
}

func (s *Store) List(limit int) []Entry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit < 0 {
		limit = 0
	}
	if limit > len(s.entries) {
		limit = len(s.entries)
	}
	out := make([]Entry, limit)
	for i := range limit {
		out[i] = s.entries[len(s.entries)-1-i]
	}
	return out
}

func (s *Store) Len() int { s.mu.RLock(); defer s.mu.RUnlock(); return len(s.entries) }
