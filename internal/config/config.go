package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"kaven.xyz/kaven/kaven-dns/internal/persist"
)

const (
	DefaultQueryMaxEntries = 10_000
	DefaultCacheMaxEntries = 2_000
)

type Config struct {
	DNSPort                int      `json:"dnsPort"`
	WebPort                int      `json:"webPort"`
	BindAddress            string   `json:"bindAddress"`
	WebBindAddress         string   `json:"webBindAddress"`
	Upstreams              []string `json:"upstreams"`
	ForwardTimeoutMS       int      `json:"forwardTimeoutMs"`
	TTLMin                 int      `json:"ttlMin"`
	TTLMax                 int      `json:"ttlMax"`
	QueryRetentionDays     int      `json:"queryRetentionDays"`
	QueryHistoryMaxEntries int      `json:"queryHistoryMaxEntries"`
	CacheMaxEntries        int      `json:"cacheMaxEntries"`
	SessionTTLHours        int      `json:"sessionTtlHours"`
	PasswordHash           string   `json:"passwordHash"`
}

type Store struct {
	mu    sync.RWMutex
	path  string
	value Config
}

func NewStore(path string, value Config) *Store { return &Store{path: path, value: value} }
func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	value := s.value
	value.Upstreams = append([]string(nil), value.Upstreams...)
	return value
}
func (s *Store) Update(change func(*Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.value
	next.Upstreams = append([]string(nil), next.Upstreams...)
	if err := change(&next); err != nil {
		return err
	}
	next.Sanitize()
	if err := Save(s.path, next); err != nil {
		return err
	}
	s.value = next
	return nil
}
func (s *Store) Replace(value Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	value.Sanitize()
	if err := Save(s.path, value); err != nil {
		return err
	}
	s.value = value
	return nil
}

func Defaults() Config {
	return Config{
		DNSPort: 53, WebPort: 8080,
		BindAddress: "0.0.0.0", WebBindAddress: "0.0.0.0",
		Upstreams:        []string{"223.5.5.5", "119.29.29.29"},
		ForwardTimeoutMS: 3000, TTLMin: 10, TTLMax: 3600,
		QueryRetentionDays: 1, QueryHistoryMaxEntries: DefaultQueryMaxEntries,
		CacheMaxEntries: DefaultCacheMaxEntries, SessionTTLHours: 24,
	}
}

func DataDir() string {
	if value := os.Getenv("KAVEN_DATA_DIR"); value != "" {
		if absolute, err := filepath.Abs(value); err == nil {
			return absolute
		}
	}
	return "data"
}

func Load(path string) (Config, error) {
	cfg := Defaults()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		applyEnvironment(&cfg)
		cfg.Sanitize()
		return cfg, nil
	}
	if err != nil {
		return Config{}, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	applyEnvironment(&cfg)
	cfg.Sanitize()
	return cfg, nil
}

func Save(path string, cfg Config) error {
	cfg.Sanitize()
	return persist.WriteJSON(path, cfg)
}

func applyEnvironment(cfg *Config) {
	if value := os.Getenv("KAVEN_DNS_PORT"); value != "" {
		if port, err := strconv.Atoi(value); err == nil {
			cfg.DNSPort = port
		}
	}
	if value := os.Getenv("KAVEN_WEB_PORT"); value != "" {
		if port, err := strconv.Atoi(value); err == nil {
			cfg.WebPort = port
		}
	}
}

func (c *Config) Sanitize() {
	defaults := Defaults()
	c.DNSPort = clamp(c.DNSPort, 1, 65535, defaults.DNSPort)
	c.WebPort = clamp(c.WebPort, 1, 65535, defaults.WebPort)
	if net.ParseIP(c.BindAddress) == nil {
		c.BindAddress = defaults.BindAddress
	}
	if net.ParseIP(c.WebBindAddress) == nil {
		c.WebBindAddress = defaults.WebBindAddress
	}
	valid := c.Upstreams[:0]
	for _, upstream := range c.Upstreams {
		upstream = strings.TrimSpace(upstream)
		if _, err := ParseUpstream(upstream); err == nil {
			valid = append(valid, upstream)
		}
	}
	if len(valid) == 0 {
		valid = append([]string(nil), defaults.Upstreams...)
	}
	if len(valid) > 8 {
		valid = valid[:8]
	}
	c.Upstreams = valid
	c.ForwardTimeoutMS = clamp(c.ForwardTimeoutMS, 500, 30000, defaults.ForwardTimeoutMS)
	c.TTLMin = clamp(c.TTLMin, 1, 3600, defaults.TTLMin)
	c.TTLMax = clamp(c.TTLMax, c.TTLMin, 86400, defaults.TTLMax)
	c.QueryRetentionDays = clamp(c.QueryRetentionDays, 0, 30, defaults.QueryRetentionDays)
	c.QueryHistoryMaxEntries = clamp(c.QueryHistoryMaxEntries, 100, 1_000_000, defaults.QueryHistoryMaxEntries)
	c.CacheMaxEntries = clamp(c.CacheMaxEntries, 100, 100_000, defaults.CacheMaxEntries)
	c.SessionTTLHours = clamp(c.SessionTTLHours, 1, 720, defaults.SessionTTLHours)
}

func ParseUpstream(value string) (string, error) {
	if net.ParseIP(value) != nil {
		return net.JoinHostPort(value, "53"), nil
	}
	host, port, err := net.SplitHostPort(value)
	if err != nil || net.ParseIP(host) == nil {
		return "", fmt.Errorf("invalid upstream %q", value)
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("invalid upstream %q", value)
	}
	return net.JoinHostPort(host, port), nil
}

func clamp(value, min, max, fallback int) int {
	if value < min || value > max {
		return fallback
	}
	return value
}
