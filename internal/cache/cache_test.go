package cache

import (
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func answer(address string, ttl uint32) Result {
	return Result{Answers: []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: "example.com.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: ttl}, A: net.ParseIP(address).To4()}}}
}

func TestCacheEvictsLeastRecentlyUsed(t *testing.T) {
	c := New(2)
	c.Set("a", answer("192.0.2.1", 60), time.Minute)
	c.Set("b", answer("192.0.2.2", 60), time.Minute)
	if _, ok := c.Get("a"); !ok {
		t.Fatal("expected a")
	}
	c.Set("c", answer("192.0.2.3", 60), time.Minute)
	if _, ok := c.Get("b"); ok {
		t.Fatal("expected b to be evicted")
	}
	if c.Len() != 2 {
		t.Fatalf("cache length = %d", c.Len())
	}
}

func TestCacheReturnsCopies(t *testing.T) {
	c := New(1)
	c.Set("a", answer("192.0.2.1", 60), time.Minute)
	first, _ := c.Get("a")
	first.Answers[0].Header().Ttl = 1
	second, _ := c.Get("a")
	if second.Answers[0].Header().Ttl == 1 {
		t.Fatal("caller mutated cached record")
	}
}
