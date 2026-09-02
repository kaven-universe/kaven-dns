package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/miekg/dns"

	"kaven.xyz/kaven/kaven-dns/internal/auth"
	"kaven.xyz/kaven/kaven-dns/internal/config"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
)

func TestCompiledServerEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping compiled-process smoke test in short mode")
	}
	directory := t.TempDir()
	binary := filepath.Join(directory, "kaven-dns")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	goExecutable := filepath.Join(runtime.GOROOT(), "bin", "go")
	build := exec.Command(goExecutable, "build", "-trimpath", "-ldflags", "-X kaven.xyz/kaven/kaven-dns/internal/buildinfo.Version=9.8.7-test -X kaven.xyz/kaven/kaven-dns/internal/buildinfo.Commit=smoke", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build executable: %v\n%s", err, output)
	}

	dnsPort := availableDNSPort(t)
	webPort := availableTCPPort(t)
	for webPort == dnsPort {
		webPort = availableTCPPort(t)
	}
	cfg := config.Defaults()
	cfg.DNSPort, cfg.WebPort = dnsPort, webPort
	cfg.BindAddress, cfg.WebBindAddress = "127.0.0.1", "127.0.0.1"
	hash, err := auth.HashPassword("smoke-password")
	if err != nil {
		t.Fatal(err)
	}
	cfg.PasswordHash = hash
	if err := config.Save(filepath.Join(directory, "config.json"), cfg); err != nil {
		t.Fatal(err)
	}
	ruleStore, err := rules.Load(filepath.Join(directory, "rules.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ruleStore.Add(rules.Rule{Domains: []string{"smoke.test"}, Type: "A", Mode: "fixed", Value: "10.20.30.40", TTL: 60, Enabled: true}); err != nil {
		t.Fatal(err)
	}

	logPath := filepath.Join(directory, "process.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary)
	command.Stdout, command.Stderr = logFile, logFile
	command.Env = testEnvironment(directory)
	if err := command.Start(); err != nil {
		logFile.Close()
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	t.Cleanup(func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			<-done
		}
		_ = logFile.Close()
	})

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", webPort)
	waitForHTTP(t, baseURL+"/api/setup/status", logPath)
	status, err := http.Get(baseURL + "/api/setup/status")
	if err != nil {
		t.Fatal(err)
	}
	statusBody, _ := io.ReadAll(status.Body)
	status.Body.Close()
	if status.StatusCode != http.StatusOK || !bytes.Contains(statusBody, []byte(`"version":"9.8.7-test"`)) || !bytes.Contains(statusBody, []byte(`"commit":"smoke"`)) {
		t.Fatalf("build version: status=%d body=%s", status.StatusCode, statusBody)
	}
	for _, network := range []string{"udp", "tcp"} {
		message := new(dns.Msg)
		message.SetQuestion("smoke.test.", dns.TypeA)
		response, _, err := (&dns.Client{Net: network, Timeout: 2 * time.Second}).Exchange(message, fmt.Sprintf("127.0.0.1:%d", dnsPort))
		if err != nil {
			t.Fatalf("%s DNS query: %v", network, err)
		}
		if len(response.Answer) != 1 || !strings.Contains(response.Answer[0].String(), "10.20.30.40") {
			t.Fatalf("%s DNS answer: %#v", network, response.Answer)
		}
	}

	login := postJSON(t, baseURL+"/api/auth/login", "", map[string]string{"password": "smoke-password"})
	var loginBody struct {
		Token string `json:"token"`
	}
	if login.status != http.StatusOK || json.Unmarshal(login.body, &loginBody) != nil || loginBody.Token == "" {
		t.Fatalf("login: status=%d body=%s", login.status, login.body)
	}
	stats := getAuthorized(t, baseURL+"/api/stats", loginBody.Token)
	if stats.status != http.StatusOK || !bytes.Contains(stats.body, []byte(`"runtimeName":"Go"`)) || !bytes.Contains(stats.body, []byte(`"cores":`)) {
		t.Fatalf("stats: status=%d body=%s", stats.status, stats.body)
	}
	shutdown := postJSON(t, baseURL+"/api/shutdown", loginBody.Token, nil)
	if shutdown.status != http.StatusOK {
		t.Fatalf("shutdown: status=%d body=%s", shutdown.status, shutdown.body)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("process exit: %v", err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("process did not stop after shutdown request")
	}
	if _, err := os.Stat(filepath.Join(directory, "queries.json")); err != nil {
		t.Fatalf("clean shutdown did not persist query history: %v", err)
	}
}

type httpResult struct {
	status int
	body   []byte
}

func waitForHTTP(t *testing.T, url, logPath string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get(url)
		if err == nil {
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	output, _ := os.ReadFile(logPath)
	t.Fatalf("server did not become ready\n%s", output)
}

func postJSON(t *testing.T, url, token string, value any) httpResult {
	t.Helper()
	data, _ := json.Marshal(value)
	request, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return doHTTP(t, request)
}

func getAuthorized(t *testing.T, url, token string) httpResult {
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, url, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	return doHTTP(t, request)
}

func doHTTP(t *testing.T, request *http.Request) httpResult {
	t.Helper()
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return httpResult{status: response.StatusCode, body: body}
}

func availableDNSPort(t *testing.T) int {
	t.Helper()
	for range 20 {
		tcp, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := tcp.Addr().(*net.TCPAddr).Port
		udp, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			udp.Close()
			tcp.Close()
			return port
		}
		tcp.Close()
	}
	t.Fatal("could not find a free TCP/UDP port")
	return 0
}

func availableTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func testEnvironment(dataDirectory string) []string {
	environment := make([]string, 0, len(os.Environ())+3)
	for _, value := range os.Environ() {
		upper := strings.ToUpper(value)
		if strings.HasPrefix(upper, "KAVEN_DATA_DIR=") || strings.HasPrefix(upper, "KAVEN_DNS_PORT=") || strings.HasPrefix(upper, "KAVEN_WEB_PORT=") {
			continue
		}
		environment = append(environment, value)
	}
	return append(environment, "KAVEN_DATA_DIR="+dataDirectory, "GOMEMLIMIT=64MiB", "GOMAXPROCS=2")
}
