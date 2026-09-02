package logstore

import "testing"

func TestBoundsAndSnapshotsLogs(t *testing.T) {
	store := New(2)
	store.Console("log", "one")
	store.Console("warn", "two")
	sequence := store.Sequence()
	store.Console("error", "three")
	store.Record("rules", "changed", "")
	snapshot := store.Snapshot(10)
	if len(snapshot.ConsoleLogs) != 2 || snapshot.ConsoleLogs[0].Message != "two" || len(snapshot.OperationLogs) != 1 {
		t.Fatalf("snapshot=%#v", snapshot)
	}
	updates, latest := store.Since(sequence)
	if len(updates.ConsoleLogs) != 1 || len(updates.OperationLogs) != 1 || latest <= sequence {
		t.Fatalf("updates=%#v latest=%d", updates, latest)
	}
}
