package cache

import (
	"sync"
	"time"

	"github.com/miekg/dns"
)

type Result struct {
	Rcode                             int
	Answers, Authorities, Additionals []dns.RR
}

type entry struct {
	result  Result
	expires time.Time
}

type Cache struct {
	mu           sync.Mutex
	max          int
	items        map[string]entry
	order        []string
	hits, misses uint64
}

func New(max int) *Cache {
	if max < 1 {
		max = 1
	}
	return &Cache{max: max, items: make(map[string]entry)}
}

func (c *Cache) Get(key string) (Result, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	if !ok || !time.Now().Before(e.expires) {
		if ok {
			c.remove(key)
		}
		c.misses++
		return Result{}, false
	}
	c.hits++
	c.touch(key)
	remaining := uint32(max(1, int(time.Until(e.expires).Seconds()+0.5)))
	result := cloneResult(e.result)
	for _, rr := range result.Answers {
		if rr.Header().Ttl > remaining {
			rr.Header().Ttl = remaining
		}
	}
	return result, true
}

func (c *Cache) Set(key string, result Result, ttl time.Duration) {
	if ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.items[key]; exists {
		c.remove(key)
	}
	for len(c.items) >= c.max {
		c.remove(c.order[0])
	}
	c.items[key] = entry{result: cloneResult(result), expires: time.Now().Add(ttl)}
	c.order = append(c.order, key)
}

func (c *Cache) Sweep() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for key, e := range c.items {
		if !now.Before(e.expires) {
			c.remove(key)
		}
	}
}

func (c *Cache) Len() int { c.mu.Lock(); defer c.mu.Unlock(); return len(c.items) }

func (c *Cache) touch(key string)  { c.removeOrder(key); c.order = append(c.order, key) }
func (c *Cache) remove(key string) { delete(c.items, key); c.removeOrder(key) }
func (c *Cache) removeOrder(key string) {
	for i, candidate := range c.order {
		if candidate == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			return
		}
	}
}

func cloneResult(source Result) Result {
	return Result{Rcode: source.Rcode, Answers: cloneRRs(source.Answers), Authorities: cloneRRs(source.Authorities), Additionals: cloneRRs(source.Additionals)}
}
func cloneRRs(source []dns.RR) []dns.RR {
	out := make([]dns.RR, len(source))
	for i, rr := range source {
		out[i] = dns.Copy(rr)
	}
	return out
}
