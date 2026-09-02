//go:build !linux

package systeminfo

import (
	"runtime"
	"strings"
)

func readSample() sample {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	return sample{processRSS: memory.Sys, platform: platformName(runtime.GOOS)}
}

func platformName(value string) string {
	switch value {
	case "darwin":
		return "macOS"
	case "windows":
		return "Windows"
	default:
		if value == "" {
			return "Unknown"
		}
		return strings.ToUpper(value[:1]) + value[1:]
	}
}
