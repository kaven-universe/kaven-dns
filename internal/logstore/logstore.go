package logstore

import (
	"io"
	"strings"
	"sync"
	"time"
)

type ConsoleEntry struct {
	Time     int64  `json:"t"`
	Level    string `json:"level"`
	Message  string `json:"msg"`
	Sequence uint64 `json:"seq"`
}
type OperationEntry struct {
	Time     int64  `json:"t"`
	Type     string `json:"type"`
	Level    string `json:"level"`
	Message  string `json:"msg"`
	Sequence uint64 `json:"seq"`
}
type Snapshot struct {
	ConsoleLogs   []ConsoleEntry   `json:"consoleLogs"`
	OperationLogs []OperationEntry `json:"operationLogs"`
}
type Store struct {
	mu         sync.RWMutex
	capacity   int
	sequence   uint64
	console    []ConsoleEntry
	operations []OperationEntry
}

func New(capacity int) *Store {
	if capacity < 1 {
		capacity = 1
	}
	return &Store{capacity: capacity}
}
func (s *Store) Writer() io.Writer { return writer{s} }

type writer struct{ store *Store }

func (w writer) Write(data []byte) (int, error) {
	message := strings.TrimSpace(string(data))
	if message != "" {
		w.store.Console("log", message)
	}
	return len(data), nil
}
func (s *Store) Console(level, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sequence++
	s.console = append(s.console, ConsoleEntry{Time: time.Now().UnixMilli(), Level: level, Message: message, Sequence: s.sequence})
	if len(s.console) > s.capacity {
		s.console = append([]ConsoleEntry(nil), s.console[len(s.console)-s.capacity:]...)
	}
}
func (s *Store) Record(kind, message, level string) {
	if level == "" {
		level = "log"
	}
	s.mu.Lock()
	s.sequence++
	s.operations = append(s.operations, OperationEntry{Time: time.Now().UnixMilli(), Type: kind, Level: level, Message: message, Sequence: s.sequence})
	if len(s.operations) > s.capacity {
		s.operations = append([]OperationEntry(nil), s.operations[len(s.operations)-s.capacity:]...)
	}
	s.mu.Unlock()
}
func (s *Store) Snapshot(limit int) Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit < 1 {
		limit = 400
	}
	consoleStart := max(0, len(s.console)-limit)
	operationStart := max(0, len(s.operations)-limit)
	return Snapshot{ConsoleLogs: append([]ConsoleEntry{}, s.console[consoleStart:]...), OperationLogs: append([]OperationEntry{}, s.operations[operationStart:]...)}
}
func (s *Store) Since(sequence uint64) (Snapshot, uint64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snapshot := Snapshot{ConsoleLogs: []ConsoleEntry{}, OperationLogs: []OperationEntry{}}
	for _, entry := range s.console {
		if entry.Sequence > sequence {
			snapshot.ConsoleLogs = append(snapshot.ConsoleLogs, entry)
		}
	}
	for _, entry := range s.operations {
		if entry.Sequence > sequence {
			snapshot.OperationLogs = append(snapshot.OperationLogs, entry)
		}
	}
	return snapshot, s.sequence
}
func (s *Store) Sequence() uint64 { s.mu.RLock(); defer s.mu.RUnlock(); return s.sequence }
