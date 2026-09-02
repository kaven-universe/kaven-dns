package dnsserver

import (
	"context"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"

	"kaven.xyz/kaven/kaven-dns/internal/history"
	"kaven.xyz/kaven/kaven-dns/internal/resolver"
	"kaven.xyz/kaven/kaven-dns/internal/rules"
)

type Server struct {
	mu       sync.RWMutex
	resolver *resolver.Resolver
	history  *history.Store
	udp, tcp *dns.Server
	status   Status
}

type Status struct {
	Port      int    `json:"port"`
	Address   string `json:"address"`
	Listening bool   `json:"listening"`
	Error     string `json:"error"`
}

func New(resolver *resolver.Resolver, history *history.Store) *Server {
	return &Server{resolver: resolver, history: history}
}

func (s *Server) Start(address string, port int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	udp, tcp, err := s.startPair(address, port)
	if err != nil {
		s.status = Status{Port: port, Address: address, Error: err.Error()}
		return err
	}
	s.udp, s.tcp = udp, tcp
	s.status = Status{Port: port, Address: address, Listening: true}
	return nil
}

func (s *Server) startPair(address string, port int) (*dns.Server, *dns.Server, error) {
	endpoint := net.JoinHostPort(address, strconv.Itoa(port))
	udpAddress, err := net.ResolveUDPAddr("udp", endpoint)
	if err != nil {
		return nil, nil, err
	}
	udp, err := net.ListenUDP("udp", udpAddress)
	if err != nil {
		return nil, nil, fmt.Errorf("listen UDP: %w", err)
	}
	tcp, err := net.Listen("tcp", endpoint)
	if err != nil {
		udp.Close()
		return nil, nil, fmt.Errorf("listen TCP: %w", err)
	}
	handler := dns.HandlerFunc(s.handle)
	udpServer := &dns.Server{PacketConn: udp, Handler: handler}
	tcpServer := &dns.Server{Listener: tcp, Handler: handler}
	go func() {
		if err := udpServer.ActivateAndServe(); err != nil && !strings.Contains(err.Error(), "closed") {
			log.Printf("DNS UDP stopped: %v", err)
		}
	}()
	go func() {
		if err := tcpServer.ActivateAndServe(); err != nil && !strings.Contains(err.Error(), "closed") {
			log.Printf("DNS TCP stopped: %v", err)
		}
	}()
	return udpServer, tcpServer, nil
}

func (s *Server) Shutdown() {
	s.mu.Lock()
	udp, tcp := s.udp, s.tcp
	s.udp, s.tcp = nil, nil
	s.status.Listening = false
	s.mu.Unlock()
	shutdownPair(udp, tcp)
}

func (s *Server) Restart(address string, port int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	oldUDP, oldTCP, old := s.udp, s.tcp, s.status
	if old.Listening && old.Port == port && old.Address == address {
		return nil
	}
	s.udp, s.tcp = nil, nil
	shutdownPair(oldUDP, oldTCP)
	udp, tcp, err := s.startPair(address, port)
	if err == nil {
		s.udp, s.tcp = udp, tcp
		s.status = Status{Port: port, Address: address, Listening: true}
		return nil
	}
	rollbackUDP, rollbackTCP, rollbackErr := s.startPair(old.Address, old.Port)
	if rollbackErr == nil {
		s.udp, s.tcp = rollbackUDP, rollbackTCP
		s.status = old
	} else {
		s.status = Status{Port: port, Address: address, Error: fmt.Sprintf("%v; rollback failed: %v", err, rollbackErr)}
	}
	return err
}
func (s *Server) Status() Status { s.mu.RLock(); defer s.mu.RUnlock(); return s.status }
func shutdownPair(udp, tcp *dns.Server) {
	if udp != nil {
		_ = udp.Shutdown()
	}
	if tcp != nil {
		_ = tcp.Shutdown()
	}
}

func (s *Server) handle(writer dns.ResponseWriter, request *dns.Msg) {
	started := time.Now()
	response := new(dns.Msg)
	response.SetReply(request)
	response.RecursionAvailable = true
	entry := history.Entry{Time: started.UnixMilli(), Client: resolveClientIP(request, writer.RemoteAddr()), Source: "forward"}
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

func resolveClientIP(request *dns.Msg, address net.Addr) string {
	socketIP := clientIP(address)
	ip := net.ParseIP(socketIP)
	if ip == nil || !ip.IsLoopback() {
		return socketIP
	}
	opt := request.IsEdns0()
	if opt == nil {
		return socketIP
	}
	for _, option := range opt.Option {
		subnet, ok := option.(*dns.EDNS0_SUBNET)
		if !ok || subnet.SourceScope != 0 {
			continue
		}
		maxBits := uint8(0)
		if subnet.Family == 1 {
			maxBits = 32
		} else if subnet.Family == 2 {
			maxBits = 128
		} else {
			continue
		}
		if subnet.SourceNetmask < 1 || subnet.SourceNetmask > maxBits || subnet.Address == nil {
			continue
		}
		value := subnet.Address.String()
		if subnet.SourceNetmask < maxBits {
			return fmt.Sprintf("%s/%d", value, subnet.SourceNetmask)
		}
		return value
	}
	return socketIP
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
