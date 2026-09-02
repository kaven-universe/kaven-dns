//go:build linux

package systeminfo

import (
	"os"
	"strconv"
	"strings"
)

func readSample() sample {
	value := sample{platform: "Linux"}
	if release, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		value.release = strings.TrimSpace(string(release))
	}
	if data, err := os.ReadFile("/proc/stat"); err == nil {
		value.totalTicks, value.idleTicks = parseCPUStat(string(data))
	}
	if data, err := os.ReadFile("/proc/self/stat"); err == nil {
		value.processTicks = parseProcessTicks(string(data))
	}
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		value.totalMemory, value.usedMemory = parseMemoryInfo(string(data))
	}
	if data, err := os.ReadFile("/proc/self/statm"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 1 {
			pages, _ := strconv.ParseUint(fields[1], 10, 64)
			value.processRSS = pages * uint64(os.Getpagesize())
		}
	}
	return value
}

func parseCPUStat(data string) (uint64, uint64) {
	line, _, _ := strings.Cut(data, "\n")
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0
	}
	values := make([]uint64, 0, len(fields)-1)
	for _, field := range fields[1:] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			break
		}
		values = append(values, value)
	}
	if len(values) < 4 {
		return 0, 0
	}
	var total uint64
	for index, value := range values {
		if index == 8 {
			break
		}
		total += value
	}
	idle := values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	return total, idle
}

func parseProcessTicks(data string) uint64 {
	end := strings.LastIndex(data, ")")
	if end < 0 {
		return 0
	}
	fields := strings.Fields(data[end+1:])
	if len(fields) <= 12 {
		return 0
	}
	user, _ := strconv.ParseUint(fields[11], 10, 64)
	system, _ := strconv.ParseUint(fields[12], 10, 64)
	return user + system
}

func parseMemoryInfo(data string) (uint64, uint64) {
	values := make(map[string]uint64)
	for line := range strings.SplitSeq(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err == nil {
			values[strings.TrimSuffix(fields[0], ":")] = value * 1024
		}
	}
	total := values["MemTotal"]
	available := values["MemAvailable"]
	if available == 0 {
		available = values["MemFree"] + values["Buffers"] + values["Cached"]
	}
	if available > total {
		available = total
	}
	return total, total - available
}
