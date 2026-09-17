package database

import (
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func newTestDB(t *testing.T) *DB {
	t.Helper()
	sqlDB, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	db := &DB{sqlDB}
	if err := db.InitContainerMetricsTable(); err != nil {
		t.Fatalf("init table: %v", err)
	}
	return db
}

func insert(t *testing.T, db *DB, name string) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO container_metrics (timestamp, container_id, container_name, metrics_json) VALUES (?, ?, ?, ?)`,
		"2026-01-01T00:00:00Z", "id-"+name, name,
		`{"timestamp":"2026-01-01T00:00:00Z","Name":"`+name+`"}`,
	)
	if err != nil {
		t.Fatalf("insert %s: %v", name, err)
	}
}

// A Compose resource stores `<appName>-<service>-<replica>`; a Swarm service
// stores `<appName>.<slot>.<id>`. Querying by the bare appName must reach both.
func TestGetAllMetricsContainerMatchesComposeAndSwarmNames(t *testing.T) {
	const appName = "compose-generate-open-source-monitor-py5hih"

	tests := []struct {
		name      string
		stored    string
		wantMatch bool
	}{
		{"compose single-word service", appName + "-alloy-1", true},
		{"compose hyphenated service", appName + "-docker-socket-proxy-1", true},
		{"compose second replica", appName + "-alloy-2", true},
		{"swarm task", appName + ".1.abcdef", true},
		{"exact name", appName, true},
		{"different appName sharing a prefix", appName + "x-alloy-1", false},
		{"unrelated container", "some-other-app-xyz123-alloy-1", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db := newTestDB(t)
			insert(t, db, tc.stored)

			metrics, err := db.GetAllMetricsContainer(appName)
			if err != nil {
				t.Fatalf("query: %v", err)
			}
			if got := len(metrics) > 0; got != tc.wantMatch {
				t.Fatalf("stored %q: matched=%v, want %v", tc.stored, got, tc.wantMatch)
			}
		})
	}
}

func TestGetLastNContainerMetricsMatchesComposeNames(t *testing.T) {
	const appName = "javachat-dev-pkswmu"
	db := newTestDB(t)
	insert(t, db, appName+"-postgres-1")

	metrics, err := db.GetLastNContainerMetrics(appName, 10)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(metrics) != 1 {
		t.Fatalf("got %d metrics, want 1", len(metrics))
	}
}
