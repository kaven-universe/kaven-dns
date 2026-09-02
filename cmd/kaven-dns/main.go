package main

import (
	"context"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"kaven.xyz/kaven/kaven-dns/internal/auth"
	"kaven.xyz/kaven/kaven-dns/internal/cache"
	"kaven.xyz/kaven/kaven-dns/internal/config"
	"kaven.xyz/kaven/kaven-dns/internal/dnsserver"
	"kaven.xyz/kaven/kaven-dns/internal/history"
	"kaven.xyz/kaven/kaven-dns/internal/logstore"
	"kaven.xyz/kaven/kaven-dns/internal/resolver"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
	"kaven.xyz/kaven/kaven-dns/internal/web"
)

func main() {
	dataDir := config.DataDir()
	logs := logstore.New(200)
	log.SetOutput(io.MultiWriter(os.Stderr, logs.Writer()))
	cfg, err := config.Load(filepath.Join(dataDir, "config.json"))
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	cfgStore := config.NewStore(filepath.Join(dataDir, "config.json"), cfg)
	ruleStore, err := rules.Load(filepath.Join(dataDir, "rules.json"))
	if err != nil {
		log.Fatalf("load rules: %v", err)
	}
	dnsCache := cache.New(cfg.CacheMaxEntries)
	queryHistory, err := history.Load(filepath.Join(dataDir, "queries.json"), cfg.QueryHistoryMaxEntries, cfg.QueryRetentionDays)
	if err != nil {
		log.Printf("load query history: %v; starting empty", err)
		queryHistory = history.New(cfg.QueryHistoryMaxEntries, cfg.QueryRetentionDays)
	}
	dnsResolver := &resolver.Resolver{Rules: ruleStore, Cache: dnsCache, Config: cfgStore.Get}
	dnsService := dnsserver.New(dnsResolver, queryHistory)
	if err := dnsService.Start(cfg.BindAddress, cfg.DNSPort); err != nil {
		log.Fatalf("start DNS: %v", err)
	}
	log.Printf("Kaven DNS listening on %s:%d (UDP + TCP)", cfg.BindAddress, cfg.DNSPort)
	authManager := auth.New(filepath.Join(dataDir, "sessions.json"), func() time.Duration { return time.Duration(cfgStore.Get().SessionTTLHours) * time.Hour }, func(password string) bool { return auth.VerifyPassword(password, cfgStore.Get().PasswordHash) })
	shutdownRequested := make(chan struct{})
	requestShutdown := func() {
		select {
		case <-shutdownRequested:
		default:
			close(shutdownRequested)
		}
	}
	webService := web.New(web.Dependencies{Config: cfgStore, Rules: ruleStore, History: queryHistory, Cache: dnsCache, Resolver: dnsResolver, Auth: authManager, Logs: logs, DNSStatus: func() any { return dnsService.Status() }, ApplyDNS: func(address string, port int) error { return dnsService.Restart(address, port) }, Shutdown: requestShutdown})
	if err := webService.Start(cfg.WebBindAddress, cfg.WebPort); err != nil {
		dnsService.Shutdown()
		log.Fatalf("start Web console: %v", err)
	}
	log.Printf("Web console listening on %s:%d", cfg.WebBindAddress, cfg.WebPort)

	sweep := time.NewTicker(time.Minute)
	defer sweep.Stop()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	for {
		select {
		case <-sweep.C:
			dnsCache.Sweep()
		case signal := <-signals:
			log.Printf("received %s; stopping", signal)
			dnsService.Shutdown()
			authManager.Close()
			if err := queryHistory.Persist(); err != nil {
				log.Printf("save query history: %v", err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = webService.Shutdown(ctx)
			cancel()
			return
		case <-shutdownRequested:
			log.Printf("shutdown requested via API")
			dnsService.Shutdown()
			authManager.Close()
			if err := queryHistory.Persist(); err != nil {
				log.Printf("save query history: %v", err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = webService.Shutdown(ctx)
			cancel()
			return
		}
	}
}
