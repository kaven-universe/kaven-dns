package resolver

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/miekg/dns"

	"kaven.xyz/kaven/kaven-dns/internal/cache"
	"kaven.xyz/kaven/kaven-dns/internal/config"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
)

const maxCNAMEDepth = 4

type Result struct {
	Rcode                             int
	Answers, Authorities, Additionals []dns.RR
	Source, RuleLabel, Upstream       string
}

type Resolver struct {
	Rules  *rules.Store
	Cache  *cache.Cache
	Config func() config.Config
}

func (r *Resolver) Resolve(ctx context.Context, rawDomain string, queryType uint16) (Result, error) {
	return r.resolve(ctx, rules.NormalizeDomain(rawDomain), queryType, 0, make(map[string]bool))
}

func (r *Resolver) resolve(ctx context.Context, domain string, queryType uint16, depth int, visited map[string]bool) (Result, error) {
	cfg := r.Config()
	typeName := dns.TypeToString[queryType]
	match := r.Rules.Find(domain, typeName)
	if match != nil && match.Rule.Mode == "fixed" {
		return r.fixed(ctx, match, domain, queryType, depth, visited)
	}

	upstreams := cfg.Upstreams
	if match != nil && match.Rule.Mode == "forward" && match.Rule.Upstream != "" {
		upstreams = []string{match.Rule.Upstream}
	}
	key := fmt.Sprintf("%s|%d|%s", domain, queryType, strings.Join(upstreams, ","))
	if hit, ok := r.Cache.Get(key); ok {
		return Result{Rcode: hit.Rcode, Answers: hit.Answers, Authorities: hit.Authorities, Additionals: hit.Additionals, Source: "cache", RuleLabel: label(match)}, nil
	}

	response, upstream, err := forward(ctx, domain, queryType, upstreams, time.Duration(cfg.ForwardTimeoutMS)*time.Millisecond)
	if err != nil {
		return Result{}, err
	}
	result := Result{Rcode: response.Rcode, Answers: response.Answer, Authorities: response.Ns, Source: "forward", RuleLabel: label(match), Upstream: upstream}
	for _, rr := range response.Extra {
		if rr.Header().Rrtype != dns.TypeOPT {
			result.Additionals = append(result.Additionals, rr)
		}
	}
	if result.Rcode == dns.RcodeSuccess && len(result.Answers) > 0 {
		minimum := uint32(cfg.TTLMax)
		for _, rr := range result.Answers {
			if rr.Header().Ttl < minimum {
				minimum = rr.Header().Ttl
			}
		}
		ttl := max(cfg.TTLMin, min(cfg.TTLMax, int(minimum)))
		r.Cache.Set(key, cache.Result{Rcode: result.Rcode, Answers: result.Answers, Authorities: result.Authorities, Additionals: result.Additionals}, time.Duration(ttl)*time.Second)
	}
	return result, nil
}

func (r *Resolver) fixed(ctx context.Context, match *rules.Match, domain string, queryType uint16, depth int, visited map[string]bool) (Result, error) {
	rule := match.Rule
	result := Result{Rcode: dns.RcodeSuccess, Source: "fixed", RuleLabel: label(match)}
	name := dns.Fqdn(domain)
	if rule.Type == "CNAME" {
		target := rules.NormalizeDomain(rule.Value)
		result.Answers = append(result.Answers, &dns.CNAME{Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeCNAME, Class: dns.ClassINET, Ttl: rule.TTL}, Target: dns.Fqdn(target)})
		if queryType != dns.TypeCNAME && depth < maxCNAMEDepth && !visited[target] {
			visited[target] = true
			extra, err := r.resolve(ctx, target, queryType, depth+1, visited)
			if err == nil && extra.Rcode == dns.RcodeSuccess {
				result.Answers = append(result.Answers, extra.Answers...)
			}
		}
		return result, nil
	}
	for _, value := range strings.FieldsFunc(rule.Value, func(r rune) bool { return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t' }) {
		switch rule.Type {
		case "A":
			if ip := net.ParseIP(value).To4(); ip != nil {
				result.Answers = append(result.Answers, &dns.A{Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: rule.TTL}, A: ip})
			}
		case "AAAA":
			if ip := net.ParseIP(value); ip != nil && ip.To4() == nil {
				result.Answers = append(result.Answers, &dns.AAAA{Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeAAAA, Class: dns.ClassINET, Ttl: rule.TTL}, AAAA: ip})
			}
		}
	}
	return result, nil
}

type forwardResult struct {
	message  *dns.Msg
	upstream string
	err      error
}

func forward(parent context.Context, domain string, queryType uint16, upstreams []string, timeout time.Duration) (*dns.Msg, string, error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	results := make(chan forwardResult, len(upstreams))
	for _, raw := range upstreams {
		raw := raw
		go func() {
			address, err := config.ParseUpstream(raw)
			if err != nil {
				results <- forwardResult{err: err}
				return
			}
			query := new(dns.Msg)
			query.SetQuestion(dns.Fqdn(domain), queryType)
			query.RecursionDesired = true
			client := &dns.Client{Net: "udp", Timeout: timeout}
			response, _, err := client.ExchangeContext(ctx, query, address)
			if err == nil && response.Truncated {
				client.Net = "tcp"
				response, _, err = client.ExchangeContext(ctx, query, address)
			}
			results <- forwardResult{message: response, upstream: raw, err: err}
		}()
	}
	var failures []error
	for range upstreams {
		result := <-results
		if result.err == nil && result.message != nil {
			cancel()
			return result.message, result.upstream, nil
		}
		if result.err != nil {
			failures = append(failures, result.err)
		}
	}
	if len(failures) == 0 {
		failures = append(failures, errors.New("no upstream response"))
	}
	return nil, "", fmt.Errorf("all upstreams failed: %w", errors.Join(failures...))
}

func label(match *rules.Match) string {
	if match == nil {
		return ""
	}
	value := match.Pattern
	if count := len(match.Rule.Domains); count > 1 {
		value += fmt.Sprintf(" (+%d)", count-1)
	}
	if match.Rule.Remark != "" {
		value += " (" + match.Rule.Remark + ")"
	}
	return value
}
