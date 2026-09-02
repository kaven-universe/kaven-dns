package main

import (
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"kaven.xyz/kaven/kaven-dns/internal/cache"
	"kaven.xyz/kaven/kaven-dns/internal/config"
	"kaven.xyz/kaven/kaven-dns/internal/dnsserver"
	"kaven.xyz/kaven/kaven-dns/internal/history"
	"kaven.xyz/kaven/kaven-dns/internal/resolver"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
)

func main() {
	dataDir := config.DataDir()
	cfg, err := config.Load(filepath.Join(dataDir, "config.json"))
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	ruleStore, err := rules.Load(filepath.Join(dataDir, "rules.json"))
	if err != nil {
		log.Fatalf("load rules: %v", err)
	}
	dnsCache := cache.New(cfg.CacheMaxEntries)
	queryHistory := history.New(cfg.QueryHistoryMaxEntries, cfg.QueryRetentionDays)
	dnsResolver := &resolver.Resolver{Rules: ruleStore, Cache: dnsCache, Config: func() config.Config { return cfg }}
	server := dnsserver.New(dnsResolver, queryHistory)
	if err := server.Start(cfg.BindAddress, cfg.DNSPort); err != nil {
		log.Fatalf("start DNS: %v", err)
	}
	log.Printf("Kaven DNS Go prototype listening on %s:%d (UDP + TCP)", cfg.BindAddress, cfg.DNSPort)

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
			server.Shutdown()
			return
		}
	}
}
