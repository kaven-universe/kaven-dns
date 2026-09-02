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

func TestPersistAndLoadNodeCompatibleSnapshot(t *testing.T) {
	path := t.TempDir() + "/queries.json"
	store, err := Load(path, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	store.Record(Entry{Domain: "persisted.test", Source: "fixed"})
	if err := store.Persist(); err != nil {
		t.Fatal(err)
	}
	restored, err := Load(path, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Len() != 1 || restored.List(1)[0].Domain != "persisted.test" || restored.Stats().Total != 1 {
		t.Fatalf("restored=%#v stats=%#v", restored.List(1), restored.Stats())
	}
}
