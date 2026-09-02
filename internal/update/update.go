package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const tagsURL = "https://api.github.com/repos/kaven-universe/kaven-dns/tags?per_page=100"

type Result struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
	URL             string `json:"url"`
}
type Doer interface {
	Do(*http.Request) (*http.Response, error)
}

var stable = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)$`)

func ParseStable(value string) (string, [3]int, bool) {
	match := stable.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return "", [3]int{}, false
	}
	var parts [3]int
	for i := range 3 {
		parts[i], _ = strconv.Atoi(match[i+1])
	}
	return fmt.Sprintf("%d.%d.%d", parts[0], parts[1], parts[2]), parts, true
}
func Compare(left, right string) (int, error) {
	_, a, ok := ParseStable(left)
	if !ok {
		return 0, fmt.Errorf("invalid version %q", left)
	}
	_, b, ok := ParseStable(right)
	if !ok {
		return 0, fmt.Errorf("invalid version %q", right)
	}
	for i := range 3 {
		if a[i] > b[i] {
			return 1, nil
		}
		if a[i] < b[i] {
			return -1, nil
		}
	}
	return 0, nil
}
func Check(ctx context.Context, client Doer, currentVersion string) (Result, error) {
	current, _, ok := ParseStable(currentVersion)
	if !ok {
		return Result{}, fmt.Errorf("invalid current version")
	}
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, tagsURL, nil)
	if err != nil {
		return Result{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "kaven-dns/"+current)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := client.Do(request)
	if err != nil {
		return Result{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Result{}, fmt.Errorf("GitHub returned HTTP %d", response.StatusCode)
	}
	var tags []struct {
		Name string `json:"name"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(&tags); err != nil {
		return Result{}, fmt.Errorf("decode tags: %w", err)
	}
	latest, latestTag := "", ""
	for _, tag := range tags {
		version, _, valid := ParseStable(tag.Name)
		if !valid {
			continue
		}
		if latest == "" {
			latest, latestTag = version, tag.Name
			continue
		}
		comparison, _ := Compare(version, latest)
		if comparison > 0 {
			latest, latestTag = version, tag.Name
		}
	}
	if latest == "" {
		return Result{}, fmt.Errorf("GitHub returned no stable version tags")
	}
	comparison, _ := Compare(latest, current)
	return Result{CurrentVersion: current, LatestVersion: latest, UpdateAvailable: comparison > 0, URL: "https://github.com/kaven-universe/kaven-dns/tree/" + url.PathEscape(strings.TrimSpace(latestTag))}, nil
}
