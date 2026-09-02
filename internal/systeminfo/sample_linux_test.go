//go:build linux

package systeminfo

import "testing"

func TestParseProcSamples(t *testing.T) {
	total, idle := parseCPUStat("cpu  10 2 3 40 5 6 7 8\ncpu0 0 0 0 0")
	if total != 81 || idle != 45 {
		t.Fatalf("CPU total=%d idle=%d", total, idle)
	}
	if ticks := parseProcessTicks("42 (name with spaces) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14"); ticks != 23 {
		t.Fatalf("process ticks=%d", ticks)
	}
	totalMemory, usedMemory := parseMemoryInfo("MemTotal: 262144 kB\nMemAvailable: 163840 kB\n")
	if totalMemory != 256<<20 || usedMemory != 96<<20 {
		t.Fatalf("memory total=%d used=%d", totalMemory, usedMemory)
	}
}
