package systeminfo

import (
	"math"
	"os"
	"runtime"
	"sync"
	"time"
)

type Snapshot struct {
	Hostname       string  `json:"hostname"`
	Platform       string  `json:"platform"`
	Release        string  `json:"release"`
	Arch           string  `json:"arch"`
	RuntimeName    string  `json:"runtimeName"`
	RuntimeVersion string  `json:"runtimeVersion"`
	Cores          int     `json:"cores"`
	TotalMemMB     uint64  `json:"totalMemMB"`
	UsedMemMB      uint64  `json:"usedMemMB"`
	ProcessRSSMB   uint64  `json:"processRSSMB"`
	ProcessCPU     float64 `json:"processCpu"`
	SystemCPU      float64 `json:"systemCpu"`
	UptimeSeconds  int64   `json:"uptimeSeconds"`
}

type sample struct {
	processTicks uint64
	totalTicks   uint64
	idleTicks    uint64
	totalMemory  uint64
	usedMemory   uint64
	processRSS   uint64
	platform     string
	release      string
}

type Monitor struct {
	mu       sync.Mutex
	read     func() sample
	previous sample
	started  time.Time
	process  float64
	system   float64
}

func New() *Monitor {
	return newMonitor(readSample)
}

func newMonitor(reader func() sample) *Monitor {
	return &Monitor{read: reader, previous: reader(), started: time.Now()}
}

func (m *Monitor) Snapshot() Snapshot {
	m.mu.Lock()
	current := m.read()
	if current.totalTicks >= m.previous.totalTicks {
		if deltaTotal := current.totalTicks - m.previous.totalTicks; deltaTotal > 0 {
			if current.processTicks >= m.previous.processTicks {
				deltaProcess := current.processTicks - m.previous.processTicks
				m.process = percent(float64(deltaProcess) / float64(deltaTotal) * 100)
			}
			if current.idleTicks >= m.previous.idleTicks {
				deltaIdle := current.idleTicks - m.previous.idleTicks
				m.system = percent((1 - float64(deltaIdle)/float64(deltaTotal)) * 100)
			}
		}
	}
	m.previous = current
	processCPU, systemCPU := m.process, m.system
	started := m.started
	m.mu.Unlock()

	hostname, _ := os.Hostname()
	return Snapshot{
		Hostname: hostname, Platform: current.platform, Release: current.release,
		Arch: runtime.GOARCH, RuntimeName: "Go", RuntimeVersion: runtime.Version(),
		Cores: runtime.NumCPU(), TotalMemMB: toMB(current.totalMemory),
		UsedMemMB: toMB(current.usedMemory), ProcessRSSMB: toMB(current.processRSS),
		ProcessCPU: processCPU, SystemCPU: systemCPU,
		UptimeSeconds: int64(time.Since(started).Seconds()),
	}
}

func percent(value float64) float64 {
	value = math.Max(0, math.Min(100, value))
	return math.Round(value*10) / 10
}

func toMB(value uint64) uint64 {
	return (value + 512*1024) / (1024 * 1024)
}
