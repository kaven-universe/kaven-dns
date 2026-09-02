package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"

	"kaven.xyz/kaven/kaven-dns/internal/persist"
)

const maxFails = 5

type failure struct {
	Count, Strikes int
	LockedUntil    time.Time
}
type Manager struct {
	mu       sync.Mutex
	sessions map[string]int64
	fails    map[string]failure
	path     string
	ttl      func() time.Duration
	verify   func(string) bool
	now      func() time.Time
	stop     chan struct{}
	dirty    bool
}
type LoginResult struct {
	OK           bool
	Token, Error string
}

func New(path string, ttl func() time.Duration, verify func(string) bool) *Manager {
	m := &Manager{sessions: map[string]int64{}, fails: map[string]failure{}, path: path, ttl: ttl, verify: verify, now: time.Now, stop: make(chan struct{})}
	m.load()
	go m.cleanup()
	return m
}
func (m *Manager) Close() {
	m.mu.Lock()
	if m.dirty {
		_ = m.persistLocked()
	}
	m.mu.Unlock()
	select {
	case <-m.stop:
	default:
		close(m.stop)
	}
}
func (m *Manager) Login(password, ip string) LoginResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	f := m.fails[ip]
	if now.Before(f.LockedUntil) {
		return LoginResult{Error: fmt.Sprintf("Too many attempts; try again in %d seconds", int(f.LockedUntil.Sub(now).Seconds()+0.99))}
	}
	if !m.verify(password) {
		f.Count++
		if f.Count >= maxFails {
			f.Strikes++
			delay := 10 * time.Second * time.Duration(1<<min(f.Strikes-1, 6))
			if delay > 10*time.Minute {
				delay = 10 * time.Minute
			}
			f.LockedUntil = now.Add(delay)
			f.Count = 0
		}
		m.fails[ip] = f
		return LoginResult{Error: "Incorrect password"}
	}
	delete(m.fails, ip)
	token, err := randomHex(24)
	if err != nil {
		return LoginResult{Error: "Unable to create session"}
	}
	m.sessions[token] = now.Add(m.ttl()).UnixMilli()
	m.dirty = true
	_ = m.persistLocked()
	return LoginResult{OK: true, Token: token}
}
func (m *Manager) Check(token string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, ok := m.sessions[token]
	if !ok {
		return false
	}
	if expires < m.now().UnixMilli() {
		delete(m.sessions, token)
		_ = m.persistLocked()
		return false
	}
	m.sessions[token] = m.now().Add(m.ttl()).UnixMilli()
	m.dirty = true
	return true
}
func (m *Manager) Logout(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, token)
	_ = m.persistLocked()
}
func (m *Manager) load() {
	if m.path == "" {
		return
	}
	data, err := os.ReadFile(m.path)
	if err != nil {
		return
	}
	var saved map[string]int64
	if json.Unmarshal(data, &saved) != nil {
		return
	}
	now := m.now().UnixMilli()
	for token, expires := range saved {
		if expires > now {
			m.sessions[token] = expires
		}
	}
}
func (m *Manager) persistLocked() error {
	if m.path == "" {
		m.dirty = false
		return nil
	}
	err := persist.WriteJSON(m.path, m.sessions)
	if err == nil {
		m.dirty = false
	}
	return err
}
func (m *Manager) cleanup() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			m.mu.Lock()
			now := m.now()
			dirty := m.dirty
			for token, expires := range m.sessions {
				if expires < now.UnixMilli() {
					delete(m.sessions, token)
					dirty = true
				}
			}
			for ip, f := range m.fails {
				if !f.LockedUntil.IsZero() && now.After(f.LockedUntil.Add(10*time.Minute)) {
					delete(m.fails, ip)
				}
			}
			if dirty {
				_ = m.persistLocked()
			}
			m.mu.Unlock()
		case <-m.stop:
			return
		}
	}
}

func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	derived, err := scrypt.Key([]byte(password), []byte(hex.EncodeToString(salt)), 16384, 8, 1, 32)
	if err != nil {
		return "", err
	}
	return "scrypt:" + hex.EncodeToString(salt) + ":" + hex.EncodeToString(derived), nil
}
func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, ":")
	if len(parts) == 3 && parts[0] == "scrypt" {
		expected, err := hex.DecodeString(parts[2])
		if err != nil {
			return false
		}
		candidate, err := scrypt.Key([]byte(password), []byte(parts[1]), 16384, 8, 1, 32)
		return err == nil && len(expected) == len(candidate) && subtle.ConstantTimeCompare(expected, candidate) == 1
	}
	if stored == "" {
		return false
	}
	sum := sha256.Sum256([]byte("kaven-dns:" + password))
	expected, err := hex.DecodeString(stored)
	return err == nil && len(expected) == len(sum) && subtle.ConstantTimeCompare(expected, sum[:]) == 1
}
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
