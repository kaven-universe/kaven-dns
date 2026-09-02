package web

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"kaven.xyz/kaven/kaven-dns/internal/auth"
	"kaven.xyz/kaven/kaven-dns/internal/cache"
	"kaven.xyz/kaven/kaven-dns/internal/config"
	"kaven.xyz/kaven/kaven-dns/internal/history"
	"kaven.xyz/kaven/kaven-dns/internal/resolver"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
)

func testServer(t *testing.T) (*httptest.Server, *auth.Manager) {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Defaults()
	hash, err := auth.HashPassword("correct")
	if err != nil {
		t.Fatal(err)
	}
	cfg.PasswordHash = hash
	cfgStore := config.NewStore(filepath.Join(dir, "config.json"), cfg)
	ruleStore, err := rules.Load(filepath.Join(dir, "rules.json"))
	if err != nil {
		t.Fatal(err)
	}
	queries := history.New(20, 0)
	dnsCache := cache.New(20)
	dnsResolver := &resolver.Resolver{Rules: ruleStore, Cache: dnsCache, Config: cfgStore.Get}
	manager := auth.New(filepath.Join(dir, "sessions.json"), func() time.Duration { return time.Hour }, func(password string) bool { return auth.VerifyPassword(password, cfgStore.Get().PasswordHash) })
	service := New(Dependencies{Config: cfgStore, Rules: ruleStore, History: queries, Cache: dnsCache, Resolver: dnsResolver, Auth: manager, DNSStatus: func() any { return map[string]any{"listening": true} }})
	server := httptest.NewServer(service.http.Handler)
	t.Cleanup(func() { server.Close(); manager.Close() })
	return server, manager
}

func TestServesEmbeddedConsoleAndProtectsAPI(t *testing.T) {
	server, _ := testServer(t)
	response, err := http.Get(server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !bytes.Contains(body, []byte("Kaven DNS")) {
		t.Fatalf("console status=%d", response.StatusCode)
	}
	response, err = http.Get(server.URL + "/api/stats")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 401 {
		t.Fatalf("stats status=%d", response.StatusCode)
	}
	response.Body.Close()
}

func TestLoginRuleCRUDAndConfigPrivacy(t *testing.T) {
	server, _ := testServer(t)
	login := requestJSON(t, "POST", server.URL+"/api/auth/login", "", map[string]any{"password": "correct"})
	if login.status != 200 {
		t.Fatalf("login=%d %s", login.status, login.body)
	}
	var loginBody map[string]string
	if json.Unmarshal(login.body, &loginBody) != nil {
		t.Fatal("invalid login response")
	}
	token := loginBody["token"]
	created := requestJSON(t, "POST", server.URL+"/api/rules", token, map[string]any{"domains": []string{"fixed.test"}, "type": "A", "mode": "fixed", "value": "10.0.0.1", "ttl": 60, "enabled": true})
	if created.status != 201 {
		t.Fatalf("create=%d %s", created.status, created.body)
	}
	listed := requestJSON(t, "GET", server.URL+"/api/rules", token, nil)
	if listed.status != 200 || !bytes.Contains(listed.body, []byte("fixed.test")) {
		t.Fatalf("rules=%d %s", listed.status, listed.body)
	}
	cfg := requestJSON(t, "GET", server.URL+"/api/config", token, nil)
	if bytes.Contains(cfg.body, []byte("passwordHash")) || !bytes.Contains(cfg.body, []byte("hasPassword")) {
		t.Fatalf("config leaked or incomplete: %s", cfg.body)
	}
	changed := requestJSON(t, "PUT", server.URL+"/api/config", token, map[string]any{"dnsPort": 5353})
	if changed.status != 200 || !bytes.Contains(changed.body, []byte(`"restartRequired":true`)) {
		t.Fatalf("config change=%d %s", changed.status, changed.body)
	}
}

func TestQueryResetAndInitialEventSnapshot(t *testing.T) {
	server, manager := testServer(t)
	token := manager.Login("correct", "127.0.0.1").Token
	reset := requestJSON(t, "POST", server.URL+"/api/queries/reset", token, nil)
	if reset.status != 200 {
		t.Fatalf("reset=%d %s", reset.status, reset.body)
	}
	request, _ := http.NewRequest("GET", server.URL+"/api/events", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 8192)
	n, err := response.Body.Read(buffer)
	response.Body.Close()
	if err != nil && err != io.EOF {
		t.Fatal(err)
	}
	text := string(buffer[:n])
	if response.StatusCode != 200 || !strings.Contains(text, "event: snapshot") || !strings.Contains(text, "\"queries\":[]") {
		t.Fatalf("event response=%d %q", response.StatusCode, text)
	}
}

type apiResponse struct {
	status int
	body   []byte
}

func requestJSON(t *testing.T, method, url, token string, body any) apiResponse {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return apiResponse{response.StatusCode, data}
}
