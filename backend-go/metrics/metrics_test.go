package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// The linter catches the naming mistakes that are invisible until a dashboard
// is being written and a metric turns out not to mean what its name says:
// counters that do not end in `_total`, units missing from the name, help text
// that is absent. Cheap to run, and the alternative is finding out in Grafana.
func TestRegistryPassesPrometheusLint(t *testing.T) {
	problems, err := testutil.GatherAndLint(Registry)
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, p := range problems {
		// The Go and process collectors are upstream's and are exempt: several
		// of their names predate the conventions the linter enforces, and they
		// are not ours to rename.
		if strings.HasPrefix(p.Metric, "go_") || strings.HasPrefix(p.Metric, "process_") {
			continue
		}
		t.Errorf("%s: %s", p.Metric, p.Text)
	}
}

// Every metric declared here must carry help text. A series with no help is one
// nobody can use six months later without reading the source that emitted it.
func TestEveryMetricHasHelp(t *testing.T) {
	families, err := Registry.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	seen := 0
	for _, f := range families {
		if !strings.HasPrefix(f.GetName(), "qt_") {
			continue
		}
		seen++
		if strings.TrimSpace(f.GetHelp()) == "" {
			t.Errorf("%s has no help text", f.GetName())
		}
	}
	if seen == 0 {
		t.Fatal("no qt_ metrics registered at all")
	}
}

// Seed exists so a dashboard shows 0 rather than "No data" on a fresh process,
// and so `rate()` does not read a counter's first appearance as a reset.
func TestSeedCreatesTheFixedSeries(t *testing.T) {
	Seed("NSE", "MCX")

	for _, source := range []string{"feed", "black76", "none"} {
		if got := testutil.ToFloat64(IVSource.WithLabelValues(source)); got != 0 {
			t.Errorf("iv source %q seeded at %v, want 0", source, got)
		}
	}
	for _, ex := range []string{"NSE", "MCX"} {
		if got := testutil.ToFloat64(MarketOpen.WithLabelValues(ex)); got != 0 {
			t.Errorf("market_open %q seeded at %v, want 0", ex, got)
		}
	}
	// Feeds are deliberately NOT seeded: the registry is configured at runtime,
	// and inventing a series for a broker nobody enabled would be its own lie.
	if count := testutil.CollectAndCount(Active); count != 0 {
		t.Errorf("qt_feed_active has %d series before any feed ran, want 0", count)
	}
}

func TestHandlerServesExpositionFormat(t *testing.T) {
	Points.Inc()

	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("scrape → %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"# HELP qt_engine_points_total",
		"# TYPE qt_engine_points_total counter",
		"go_goroutines",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("scrape output is missing %q", want)
		}
	}
}

// The wrapper must label by the ROUTE it was given, never by the request path —
// an unrouted URL would otherwise mint a permanent series per scanner probe.
func TestInstrumentRecordsStatusAndRoute(t *testing.T) {
	before := testutil.ToFloat64(httpRequests.WithLabelValues("/v1/test", "418"))

	h := Instrument("/v1/test", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/whatever-the-client-asked-for", nil))

	if rec.Code != http.StatusTeapot {
		t.Fatalf("handler returned %d", rec.Code)
	}
	if got := testutil.ToFloat64(httpRequests.WithLabelValues("/v1/test", "418")); got != before+1 {
		t.Errorf("request counter = %v, want %v", got, before+1)
	}
	if got := testutil.CollectAndCount(httpDuration); got == 0 {
		t.Error("no duration observed")
	}
}

// A handler that writes a body without calling WriteHeader has implicitly
// answered 200, and the recorder must report that rather than defaulting to
// whatever it was initialised with.
func TestInstrumentDefaultsToTwoHundred(t *testing.T) {
	before := testutil.ToFloat64(httpRequests.WithLabelValues("/v1/implicit", "200"))

	h := Instrument("/v1/implicit", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	h(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))

	if got := testutil.ToFloat64(httpRequests.WithLabelValues("/v1/implicit", "200")); got != before+1 {
		t.Errorf("implicit 200 not recorded: %v", got)
	}
}
