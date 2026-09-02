package buildinfo

import (
	"os"
	"strings"
	"testing"
)

func TestDefaultMatchesVersionFile(t *testing.T) {
	data, err := os.ReadFile("../../VERSION")
	if err != nil {
		t.Fatal(err)
	}
	if expected := strings.TrimSpace(string(data)); Version != expected {
		t.Fatalf("Version = %q, VERSION = %q", Version, expected)
	}
}

func TestStableVersion(t *testing.T) {
	original := Version
	t.Cleanup(func() { Version = original })
	for input, expected := range map[string]string{
		"1.3.0-go":       "1.3.0",
		"v2.4.1+arm64":   "2.4.1",
		" 3.0.0-beta.1 ": "3.0.0",
		"":               "0.0.0",
	} {
		Version = input
		if actual := StableVersion(); actual != expected {
			t.Errorf("StableVersion(%q) = %q, want %q", input, actual, expected)
		}
	}
}
