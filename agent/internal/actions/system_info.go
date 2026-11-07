package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
)

type SystemInfo struct{}

func (a *SystemInfo) Name() string { return "system.info" }

func (a *SystemInfo) Validate(params json.RawMessage) error {
	if len(params) > 0 && string(params) != "null" && string(params) != "{}" {
		return fmt.Errorf("system.info takes no parameters")
	}
	return nil
}

type SystemInfoResult struct {
	Hostname string            `json:"hostname"`
	OS       string            `json:"os"`
	Arch     string            `json:"arch"`
	CPUs     int               `json:"cpus"`
	Memory   MemoryInfo        `json:"memory"`
	Disk     DiskInfo          `json:"disk"`
	Versions map[string]string `json:"versions"`
}

type MemoryInfo struct {
	TotalMB     uint64 `json:"total_mb"`
	AvailableMB uint64 `json:"available_mb"`
}

type DiskInfo struct {
	TotalGB     uint64 `json:"total_gb"`
	AvailableGB uint64 `json:"available_gb"`
}

func (a *SystemInfo) Execute(_ context.Context, _ json.RawMessage) (any, error) {
	hostname, _ := os.Hostname()

	mem := readMemory()
	disk := readDisk("/srv/forja")

	versions := map[string]string{
		"go": runtime.Version(),
	}
	if v := commandVersion("/usr/local/go/bin/go", "version"); v != "" {
		versions["go"] = v
	}
	if v := commandVersion("node", "--version"); v != "" {
		versions["node"] = v
	}
	if v := commandVersion("podman", "--version"); v != "" {
		versions["podman"] = v
	}
	if v := commandVersion("caddy", "version"); v != "" {
		versions["caddy"] = v
	}

	return &SystemInfoResult{
		Hostname: hostname,
		OS:       runtime.GOOS,
		Arch:     runtime.GOARCH,
		CPUs:     runtime.NumCPU(),
		Memory:   mem,
		Disk:     disk,
		Versions: versions,
	}, nil
}

func readMemory() MemoryInfo {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return MemoryInfo{}
	}
	var total, available uint64
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fmt.Sscanf(line, "MemTotal: %d kB", &total)
		}
		if strings.HasPrefix(line, "MemAvailable:") {
			fmt.Sscanf(line, "MemAvailable: %d kB", &available)
		}
	}
	return MemoryInfo{
		TotalMB:     total / 1024,
		AvailableMB: available / 1024,
	}
}

func readDisk(path string) DiskInfo {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		if err := syscall.Statfs("/", &stat); err != nil {
			return DiskInfo{}
		}
	}
	totalGB := (stat.Blocks * uint64(stat.Bsize)) / (1024 * 1024 * 1024)
	availGB := (stat.Bavail * uint64(stat.Bsize)) / (1024 * 1024 * 1024)
	return DiskInfo{TotalGB: totalGB, AvailableGB: availGB}
}

func commandVersion(name string, args ...string) string {
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
