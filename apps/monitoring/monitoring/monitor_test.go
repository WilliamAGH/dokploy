package monitoring

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/mauriciogm/dokploy/apps/monitoring/database"
)

func TestSendInotifyAlertsGroupsHostUIDsAndRepeatsEachCheck(t *testing.T) {
	procRoot := t.TempDir()
	writeInotifyLimit(t, procRoot, 3)
	writeInotifyProcess(t, procRoot, "100", 1001, 4)
	writeInotifyProcess(t, procRoot, "101", 1002, 3)
	if err := os.Mkdir(filepath.Join(procRoot, "999"), 0o755); err != nil {
		t.Fatal(err)
	}
	counts, limit, err := inotifyInstanceCounts(procRoot)
	if err != nil || limit != 3 || len(counts) != 2 || counts[1001] != 4 || counts[1002] != 3 {
		t.Fatalf("unexpected inotify counts: error=%v limit=%d counts=%v", err, limit, counts)
	}

	var alerts []AlertPayload
	callback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var request struct {
			JSON AlertPayload `json:"json"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		alerts = append(alerts, request.JSON)
		w.WriteHeader(http.StatusOK)
	}))
	defer callback.Close()

	for i := 0; i < 2; i++ {
		if err := sendInotifyAlerts(procRoot, callback.URL, "Remote", "test-token", "2026-09-15T00:00:00Z"); err != nil {
			t.Fatal(err)
		}
	}

	if len(alerts) != 4 {
		t.Fatalf("received %d alerts, want 4", len(alerts))
	}
	countsByUID := map[string]int{}
	for _, alert := range alerts {
		if alert.ServerType != "Remote" || alert.Type != "Inotify" || alert.Threshold != 100 {
			t.Fatalf("unexpected alert: %+v", alert)
		}
		if !strings.Contains(alert.Message, "limit 3") {
			t.Fatalf("unexpected alert message: %q", alert.Message)
		}
		if strings.Contains(alert.Message, "host UID 1001") && strings.Contains(alert.Message, "estimated 4") && alert.Value == 400.0/3.0 {
			countsByUID["1001"]++
		} else if strings.Contains(alert.Message, "host UID 1002") && strings.Contains(alert.Message, "estimated 3") && alert.Value == 100 {
			countsByUID["1002"]++
		} else {
			t.Fatalf("unexpected alert: %+v", alert)
		}
	}
	if countsByUID["1001"] != 2 || countsByUID["1002"] != 2 {
		t.Fatalf("unexpected alerts by UID: %v", countsByUID)
	}
}

func TestSendInotifyAlertsDoesNotAggregateUIDs(t *testing.T) {
	procRoot := t.TempDir()
	writeInotifyLimit(t, procRoot, 3)
	writeInotifyProcess(t, procRoot, "100", 1001, 2)
	writeInotifyProcess(t, procRoot, "101", 1002, 2)

	alerts := 0
	callback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		alerts++
		w.WriteHeader(http.StatusOK)
	}))
	defer callback.Close()

	if err := sendInotifyAlerts(procRoot, callback.URL, "Remote", "test-token", "2026-09-15T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if alerts != 0 {
		t.Fatalf("received %d alerts for separately below-limit UIDs", alerts)
	}
}

func TestCheckThresholdsSendsInotifyWhenCPUAndMemoryAreDisabled(t *testing.T) {
	procRoot := t.TempDir()
	writeInotifyLimit(t, procRoot, 2)
	writeInotifyProcess(t, procRoot, "100", 1001, 2)

	var alert AlertPayload
	callback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&struct {
			JSON *AlertPayload `json:"json"`
		}{JSON: &alert}); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer callback.Close()

	t.Setenv("METRICS_CONFIG", `{"server":{"type":"Remote","token":"test-token","urlCallback":"`+callback.URL+`","thresholds":{"cpu":0,"memory":0}}}`)
	previousProcRoot := hostProcRoot
	hostProcRoot = procRoot
	t.Cleanup(func() { hostProcRoot = previousProcRoot })

	if err := CheckThresholds(database.ServerMetric{Timestamp: "2026-09-15T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if alert.Type != "Inotify" || alert.Value != 100 || alert.Threshold != 100 {
		t.Fatalf("unexpected alert: %+v", alert)
	}
}

func TestSendInotifyAlertsSuppressesIncompleteProcData(t *testing.T) {
	procRoot := t.TempDir()
	writeInotifyLimit(t, procRoot, 2)
	writeInotifyProcess(t, procRoot, "100", 1001, 2)
	fdPath := filepath.Join(procRoot, "100", "fd")
	if err := os.RemoveAll(fdPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fdPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	alerts := 0
	callback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		alerts++
		w.WriteHeader(http.StatusOK)
	}))
	defer callback.Close()

	if err := sendInotifyAlerts(procRoot, callback.URL, "Remote", "test-token", "2026-09-15T00:00:00Z"); err == nil {
		t.Fatal("expected incomplete proc error")
	}
	if alerts != 0 {
		t.Fatalf("received %d alerts from incomplete proc data", alerts)
	}
}

func writeInotifyLimit(t *testing.T, procRoot string, limit int) {
	t.Helper()
	path := filepath.Join(procRoot, "sys", "fs", "inotify")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "max_user_instances"), []byte(strconv.Itoa(limit)), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeInotifyProcess(t *testing.T, procRoot, pid string, uid, inotifyFDs int) {
	t.Helper()
	fdPath := filepath.Join(procRoot, pid, "fd")
	if err := os.MkdirAll(fdPath, 0o755); err != nil {
		t.Fatal(err)
	}
	status := "Name:\ttest\nUid:\t" + strconv.Itoa(uid) + "\t" + strconv.Itoa(uid) + "\t" + strconv.Itoa(uid) + "\t" + strconv.Itoa(uid) + "\n"
	if err := os.WriteFile(filepath.Join(procRoot, pid, "status"), []byte(status), 0o644); err != nil {
		t.Fatal(err)
	}
	for fd := 0; fd < inotifyFDs; fd++ {
		if err := os.Symlink("anon_inode:inotify", filepath.Join(fdPath, strconv.Itoa(fd))); err != nil {
			t.Fatal(err)
		}
	}
}
