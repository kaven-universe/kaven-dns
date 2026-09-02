package buildinfo

import "testing"

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
