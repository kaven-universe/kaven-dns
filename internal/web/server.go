package web

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"

	"kaven.xyz/kaven/kaven-dns/internal/auth"
	"kaven.xyz/kaven/kaven-dns/internal/buildinfo"
	"kaven.xyz/kaven/kaven-dns/internal/cache"
	"kaven.xyz/kaven/kaven-dns/internal/config"
	"kaven.xyz/kaven/kaven-dns/internal/history"
	"kaven.xyz/kaven/kaven-dns/internal/logstore"
	"kaven.xyz/kaven/kaven-dns/internal/resolver"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
	"kaven.xyz/kaven/kaven-dns/internal/systeminfo"
	"kaven.xyz/kaven/kaven-dns/internal/update"
	webassets "kaven.xyz/kaven/kaven-dns/src/web"
)

type Dependencies struct {
	Config        *config.Store
	Rules         *rules.Store
	History       *history.Store
	Cache         *cache.Cache
	Resolver      *resolver.Resolver
	Auth          *auth.Manager
	Logs          *logstore.Store
	DNSStatus     func() any
	ApplyDNS      func(string, int) error
	Shutdown      func()
	UpdateChecker func(context.Context) (update.Result, error)
	System        SystemMonitor
}

type SystemMonitor interface {
	Snapshot() systeminfo.Snapshot
}

type Server struct {
	deps       Dependencies
	mu         sync.RWMutex
	http       *http.Server
	listener   net.Listener
	address    string
	port       int
	eventSlots chan struct{}
}

func New(deps Dependencies) *Server {
	if deps.UpdateChecker == nil {
		deps.UpdateChecker = func(ctx context.Context) (update.Result, error) {
			return update.Check(ctx, nil, buildinfo.StableVersion())
		}
	}
	if deps.System == nil {
		deps.System = systeminfo.New()
	}
	s := &Server{deps: deps, eventSlots: make(chan struct{}, 4)}
	mux := http.NewServeMux()
	s.routes(mux)
	s.http = &http.Server{Handler: securityHeaders(mux), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	return s
}
func (s *Server) Start(address string, port int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startLocked(address, port)
}
func (s *Server) startLocked(address string, port int) error {
	listener, err := net.Listen("tcp", net.JoinHostPort(address, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	s.listener = listener
	s.address, s.port = address, port
	go func() { _ = s.http.Serve(listener) }()
	return nil
}
func (s *Server) Shutdown(ctx context.Context) error { return s.http.Shutdown(ctx) }
func (s *Server) Addr() net.Addr {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.listener == nil {
		return nil
	}
	return s.listener.Addr()
}
func (s *Server) Move(address string, port int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener != nil && s.address == address && s.port == port {
		return nil
	}
	old, oldAddress, oldPort := s.listener, s.address, s.port
	if old != nil {
		_ = old.Close()
	}
	if err := s.startLocked(address, port); err == nil {
		return nil
	}
	rollbackErr := s.startLocked(oldAddress, oldPort)
	if rollbackErr != nil {
		return fmt.Errorf("move Web listener failed and rollback failed: %w", rollbackErr)
	}
	return fmt.Errorf("move Web listener: address or port is unavailable")
}

func (s *Server) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/setup/status", s.setupStatus)
	mux.HandleFunc("POST /api/setup/check", s.setupCheck)
	mux.HandleFunc("POST /api/setup", s.setup)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.Handle("GET /api/auth/check", s.protect(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"ok": true}) })))
	mux.Handle("POST /api/auth/logout", s.protect(http.HandlerFunc(s.logout)))
	mux.Handle("GET /api/rules", s.protect(http.HandlerFunc(s.listRules)))
	mux.Handle("POST /api/rules", s.protect(http.HandlerFunc(s.addRule)))
	mux.Handle("PUT /api/rules/{id}", s.protect(http.HandlerFunc(s.updateRule)))
	mux.Handle("DELETE /api/rules/{id}", s.protect(http.HandlerFunc(s.removeRule)))
	mux.Handle("POST /api/rules/import", s.protect(http.HandlerFunc(s.importRules)))
	mux.Handle("GET /api/queries", s.protect(http.HandlerFunc(s.queries)))
	mux.Handle("POST /api/queries/reset", s.protect(http.HandlerFunc(s.resetQueries)))
	mux.Handle("GET /api/stats", s.protect(http.HandlerFunc(s.stats)))
	mux.Handle("GET /api/logs", s.protect(http.HandlerFunc(s.logs)))
	mux.Handle("POST /api/cache/flush", s.protect(http.HandlerFunc(s.flushCache)))
	mux.Handle("GET /api/config", s.protect(http.HandlerFunc(s.getConfig)))
	mux.Handle("PUT /api/config", s.protect(http.HandlerFunc(s.putConfig)))
	mux.Handle("POST /api/resolve", s.protect(http.HandlerFunc(s.resolve)))
	mux.Handle("GET /api/events", s.protect(http.HandlerFunc(s.events)))
	mux.Handle("GET /api/update", s.protect(http.HandlerFunc(s.checkUpdate)))
	mux.Handle("POST /api/shutdown", s.protect(http.HandlerFunc(s.shutdown)))
	assets, _ := fs.Sub(webassets.Files, "public")
	mux.Handle("/", http.FileServer(http.FS(assets)))
}

func (s *Server) setupStatus(w http.ResponseWriter, r *http.Request) {
	cfg := s.deps.Config.Get()
	writeJSON(w, 200, map[string]any{"needsSetup": cfg.PasswordHash == "", "version": buildinfo.Version, "commit": buildinfo.Commit, "localIPs": localIPs()})
}
func (s *Server) setupCheck(w http.ResponseWriter, r *http.Request) {
	if s.deps.Config.Get().PasswordHash != "" {
		writeError(w, 409, message(r, "Setup has already been completed", "初始化已经完成"))
		return
	}
	var body struct {
		DNSPort     int    `json:"dnsPort"`
		BindAddress string `json:"bindAddress"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.BindAddress == "" {
		body.BindAddress = "0.0.0.0"
	}
	if body.DNSPort < 1 || body.DNSPort > 65535 {
		writeError(w, 400, "Invalid DNS port")
		return
	}
	if net.ParseIP(body.BindAddress) == nil {
		writeError(w, 400, "Invalid bind address")
		return
	}
	cfg := s.deps.Config.Get()
	self := body.DNSPort == cfg.DNSPort && (body.BindAddress == cfg.BindAddress || cfg.BindAddress == "0.0.0.0")
	udpState, tcpState := "ok", "ok"
	available := self
	if !self {
		udpState, tcpState = probeDNS(body.BindAddress, body.DNSPort)
		available = udpState == "ok" && tcpState == "ok"
	}
	writeJSON(w, 200, map[string]any{"available": available, "udp": udpState, "tcp": tcpState, "address": body.BindAddress, "port": body.DNSPort, "self": self})
}
func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	cfg := s.deps.Config.Get()
	if cfg.PasswordHash != "" {
		writeError(w, 409, message(r, "Setup has already been completed", "初始化已经完成"))
		return
	}
	var body struct {
		Password       string `json:"password"`
		DNSPort        int    `json:"dnsPort"`
		BindAddress    string `json:"bindAddress"`
		WebBindAddress string `json:"webBindAddress"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Password) < 6 {
		writeError(w, 400, message(r, "Password must contain at least 6 characters", "密码至少需要 6 个字符"))
		return
	}
	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeError(w, 500, "Internal error")
		return
	}
	err = s.deps.Config.Update(func(c *config.Config) error {
		c.PasswordHash = hash
		if body.DNSPort > 0 {
			c.DNSPort = body.DNSPort
		}
		if net.ParseIP(body.BindAddress) != nil {
			c.BindAddress = body.BindAddress
		}
		if net.ParseIP(body.WebBindAddress) != nil {
			c.WebBindAddress = body.WebBindAddress
		}
		return nil
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	updated := s.deps.Config.Get()
	dnsChanged := updated.DNSPort != cfg.DNSPort || updated.BindAddress != cfg.BindAddress
	webChanged := updated.WebPort != cfg.WebPort || updated.WebBindAddress != cfg.WebBindAddress
	dnsApplied := !dnsChanged
	if dnsChanged && s.deps.ApplyDNS != nil {
		if err := s.deps.ApplyDNS(updated.BindAddress, updated.DNSPort); err != nil {
			_ = s.deps.Config.Replace(cfg)
			writeError(w, 400, message(r, "DNS listener change failed; previous settings were restored", "DNS 监听地址修改失败，已恢复原设置"))
			return
		}
		dnsApplied = true
	}
	if webChanged {
		if err := s.Move(updated.WebBindAddress, updated.WebPort); err != nil {
			if dnsApplied && dnsChanged && s.deps.ApplyDNS != nil {
				_ = s.deps.ApplyDNS(cfg.BindAddress, cfg.DNSPort)
			}
			_ = s.deps.Config.Replace(cfg)
			writeError(w, 400, message(r, "Web listener change failed; previous settings were restored", "Web 监听地址修改失败，已恢复原设置"))
			return
		}
	}
	response := map[string]any{"ok": true, "restartRequired": !dnsApplied, "dns": map[string]any{"applied": dnsApplied, "address": updated.BindAddress, "port": updated.DNSPort, "listening": dnsApplied, "error": ""}}
	if webChanged {
		host := updated.WebBindAddress
		if host == "0.0.0.0" || host == "::" {
			host = "127.0.0.1"
		}
		response["newWebUrl"] = "http://" + net.JoinHostPort(host, strconv.Itoa(updated.WebPort))
	}
	writeJSON(w, 200, response)
	s.record("setup", "first-run setup completed", "log")
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &body) {
		return
	}
	result := s.deps.Auth.Login(body.Password, remoteIP(r))
	if !result.OK {
		s.record("auth", "login failed from "+remoteIP(r), "warn")
		writeError(w, 401, localizeAuthError(r, result.Error))
		return
	}
	writeJSON(w, 200, map[string]any{"token": result.Token})
	s.record("auth", "signed in from "+remoteIP(r), "log")
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	s.deps.Auth.Logout(token(r))
	writeJSON(w, 200, map[string]any{"ok": true})
}
func (s *Server) protect(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.deps.Auth.Check(token(r)) {
			writeError(w, 401, message(r, "Not signed in", "尚未登录"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) listRules(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"rules": s.deps.Rules.Snapshot()})
}
func (s *Server) addRule(w http.ResponseWriter, r *http.Request) {
	var rule rules.Rule
	if !decode(w, r, &rule) {
		return
	}
	rule, problems := rules.Validate(rule)
	if len(problems) > 0 {
		writeError(w, 400, strings.Join(localizeRuleProblems(r, problems), "; "))
		return
	}
	created, err := s.deps.Rules.Add(rule)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"rule": created})
	s.record("rules", "added "+firstDomain(created), "log")
}
func (s *Server) updateRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var patch map[string]any
	if !decode(w, r, &patch) {
		return
	}
	var current *rules.Rule
	for _, item := range s.deps.Rules.Snapshot() {
		if item.ID == id {
			copy := item
			current = &copy
			break
		}
	}
	if current == nil {
		writeError(w, 404, message(r, "Rule not found", "规则不存在"))
		return
	}
	raw, _ := json.Marshal(current)
	var merged map[string]any
	_ = json.Unmarshal(raw, &merged)
	for k, v := range patch {
		merged[k] = v
	}
	raw, _ = json.Marshal(merged)
	var rule rules.Rule
	if json.Unmarshal(raw, &rule) != nil {
		writeError(w, 400, "Invalid rule")
		return
	}
	rule, problems := rules.Validate(rule)
	if len(problems) > 0 {
		writeError(w, 400, strings.Join(localizeRuleProblems(r, problems), "; "))
		return
	}
	updated, _, err := s.deps.Rules.Update(id, rule)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"rule": updated})
	s.record("rules", "updated "+firstDomain(updated), "log")
}
func (s *Server) removeRule(w http.ResponseWriter, r *http.Request) {
	removed, err := s.deps.Rules.Remove(r.PathValue("id"))
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if !removed {
		writeError(w, 404, message(r, "Rule not found", "规则不存在"))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
	s.record("rules", "removed rule "+r.PathValue("id"), "log")
}
func (s *Server) importRules(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Rules []rules.Rule `json:"rules"`
		Mode  string       `json:"mode"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Rules) == 0 {
		writeError(w, 400, message(r, "No rules to import", "没有可导入的规则"))
		return
	}
	valid := make([]rules.Rule, 0, len(body.Rules))
	var problems []string
	now := time.Now().UnixMilli()
	for i, item := range body.Rules {
		value, errs := rules.Validate(item)
		if len(errs) > 0 {
			problems = append(problems, fmt.Sprintf("#%d: %s", i+1, localizeRuleProblems(r, errs)[0]))
			continue
		}
		if value.ID == "" {
			value.ID = fmt.Sprintf("import-%d-%d", now, i)
		}
		value.UpdatedAt = now
		if value.CreatedAt == 0 {
			value.CreatedAt = now
		}
		valid = append(valid, value)
	}
	added, updated := 0, 0
	if body.Mode == "replace" {
		if err := s.deps.Rules.ReplaceAll(valid); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		added = len(valid)
	} else {
		signature := func(item rules.Rule) string {
			domains := append([]string(nil), item.Domains...)
			sort.Strings(domains)
			return strings.Join(domains, "|") + "::" + item.Type
		}
		existing := map[string]rules.Rule{}
		for _, item := range s.deps.Rules.Snapshot() {
			existing[signature(item)] = item
		}
		for _, item := range valid {
			if current, ok := existing[signature(item)]; ok {
				if _, _, err := s.deps.Rules.Update(current.ID, item); err != nil {
					writeError(w, 500, err.Error())
					return
				}
				updated++
			} else {
				if _, err := s.deps.Rules.Add(item); err != nil {
					writeError(w, 500, err.Error())
					return
				}
				added++
			}
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "mode": map[bool]string{true: "replace", false: "merge"}[body.Mode == "replace"], "added": added, "updated": updated, "skipped": len(problems), "errors": problems[:min(5, len(problems))]})
	s.record("rules", fmt.Sprintf("imported: +%d added, %d updated, %d skipped", added, updated, len(problems)), "log")
}

func (s *Server) queries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := integer(q.Get("limit"), 200)
	if limit > 1000 {
		limit = 1000
	}
	writeJSON(w, 200, map[string]any{"queries": s.deps.History.Search(history.Filter{Limit: limit, Domain: q.Get("domain"), Source: q.Get("source"), Status: q.Get("status"), Type: q.Get("type"), Client: q.Get("client"), Rule: q.Get("rule"), Since: int64num(q.Get("since")), Until: int64num(q.Get("until"))})})
}
func (s *Server) resetQueries(w http.ResponseWriter, r *http.Request) {
	cleared := s.deps.History.Reset()
	_ = s.deps.History.Persist()
	writeJSON(w, 200, map[string]any{"ok": true, "cleared": cleared})
	s.record("queries", fmt.Sprintf("reset queries: %d entries cleared", cleared), "log")
}
func (s *Server) stats(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.state()) }
func (s *Server) state() map[string]any {
	system, dnsState := s.runtimeState()
	return map[string]any{"stats": s.deps.History.Stats(), "analytics": s.deps.History.Analytics(), "cache": s.deps.Cache.Info(), "system": system, "dns": dnsState}
}
func (s *Server) runtimeState() (map[string]any, any) {
	dnsState := any(nil)
	if s.deps.DNSStatus != nil {
		dnsState = s.deps.DNSStatus()
	}
	system := s.deps.System.Snapshot()
	return map[string]any{
		"hostname": system.Hostname, "platform": system.Platform, "release": system.Release,
		"arch": system.Arch, "runtimeName": system.RuntimeName, "runtimeVersion": system.RuntimeVersion,
		"cores": system.Cores, "totalMemMB": system.TotalMemMB, "usedMemMB": system.UsedMemMB,
		"processRSSMB": system.ProcessRSSMB, "processCpu": system.ProcessCPU,
		"systemCpu": system.SystemCPU, "uptimeSeconds": system.UptimeSeconds,
	}, dnsState
}
func (s *Server) logs(w http.ResponseWriter, r *http.Request) {
	limit := integer(r.URL.Query().Get("limit"), 400)
	if limit > 2000 {
		limit = 400
	}
	if s.deps.Logs == nil {
		writeJSON(w, 200, map[string]any{"consoleLogs": []any{}, "operationLogs": []any{}})
		return
	}
	writeJSON(w, 200, s.deps.Logs.Snapshot(limit))
}
func (s *Server) flushCache(w http.ResponseWriter, r *http.Request) {
	flushed := s.deps.Cache.Flush()
	writeJSON(w, 200, map[string]any{"ok": true, "flushed": flushed})
	s.record("cache", fmt.Sprintf("flushed %d cached entries", flushed), "log")
}
func (s *Server) checkUpdate(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result, err := s.deps.UpdateChecker(ctx)
	if err != nil {
		s.record("updates", "check failed: "+err.Error(), "warn")
		writeError(w, 502, message(r, "Unable to check for updates; try again later", "无法检查更新，请稍后重试"))
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) getConfig(w http.ResponseWriter, r *http.Request) {
	cfg := s.deps.Config.Get()
	writeJSON(w, 200, map[string]any{"config": publicConfig(cfg), "localIPs": localIPs()})
}
func (s *Server) putConfig(w http.ResponseWriter, r *http.Request) {
	var body map[string]json.RawMessage
	if !decode(w, r, &body) {
		return
	}
	old := s.deps.Config.Get()
	passwordChanged := false
	err := s.deps.Config.Update(func(c *config.Config) error {
		for key, raw := range body {
			switch key {
			case "dnsPort":
				if err := json.Unmarshal(raw, &c.DNSPort); err != nil || c.DNSPort < 1 || c.DNSPort > 65535 {
					return fmt.Errorf("dnsPort must be between 1 and 65535")
				}
			case "webPort":
				if err := json.Unmarshal(raw, &c.WebPort); err != nil || c.WebPort < 1 || c.WebPort > 65535 {
					return fmt.Errorf("webPort must be between 1 and 65535")
				}
			case "bindAddress":
				if err := json.Unmarshal(raw, &c.BindAddress); err != nil || net.ParseIP(c.BindAddress) == nil {
					return fmt.Errorf("invalid DNS bind address")
				}
			case "webBindAddress":
				if err := json.Unmarshal(raw, &c.WebBindAddress); err != nil || net.ParseIP(c.WebBindAddress) == nil {
					return fmt.Errorf("invalid Web bind address")
				}
			case "upstreams":
				if err := json.Unmarshal(raw, &c.Upstreams); err != nil {
					return err
				}
				if len(c.Upstreams) < 1 || len(c.Upstreams) > 8 {
					return fmt.Errorf("between 1 and 8 upstreams are required")
				}
				for _, upstream := range c.Upstreams {
					if _, err := config.ParseUpstream(upstream); err != nil {
						return err
					}
				}
			case "forwardTimeoutMs":
				_ = json.Unmarshal(raw, &c.ForwardTimeoutMS)
			case "ttlMin":
				_ = json.Unmarshal(raw, &c.TTLMin)
			case "ttlMax":
				_ = json.Unmarshal(raw, &c.TTLMax)
			case "queryRetentionDays":
				_ = json.Unmarshal(raw, &c.QueryRetentionDays)
			case "queryHistoryMaxEntries":
				_ = json.Unmarshal(raw, &c.QueryHistoryMaxEntries)
			case "cacheMaxEntries":
				_ = json.Unmarshal(raw, &c.CacheMaxEntries)
			case "sessionTtlHours":
				_ = json.Unmarshal(raw, &c.SessionTTLHours)
			case "newPassword":
				var password string
				_ = json.Unmarshal(raw, &password)
				if password != "" {
					var current string
					if value := body["currentPassword"]; value != nil {
						_ = json.Unmarshal(value, &current)
					}
					if !auth.VerifyPassword(current, old.PasswordHash) {
						return fmt.Errorf("current password is incorrect")
					}
					if len(password) < 6 {
						return fmt.Errorf("password must contain at least 6 characters")
					}
					hash, e := auth.HashPassword(password)
					if e != nil {
						return e
					}
					c.PasswordHash = hash
					passwordChanged = true
				}
			}
		}
		return nil
	})
	if err != nil {
		writeError(w, 400, localizeConfigError(r, err.Error()))
		return
	}
	updated := s.deps.Config.Get()
	dnsChanged := updated.DNSPort != old.DNSPort || updated.BindAddress != old.BindAddress
	webChanged := updated.WebPort != old.WebPort || updated.WebBindAddress != old.WebBindAddress
	dnsApplied := !dnsChanged
	if dnsChanged && s.deps.ApplyDNS != nil {
		if err := s.deps.ApplyDNS(updated.BindAddress, updated.DNSPort); err != nil {
			_ = s.deps.Config.Replace(old)
			writeError(w, 400, message(r, "DNS listener change failed; the previous listener was restored", "DNS 监听地址修改失败，已恢复原监听地址"))
			return
		}
		dnsApplied = true
	}
	if webChanged {
		if err := s.Move(updated.WebBindAddress, updated.WebPort); err != nil {
			if dnsApplied && dnsChanged && s.deps.ApplyDNS != nil {
				_ = s.deps.ApplyDNS(old.BindAddress, old.DNSPort)
			}
			_ = s.deps.Config.Replace(old)
			writeError(w, 400, message(r, "Web listener change failed; previous settings were restored", "Web 监听地址修改失败，已恢复原设置"))
			return
		}
	}
	s.deps.History.SetLimits(updated.QueryHistoryMaxEntries, updated.QueryRetentionDays)
	s.deps.Cache.SetMaxEntries(updated.CacheMaxEntries)
	response := map[string]any{"ok": true, "passwordChanged": passwordChanged, "adjusted": map[string]any{}, "restartRequired": !dnsApplied}
	if webChanged {
		host := updated.WebBindAddress
		if host == "0.0.0.0" || host == "::" {
			host = "127.0.0.1"
		}
		response["newWebUrl"] = "http://" + net.JoinHostPort(host, strconv.Itoa(updated.WebPort))
	}
	writeJSON(w, 200, response)
	s.record("config", "configuration updated", "log")
}

func (s *Server) resolve(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Domain string `json:"domain"`
		Type   string `json:"type"`
	}
	if !decode(w, r, &body) {
		return
	}
	domain := rules.NormalizeDomain(body.Domain)
	typeName := strings.ToUpper(body.Type)
	queryType, ok := dns.StringToType[typeName]
	if domain == "" || !ok {
		writeError(w, 400, message(r, "Domain or record type is invalid", "域名或记录类型无效"))
		return
	}
	started := time.Now()
	result, err := s.deps.Resolver.Resolve(r.Context(), domain, queryType)
	entry := history.Entry{Time: started.UnixMilli(), Client: "web-ui", Domain: domain, Type: typeName, Source: "forward", Rcode: dns.RcodeServerFailure, LatencyMS: time.Since(started).Milliseconds()}
	if err != nil {
		entry.Error = err.Error()
		s.deps.History.Record(entry)
		writeJSON(w, 200, map[string]any{"domain": domain, "type": typeName, "source": "error", "rcode": entry.Rcode, "latencyMs": entry.LatencyMS, "answers": []any{}})
		return
	}
	entry.Source = result.Source
	entry.Rcode = result.Rcode
	entry.Rule = result.RuleLabel
	entry.Upstream = result.Upstream
	s.deps.History.Record(entry)
	answers := make([]map[string]any, 0, len(result.Answers))
	for _, rr := range result.Answers {
		answers = append(answers, map[string]any{"name": strings.TrimSuffix(rr.Header().Name, "."), "type": dns.TypeToString[rr.Header().Rrtype], "ttl": rr.Header().Ttl, "value": rrValue(rr)})
	}
	writeJSON(w, 200, map[string]any{"domain": domain, "type": typeName, "source": result.Source, "rcode": result.Rcode, "latencyMs": entry.LatencyMS, "rule": result.RuleLabel, "upstream": result.Upstream, "answers": answers})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	select {
	case s.eventSlots <- struct{}{}:
		defer func() { <-s.eventSlots }()
	default:
		writeError(w, 503, message(r, "Too many live console connections", "实时控制台连接过多"))
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, 500, "Streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	latest := uint64(0)
	initial := s.deps.History.List(200)
	if len(initial) > 0 {
		latest = initial[0].Sequence
	}
	system, dnsState := s.runtimeState()
	logs := any(map[string]any{"consoleLogs": []any{}, "operationLogs": []any{}})
	logSequence := uint64(0)
	if s.deps.Logs != nil {
		logs = s.deps.Logs.Snapshot(500)
		logSequence = s.deps.Logs.Sequence()
	}
	sse(w, "snapshot", map[string]any{"stats": s.deps.History.Stats(), "analytics": s.deps.History.Analytics(), "cache": s.deps.Cache.Info(), "system": system, "dns": dnsState, "queries": initial, "logs": logs})
	flusher.Flush()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !s.deps.Auth.Check(token(r)) {
				return
			}
			recent := s.deps.History.List(200)
			var additions []history.Entry
			for i := len(recent) - 1; i >= 0; i-- {
				if recent[i].Sequence > latest {
					additions = append(additions, recent[i])
					if recent[i].Sequence > latest {
						latest = recent[i].Sequence
					}
				}
			}
			if len(additions) > 0 {
				sse(w, "queries", map[string]any{"entries": additions, "dropped": 0})
			}
			if s.deps.Logs != nil {
				updates, sequence := s.deps.Logs.Since(logSequence)
				logSequence = sequence
				if len(updates.ConsoleLogs) > 0 || len(updates.OperationLogs) > 0 {
					sse(w, "logs", map[string]any{"consoleLogs": updates.ConsoleLogs, "operationLogs": updates.OperationLogs, "dropped": 0})
				}
			}
			sse(w, "stats", s.state())
			flusher.Flush()
		}
	}
}
func (s *Server) shutdown(w http.ResponseWriter, r *http.Request) {
	s.record("shutdown", "stopping via the Web console", "log")
	writeJSON(w, 200, map[string]any{"ok": true})
	if s.deps.Shutdown != nil {
		go s.deps.Shutdown()
	}
}

func (s *Server) record(kind, text, level string) {
	if s.deps.Logs != nil {
		s.deps.Logs.Record(kind, text, level)
	}
}
func firstDomain(rule rules.Rule) string {
	if len(rule.Domains) > 0 {
		return rule.Domains[0]
	}
	return "?"
}

func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(value); err != nil {
		writeError(w, 400, message(r, "Request body is not valid JSON", "请求内容不是有效的 JSON"))
		return false
	}
	return true
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, value string) {
	writeJSON(w, status, map[string]any{"error": value})
}
func token(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if strings.HasPrefix(value, "Bearer ") {
		return strings.TrimPrefix(value, "Bearer ")
	}
	return r.Header.Get("X-Auth-Token")
}
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}
func integer(v string, fallback int) int {
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return fallback
	}
	return n
}
func int64num(v string) int64 { n, _ := strconv.ParseInt(v, 10, 64); return n }
func message(r *http.Request, en, zh string) string {
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Accept-Language")), "zh") {
		return zh
	}
	return en
}
func localizeAuthError(r *http.Request, value string) string {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Accept-Language")), "zh") {
		return value
	}
	if strings.HasPrefix(value, "Too many attempts") {
		parts := strings.Fields(value)
		seconds := "?"
		if len(parts) > 0 {
			seconds = parts[len(parts)-2]
		}
		return "尝试次数过多，请在 " + seconds + " 秒后重试"
	}
	if value == "Incorrect password" {
		return "密码不正确"
	}
	return "无法创建登录会话"
}
func localizeConfigError(r *http.Request, value string) string {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Accept-Language")), "zh") {
		return value
	}
	switch {
	case strings.Contains(value, "current password"):
		return "当前密码不正确"
	case strings.Contains(value, "at least 6"):
		return "新密码至少需要 6 个字符"
	case strings.Contains(value, "upstream"):
		return "上游 DNS 配置无效"
	case strings.Contains(value, "bind address"):
		return "监听地址无效"
	case strings.Contains(value, "Port"), strings.Contains(value, "port"):
		return "端口必须在 1 到 65535 之间"
	default:
		return "配置内容无效"
	}
}
func localizeRuleProblems(r *http.Request, problems []string) []string {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Accept-Language")), "zh") {
		return problems
	}
	out := make([]string, len(problems))
	for i, value := range problems {
		switch {
		case strings.HasPrefix(value, "At least one domain"):
			out[i] = "至少需要一个域名"
		case strings.HasPrefix(value, "At most 500"):
			out[i] = "每条规则最多 500 个域名"
		case strings.HasPrefix(value, "Invalid domain"):
			out[i] = "域名格式无效"
		case strings.Contains(value, "record type"):
			out[i] = "记录类型不支持"
		case strings.Contains(value, "rule mode"):
			out[i] = "规则模式不支持"
		case strings.HasPrefix(value, "TTL"):
			out[i] = "TTL 必须在 1 到 86400 之间"
		case strings.Contains(value, "upstream"):
			out[i] = "上游 DNS 格式无效"
		case strings.Contains(value, "IPv4"):
			out[i] = "A 记录必须使用 IPv4 地址"
		case strings.Contains(value, "IPv6"):
			out[i] = "AAAA 记录必须使用 IPv6 地址"
		case strings.Contains(value, "CNAME"):
			out[i] = "CNAME 必须是一个主机名"
		default:
			out[i] = "固定解析值不能为空"
		}
	}
	return out
}
func localIPs() []string {
	var out []string
	interfaces, _ := net.Interfaces()
	for _, item := range interfaces {
		addresses, _ := item.Addrs()
		for _, address := range addresses {
			ip, _, _ := net.ParseCIDR(address.String())
			if ip != nil && ip.To4() != nil && !ip.IsLoopback() {
				out = append(out, ip.String())
			}
		}
	}
	return out
}
func publicConfig(c config.Config) map[string]any {
	return map[string]any{"dnsPort": c.DNSPort, "webPort": c.WebPort, "bindAddress": c.BindAddress, "webBindAddress": c.WebBindAddress, "upstreams": c.Upstreams, "forwardTimeoutMs": c.ForwardTimeoutMS, "ttlMin": c.TTLMin, "ttlMax": c.TTLMax, "queryRetentionDays": c.QueryRetentionDays, "queryHistoryMaxEntries": c.QueryHistoryMaxEntries, "cacheMaxEntries": c.CacheMaxEntries, "sessionTtlHours": c.SessionTTLHours, "hasPassword": c.PasswordHash != ""}
}
func rrValue(rr dns.RR) string {
	switch v := rr.(type) {
	case *dns.A:
		return v.A.String()
	case *dns.AAAA:
		return v.AAAA.String()
	case *dns.CNAME:
		return strings.TrimSuffix(v.Target, ".")
	default:
		return rr.String()
	}
}
func sse(w http.ResponseWriter, event string, value any) {
	data, _ := json.Marshal(value)
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
}
func probeDNS(address string, port int) (string, string) {
	endpoint := net.JoinHostPort(address, strconv.Itoa(port))
	udpState, tcpState := "ok", "ok"
	udpAddress, err := net.ResolveUDPAddr("udp", endpoint)
	if err != nil {
		return err.Error(), err.Error()
	}
	udp, err := net.ListenUDP("udp", udpAddress)
	if err != nil {
		udpState = networkError(err)
	} else {
		_ = udp.Close()
	}
	tcp, err := net.Listen("tcp", endpoint)
	if err != nil {
		tcpState = networkError(err)
	} else {
		_ = tcp.Close()
	}
	return udpState, tcpState
}
func networkError(err error) string {
	if operation, ok := err.(*net.OpError); ok {
		if temporary, ok := operation.Err.(interface{ Unwrap() error }); ok && temporary.Unwrap() != nil {
			return temporary.Unwrap().Error()
		}
	}
	return err.Error()
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
