//go:build windows

package systeminfo

import (
	"testing"
	"time"
)

func TestWindowsSampleIncludesHostMetrics(t *testing.T) {
	first := readSample()
	time.Sleep(20 * time.Millisecond)
	second := readSample()

	if first.platform != "Windows" || first.release == "" {
		t.Fatalf("identity = %#v", first)
	}
	if first.totalMemory == 0 || first.usedMemory == 0 || first.processRSS == 0 {
		t.Fatalf("memory = %#v", first)
	}
	if first.totalTicks == 0 || second.totalTicks <= first.totalTicks {
		t.Fatalf("CPU ticks did not advance: first=%d second=%d", first.totalTicks, second.totalTicks)
	}
}
