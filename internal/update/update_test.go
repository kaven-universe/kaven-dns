package update

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type doer func(*http.Request) (*http.Response, error)

func (d doer) Do(r *http.Request) (*http.Response, error) { return d(r) }
func TestCompareStableVersions(t *testing.T) {
	comparison, err := Compare("1.10.0", "1.9.9")
	if err != nil || comparison != 1 {
		t.Fatalf("comparison=%d err=%v", comparison, err)
	}
	if _, err := Compare("latest", "1.0.0"); err == nil {
		t.Fatal("invalid version accepted")
	}
}
func TestFindsHighestStableTag(t *testing.T) {
	client := doer(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("User-Agent") != "kaven-dns/1.2.1" {
			t.Fatalf("user agent=%q", request.Header.Get("User-Agent"))
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`[{"name":"rc"},{"name":"v1.9.0"},{"name":"v1.10.0"}]`))}, nil
	})
	result, err := Check(context.Background(), client, "1.2.1")
	if err != nil {
		t.Fatal(err)
	}
	if result.LatestVersion != "1.10.0" || !result.UpdateAvailable || !strings.HasSuffix(result.URL, "v1.10.0") {
		t.Fatalf("result=%#v", result)
	}
}
