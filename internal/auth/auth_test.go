package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

func TestHashIsCompatibleAndSalted(t *testing.T) {
	first, err := HashPassword("correct")
	if err != nil {
		t.Fatal(err)
	}
	second, _ := HashPassword("correct")
	if first == second {
		t.Fatal("hashes reused salt")
	}
	if !VerifyPassword("correct", first) || VerifyPassword("wrong", first) {
		t.Fatal("password verification mismatch")
	}
}
func TestLegacyHash(t *testing.T) {
	sum := sha256.Sum256([]byte("kaven-dns:secret"))
	if !VerifyPassword("secret", hex.EncodeToString(sum[:])) {
		t.Fatal("legacy hash rejected")
	}
}
func TestLoginIssuesSession(t *testing.T) {
	m := New("", func() time.Duration { return time.Minute }, func(password string) bool { return password == "correct" })
	defer m.Close()
	result := m.Login("correct", "127.0.0.1")
	if !result.OK || !m.Check(result.Token) {
		t.Fatalf("result=%#v", result)
	}
	m.Logout(result.Token)
	if m.Check(result.Token) {
		t.Fatal("logout failed")
	}
}

func TestSlidingSessionPersistsOnClose(t *testing.T) {
	path := t.TempDir() + "/sessions.json"
	ttl := func() time.Duration { return time.Hour }
	verify := func(password string) bool { return password == "correct" }
	first := New(path, ttl, verify)
	token := first.Login("correct", "127.0.0.1").Token
	if !first.Check(token) {
		t.Fatal("session missing")
	}
	first.Close()
	second := New(path, ttl, verify)
	defer second.Close()
	if !second.Check(token) {
		t.Fatal("persisted session missing")
	}
}
