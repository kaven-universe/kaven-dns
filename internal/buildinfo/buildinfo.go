package buildinfo

import "strings"

var (
	Version = "1.3.0-go"
	Commit  = ""
)

func StableVersion() string {
	value := strings.TrimPrefix(strings.TrimSpace(Version), "v")
	if index := strings.IndexAny(value, "+-"); index >= 0 {
		value = value[:index]
	}
	if value == "" {
		return "0.0.0"
	}
	return value
}
