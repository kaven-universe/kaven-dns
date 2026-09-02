//go:build windows

package systeminfo

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32             = windows.NewLazySystemDLL("kernel32.dll")
	psapi                = windows.NewLazySystemDLL("psapi.dll")
	getSystemTimes       = kernel32.NewProc("GetSystemTimes")
	globalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	getProcessMemoryInfo = psapi.NewProc("GetProcessMemoryInfo")
)

type memoryStatusEx struct {
	length            uint32
	memoryLoad        uint32
	totalPhysical     uint64
	availablePhysical uint64
	totalPageFile     uint64
	availablePageFile uint64
	totalVirtual      uint64
	availableVirtual  uint64
	availableExtended uint64
}

type processMemoryCounters struct {
	length                  uint32
	pageFaultCount          uint32
	peakWorkingSetSize      uintptr
	workingSetSize          uintptr
	quotaPeakPagedPoolUsage uintptr
	quotaPagedPoolUsage     uintptr
	quotaPeakNonPagedUsage  uintptr
	quotaNonPagedUsage      uintptr
	pagefileUsage           uintptr
	peakPagefileUsage       uintptr
}

func readSample() sample {
	value := sample{platform: "Windows"}
	version := windows.RtlGetVersion()
	value.release = fmt.Sprintf("%d.%d.%d", version.MajorVersion, version.MinorVersion, version.BuildNumber)

	var idle, kernel, user windows.Filetime
	if ok, _, _ := getSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)),
	); ok != 0 {
		value.idleTicks = uint64(idle.Nanoseconds())
		value.totalTicks = uint64(kernel.Nanoseconds() + user.Nanoseconds())
	}

	var creation, exit, processKernel, processUser windows.Filetime
	if err := windows.GetProcessTimes(windows.CurrentProcess(), &creation, &exit, &processKernel, &processUser); err == nil {
		value.processTicks = uint64(processKernel.Nanoseconds() + processUser.Nanoseconds())
	}

	memory := memoryStatusEx{length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	if ok, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&memory))); ok != 0 {
		value.totalMemory = memory.totalPhysical
		if memory.availablePhysical <= memory.totalPhysical {
			value.usedMemory = memory.totalPhysical - memory.availablePhysical
		}
	}

	processMemory := processMemoryCounters{length: uint32(unsafe.Sizeof(processMemoryCounters{}))}
	if ok, _, _ := getProcessMemoryInfo.Call(
		uintptr(windows.CurrentProcess()),
		uintptr(unsafe.Pointer(&processMemory)),
		uintptr(processMemory.length),
	); ok != 0 {
		value.processRSS = uint64(processMemory.workingSetSize)
	}
	return value
}
