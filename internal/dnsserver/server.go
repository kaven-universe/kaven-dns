package dnsserver

import (
	"context"
	"fmt"
	"log"
	"net"
	"strings"
	"time"

	"github.com/miekg/dns"

	"kaven.xyz/kaven/kaven-dns/internal/history"
	"kaven.xyz/kaven/kaven-dns/internal/resolver"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
)

type Server struct {
	resolver *resolver.Resolver
	history  *history.Store
	udp, tcp *dns.Server
}

func New(resolver *resolver.Resolver, history *history.Store) *Server {
	return &Server{resolver: resolver, history: history}
}

func (s *Server) Start(address string, port int) error {
	endpoint := net.JoinHostPort(address, fmt.Sprint(port))
	udpAddress, err := net.ResolveUDPAddr("udp", endpoint)
	if err != nil {
		return err
	}
	udp, err := net.ListenUDP("udp", udpAddress)
	if err != nil {
		return fmt.Errorf("listen UDP: %w", err)
	}
	tcp, err := net.Listen("tcp", endpoint)
	if err != nil {
		udp.Close()
		return fmt.Errorf("listen TCP: %w", err)
	}
	handler := dns.HandlerFunc(s.handle)
	s.udp = &dns.Server{PacketConn: udp, Handler: handler}
	s.tcp = &dns.Server{Listener: tcp, Handler: handler}
	go func() {
		if err := s.udp.ActivateAndServe(); err != nil && !strings.Contains(err.Error(), "closed") {
			log.Printf("DNS UDP stopped: %v", err)
		}
	}()
	go func() {
		if err := s.tcp.ActivateAndServe(); err != nil && !strings.Contains(err.Error(), "closed") {
			log.Printf("DNS TCP stopped: %v", err)
		}
	}()
	return nil
}

func (s *Server) Shutdown() {
	if s.udp != nil {
		_ = s.udp.Shutdown()
	}
	if s.tcp != nil {
		_ = s.tcp.Shutdown()
	}
}

func (s *Server) handle(writer dns.ResponseWriter, request *dns.Msg) {
	started := time.Now()
	response := new(dns.Msg)
	response.SetReply(request)
	response.RecursionAvailable = true
	entry := history.Entry{Time: started.UnixMilli(), Client: clientIP(writer.RemoteAddr()), Source: "forward"}
	if len(request.Question) == 0 || request.Question[0].Name == "" {
		response.Rcode = dns.RcodeFormatError
		_ = writer.WriteMsg(response)
		return
	}
	question := request.Question[0]
	entry.Domain = rules.NormalizeDomain(question.Name)
	entry.Type = typeName(question.Qtype)
	result, err := s.resolver.Resolve(context.Background(), entry.Domain, question.Qtype)
	if err != nil {
		response.Rcode = dns.RcodeServerFailure
		entry.Rcode = response.Rcode
		entry.Error = err.Error()
	} else {
		response.Rcode = result.Rcode
		response.Answer = result.Answers
		response.Ns = result.Authorities
		response.Extra = result.Additionals
		entry.Source = result.Source
		entry.Rcode = result.Rcode
		entry.Rule = result.RuleLabel
		entry.Upstream = result.Upstream
		entry.Answers = summarize(result.Answers, 3)
	}
	if writeErr := writer.WriteMsg(response); writeErr != nil && entry.Error == "" {
		entry.Error = writeErr.Error()
	}
	entry.LatencyMS = time.Since(started).Milliseconds()
	s.history.Record(entry)
}

func clientIP(address net.Addr) string {
	if address == nil {
		return "unknown"
	}
	host, _, err := net.SplitHostPort(address.String())
	if err == nil {
		return host
	}
	return address.String()
}

func typeName(value uint16) string {
	if name := dns.TypeToString[value]; name != "" {
		return name
	}
	return fmt.Sprintf("TYPE%d", value)
}

func summarize(records []dns.RR, limit int) string {
	parts := make([]string, 0, min(limit, len(records)))
	for _, rr := range records[:min(limit, len(records))] {
		switch value := rr.(type) {
		case *dns.A:
			parts = append(parts, value.A.String())
		case *dns.AAAA:
			parts = append(parts, value.AAAA.String())
		case *dns.CNAME:
			parts = append(parts, strings.TrimSuffix(value.Target, "."))
		default:
			parts = append(parts, typeName(rr.Header().Rrtype))
		}
	}
	if len(records) > limit {
		parts = append(parts, fmt.Sprintf("… %d records", len(records)))
	}
	return strings.Join(parts, ", ")
}
