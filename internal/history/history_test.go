package history

import "testing"

func TestHistoryHasHardEntryBound(t *testing.T) {
	store := New(2, 0)
	store.Record(Entry{Domain: "one.test"})
	store.Record(Entry{Domain: "two.test"})
	store.Record(Entry{Domain: "three.test"})
	if store.Len() != 2 {
		t.Fatalf("history length = %d", store.Len())
	}
	entries := store.List(10)
	if entries[0].Domain != "three.test" || entries[1].Domain != "two.test" {
		t.Fatalf("entries = %#v", entries)
	}
}
