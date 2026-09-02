package systeminfo

import "testing"

func TestSnapshotCalculatesCPUAndMemory(t *testing.T) {
	samples := []sample{
		{processTicks: 100, totalTicks: 1000, idleTicks: 700},
		{processTicks: 120, totalTicks: 1200, idleTicks: 800, totalMemory: 256 << 20, usedMemory: 96 << 20, processRSS: 12 << 20, platform: "Linux", release: "test"},
	}
	index := 0
	monitor := newMonitor(func() sample {
		value := samples[index]
		if index < len(samples)-1 {
			index++
		}
		return value
	})
	snapshot := monitor.Snapshot()
	if snapshot.ProcessCPU != 10 || snapshot.SystemCPU != 50 {
		t.Fatalf("CPU = process %.1f, system %.1f", snapshot.ProcessCPU, snapshot.SystemCPU)
	}
	if snapshot.TotalMemMB != 256 || snapshot.UsedMemMB != 96 || snapshot.ProcessRSSMB != 12 {
		t.Fatalf("memory = %#v", snapshot)
	}
	if snapshot.RuntimeName != "Go" || snapshot.Platform != "Linux" || snapshot.Cores < 1 {
		t.Fatalf("identity = %#v", snapshot)
	}
}
