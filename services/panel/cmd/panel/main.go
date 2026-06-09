package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const serviceName = "azure-panel-go"

type config struct {
	AppDir                string
	Host                  string
	Port                  string
	Mode                  string
	Token                 string
	StaticDir             string
	NodeCompatEnabled     bool
	NodeCompatURL         string
	SubmitDeadlineSeconds int
	QueueLimit            int
}

type server struct {
	cfg         config
	startedAt   time.Time
	nodeProxy   *httputil.ReverseProxy
	nodeBaseURL *url.URL
	queue       *dispatchQueue
}

type dispatchRequest struct {
	PolicyID                    int    `json:"policyId"`
	UserID                      int    `json:"userId"`
	Deficit                     int    `json:"deficit"`
	TargetCount                 int    `json:"targetCount"`
	TrackedCount                int    `json:"trackedCount"`
	AccountPoolSize             int    `json:"accountPoolSize"`
	TriggerAccountName          string `json:"triggerAccountName"`
	SubscriptionState           string `json:"subscriptionState"`
	Location                    string `json:"location"`
	VMSize                      string `json:"vmSize"`
	EnableIPv6                  bool   `json:"enableIpv6"`
	EnableAcceleratedNetworking bool   `json:"enableAcceleratedNetworking"`
	EnableDdosProtection        bool   `json:"enableDdosProtection"`
	IPPrefix                    string `json:"ipPrefix"`
	IPBrushMaxAttempts          int    `json:"ipBrushMaxAttempts"`
}

type dispatchTask struct {
	OperationID string          `json:"operationId"`
	Status      string          `json:"status"`
	Message     string          `json:"message"`
	Payload     dispatchRequest `json:"payload"`
	SubmittedAt time.Time       `json:"submittedAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

type dispatchResponse struct {
	Accepted              bool   `json:"accepted"`
	OperationID           string `json:"operationId"`
	Mode                  string `json:"mode"`
	DeadlineSeconds       int    `json:"deadlineSeconds"`
	Message               string `json:"message"`
	SubmittedAt           string `json:"submittedAt"`
	ObservedAccountPool   int    `json:"observedAccountPool"`
	ObservedCreateDeficit int    `json:"observedCreateDeficit"`
	QueueDepth            int    `json:"queueDepth"`
}

type dispatchQueue struct {
	mu     sync.RWMutex
	limit  int
	tasks  []dispatchTask
	byID   map[string]int
	latest map[int]string
}

type clientBundle struct {
	StartScript string
	AppScript   string
	Stylesheets []string
	VersionHash string
}

var sveltekitGlobalPattern = regexp.MustCompile(`__sveltekit_[A-Za-z0-9_]+`)

func newDispatchQueue(limit int) *dispatchQueue {
	if limit <= 0 {
		limit = 128
	}
	return &dispatchQueue{
		limit:  limit,
		byID:   map[string]int{},
		latest: map[int]string{},
	}
}

func (q *dispatchQueue) add(payload dispatchRequest) dispatchTask {
	now := time.Now().UTC()
	task := dispatchTask{
		OperationID: newOperationID(),
		Status:      "queued",
		Message:     "queued by Go panel",
		Payload:     payload,
		SubmittedAt: now,
		UpdatedAt:   now,
	}

	q.mu.Lock()
	defer q.mu.Unlock()

	q.tasks = append(q.tasks, task)
	q.reindexLocked()
	if len(q.tasks) > q.limit {
		q.tasks = q.tasks[len(q.tasks)-q.limit:]
		q.reindexLocked()
	}
	q.latest[payload.PolicyID] = task.OperationID
	return task
}

func (q *dispatchQueue) list() []dispatchTask {
	q.mu.RLock()
	defer q.mu.RUnlock()
	out := make([]dispatchTask, len(q.tasks))
	copy(out, q.tasks)
	sort.Slice(out, func(i, j int) bool {
		return out[i].SubmittedAt.After(out[j].SubmittedAt)
	})
	return out
}

func (q *dispatchQueue) get(operationID string) (dispatchTask, bool) {
	q.mu.RLock()
	defer q.mu.RUnlock()
	idx, ok := q.byID[operationID]
	if !ok || idx < 0 || idx >= len(q.tasks) {
		return dispatchTask{}, false
	}
	return q.tasks[idx], true
}

func (q *dispatchQueue) depth() int {
	q.mu.RLock()
	defer q.mu.RUnlock()
	return len(q.tasks)
}

func (q *dispatchQueue) latestForPolicy(policyID int) (dispatchTask, bool) {
	q.mu.RLock()
	operationID := q.latest[policyID]
	q.mu.RUnlock()
	if operationID == "" {
		return dispatchTask{}, false
	}
	return q.get(operationID)
}

func (q *dispatchQueue) reindexLocked() {
	q.byID = map[string]int{}
	for i, task := range q.tasks {
		q.byID[task.OperationID] = i
	}
}

func main() {
	loadDotEnv()
	cfg := loadConfig()
	srv, err := newServer(cfg)
	if err != nil {
		log.Fatalf("%s config failed: %v", serviceName, err)
	}

	addr := net.JoinHostPort(cfg.Host, cfg.Port)
	log.Printf(
		"%s starting on http://%s mode=%s nodeCompat=%v node=%s static=%s queueLimit=%d",
		serviceName,
		addr,
		cfg.Mode,
		cfg.NodeCompatEnabled,
		cfg.NodeCompatURL,
		cfg.StaticDir,
		cfg.QueueLimit,
	)

	httpServer := &http.Server{
		Addr:              addr,
		Handler:           withSecurityHeaders(withAccessLog(srv)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      35 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("%s stopped: %v", serviceName, err)
	}
}

func newServer(cfg config) (*server, error) {
	srv := &server{
		cfg:       cfg,
		startedAt: time.Now(),
		queue:     newDispatchQueue(cfg.QueueLimit),
	}
	if cfg.NodeCompatEnabled {
		base, err := url.Parse(cfg.NodeCompatURL)
		if err != nil {
			return nil, fmt.Errorf("GO_PANEL_NODE_COMPAT_URL invalid: %w", err)
		}
		proxy := httputil.NewSingleHostReverseProxy(base)
		originalDirector := proxy.Director
		proxy.Director = func(r *http.Request) {
			originalHost := r.Host
			originalDirector(r)
			r.Host = base.Host
			r.Header.Set("X-Go-Panel", serviceName)
			r.Header.Set("X-Forwarded-Host", originalHost)
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("node compatibility proxy failed path=%s error=%v", r.URL.Path, err)
			if wantsJSON(r) || strings.HasPrefix(r.URL.Path, "/api/") {
				writeError(w, http.StatusBadGateway, "Go panel compatibility backend is unavailable")
				return
			}
			srv.handleGoShell(w, r)
		}
		srv.nodeProxy = proxy
		srv.nodeBaseURL = base
	}
	return srv, nil
}

func loadConfig() config {
	appDir := env("AZURE_PANEL_APP_DIR", env("APP_DIR", mustGetwd()))
	host := env("GO_PANEL_HOST", env("HOST", "127.0.0.1"))
	port := env("GO_PANEL_PORT", env("PORT", "3000"))
	nodeCompatPort := env("GO_PANEL_NODE_COMPAT_PORT", "3001")
	nodeCompatURL := env("GO_PANEL_NODE_COMPAT_URL", "http://127.0.0.1:"+nodeCompatPort)
	staticDir := env("GO_PANEL_STATIC_DIR", filepath.Join(appDir, "build", "client"))
	if !filepath.IsAbs(staticDir) {
		staticDir = filepath.Join(appDir, staticDir)
	}
	mode := strings.ToLower(env("GO_PANEL_MODE", "go"))
	if mode == "" {
		mode = "go"
	}
	return config{
		AppDir:                appDir,
		Host:                  host,
		Port:                  port,
		Mode:                  mode,
		// Legacy GO_REPLENISHER_* values are read only so existing .env files keep working.
		Token:                 env("GO_PANEL_TOKEN", env("GO_REPLENISHER_TOKEN", "")),
		StaticDir:             staticDir,
		NodeCompatEnabled:     truthy(env("GO_PANEL_NODE_COMPAT_ENABLED", "true")),
		NodeCompatURL:         nodeCompatURL,
		SubmitDeadlineSeconds: intEnv("GO_PANEL_SUBMIT_DEADLINE_SECONDS", intEnv("GO_REPLENISHER_SUBMIT_DEADLINE_SECONDS", 30)),
		QueueLimit:            intEnv("GO_PANEL_QUEUE_LIMIT", 128),
	}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/api/health" || r.URL.Path == "/health":
		s.handleHealth(w, r)
	case r.URL.Path == "/api/go/status":
		s.handleStatus(w, r)
	case r.URL.Path == "/api/go/replenishment/tasks":
		s.handleDispatchTasks(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/go/replenishment/tasks/"):
		s.handleDispatchTask(w, r)
	case r.URL.Path == "/v1/replenishment/dispatch":
		s.handleDispatch(w, r)
	case strings.HasPrefix(r.URL.Path, "/_app/"):
		s.handleStatic(w, r)
	case s.shouldServeStaticAsset(r):
		s.handleStatic(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/") && s.cfg.NodeCompatEnabled && s.nodeProxy != nil:
		s.nodeProxy.ServeHTTP(w, r)
	default:
		s.handleGoShell(w, r)
	}
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	nodeStatus := "disabled"
	if s.cfg.NodeCompatEnabled {
		nodeStatus = "unreachable"
		if s.nodeHealthOK() {
			nodeStatus = "ok"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                    true,
		"service":               serviceName,
		"mode":                  s.cfg.Mode,
		"goFirst":               true,
		"runtime":               "go",
		"nodeCompatEnabled":     s.cfg.NodeCompatEnabled,
		"nodeCompatStatus":      nodeStatus,
		"nodeCompatUrl":         redactURL(s.cfg.NodeCompatURL),
		"staticDir":             s.cfg.StaticDir,
		"staticReady":           s.staticReady(),
		"queueDepth":            s.queue.depth(),
		"submitDeadlineSeconds": s.cfg.SubmitDeadlineSeconds,
		"uptimeSeconds":         int64(time.Since(s.startedAt).Seconds()),
		"startedAt":             s.startedAt.UTC().Format(time.RFC3339),
	})
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"service": serviceName,
		"architecture": map[string]any{
			"web":        "go",
			"api":        "go",
			"worker":     "go-dispatch",
			"compatMode": s.cfg.NodeCompatEnabled,
		},
		"routes": []string{
			"/api/health",
			"/api/go/status",
			"/api/go/replenishment/tasks",
			"/api/go/replenishment/tasks/{operationId}",
			"/v1/replenishment/dispatch",
			"/_app/*",
		},
		"queueDepth": s.queue.depth(),
	})
}

func (s *server) handleDispatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err := s.authorize(r); err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}

	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	decoder.DisallowUnknownFields()

	var req dispatchRequest
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid dispatch payload: %v", err))
		return
	}
	if err := validateDispatch(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	task := s.queue.add(req)
	log.Printf(
		"go dispatch queued operation=%s policy=%d user=%d deficit=%d pool=%d state=%s location=%s size=%s",
		task.OperationID,
		req.PolicyID,
		req.UserID,
		req.Deficit,
		req.AccountPoolSize,
		req.SubscriptionState,
		req.Location,
		req.VMSize,
	)

	writeJSON(w, http.StatusAccepted, dispatchResponse{
		Accepted:              true,
		OperationID:           task.OperationID,
		Mode:                  s.cfg.Mode,
		DeadlineSeconds:       s.cfg.SubmitDeadlineSeconds,
		Message:               "queued by Go panel dispatch layer",
		SubmittedAt:           task.SubmittedAt.Format(time.RFC3339),
		ObservedAccountPool:   req.AccountPoolSize,
		ObservedCreateDeficit: req.Deficit,
		QueueDepth:            s.queue.depth(),
	})
}

func (s *server) handleDispatchTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err := s.authorize(r); err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}

	if rawPolicyID := strings.TrimSpace(r.URL.Query().Get("policyId")); rawPolicyID != "" {
		policyID, err := strconv.Atoi(rawPolicyID)
		if err != nil || policyID <= 0 {
			writeError(w, http.StatusBadRequest, "policyId must be positive")
			return
		}
		task, ok := s.queue.latestForPolicy(policyID)
		if !ok {
			writeError(w, http.StatusNotFound, "task not found")
			return
		}
		writeJSON(w, http.StatusOK, task)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"tasks": s.queue.list(),
		"depth": s.queue.depth(),
	})
}

func (s *server) handleDispatchTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err := s.authorize(r); err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	operationID := strings.TrimPrefix(r.URL.Path, "/api/go/replenishment/tasks/")
	operationID = strings.Trim(operationID, "/")
	if operationID == "" {
		writeError(w, http.StatusBadRequest, "operationId is required")
		return
	}
	task, ok := s.queue.get(operationID)
	if !ok {
		writeError(w, http.StatusNotFound, "task not found")
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (s *server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	fullPath, ok := safeStaticPath(s.cfg.StaticDir, r.URL.Path)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid static path")
		return
	}
	if _, err := os.Stat(fullPath); err != nil {
		if s.cfg.NodeCompatEnabled && s.nodeProxy != nil && strings.HasPrefix(r.URL.Path, "/_app/") {
			s.nodeProxy.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/_app/immutable/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
	http.ServeFile(w, r, fullPath)
}

func (s *server) handleGoShell(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusNotFound, "route not found")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "route not found")
		return
	}
	if pathHasExtension(r.URL.Path) {
		s.handleStatic(w, r)
		return
	}
	if s.serveStaticAppShell(w, r) {
		return
	}
	s.serveBuiltInShell(w, r)
}

func (s *server) serveStaticAppShell(w http.ResponseWriter, r *http.Request) bool {
	indexPath := filepath.Join(s.cfg.StaticDir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		bundle, ok := s.findClientBundle()
		if !ok {
			return false
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, renderClientShell(bundle))
		return true
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, indexPath)
	return true
}

func (s *server) findClientBundle() (clientBundle, bool) {
	entryDir := filepath.Join(s.cfg.StaticDir, "_app", "immutable", "entry")
	startFiles, _ := filepath.Glob(filepath.Join(entryDir, "start.*.js"))
	appFiles, _ := filepath.Glob(filepath.Join(entryDir, "app.*.js"))
	sort.Strings(startFiles)
	sort.Strings(appFiles)
	if len(startFiles) == 0 || len(appFiles) == 0 {
		return clientBundle{}, false
	}

	styleFiles, _ := filepath.Glob(filepath.Join(s.cfg.StaticDir, "_app", "immutable", "assets", "*.css"))
	sort.Strings(styleFiles)

	bundle := clientBundle{
		StartScript: s.staticURL(startFiles[0]),
		AppScript:   s.staticURL(appFiles[0]),
		Stylesheets: make([]string, 0, len(styleFiles)),
		VersionHash: s.detectSvelteKitVersionHash(appFiles[0]),
	}
	for _, style := range styleFiles {
		bundle.Stylesheets = append(bundle.Stylesheets, s.staticURL(style))
	}
	return bundle, true
}

func (s *server) staticURL(path string) string {
	rel, err := filepath.Rel(s.cfg.StaticDir, path)
	if err != nil {
		return "/" + filepath.ToSlash(filepath.Base(path))
	}
	return "/" + filepath.ToSlash(rel)
}

func (s *server) detectSvelteKitVersionHash(appScript string) string {
	content, err := os.ReadFile(appScript)
	if err != nil {
		return ""
	}
	return sveltekitGlobalPattern.FindString(string(content))
}

func renderClientShell(bundle clientBundle) string {
	var styles strings.Builder
	for _, stylesheet := range bundle.Stylesheets {
		styles.WriteString(`<link rel="stylesheet" href="`)
		styles.WriteString(html.EscapeString(stylesheet))
		styles.WriteString(`">` + "\n")
	}

	startScript, _ := json.Marshal(bundle.StartScript)
	appScript, _ := json.Marshal(bundle.AppScript)
	var globalInit string
	if bundle.VersionHash != "" {
		globalInit = fmt.Sprintf("globalThis.%s={base:\"\",assets:\"\"};", bundle.VersionHash)
	}

	return fmt.Sprintf(`<!doctype html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Azure Panel</title>
  %s
</head>
<body data-sveltekit-preload-data="hover" class="bg-background text-white antialiased">
  <div style="display: contents">
    <div id="go-panel-boot-error" style="display:none;padding:24px;color:#fca5a5;background:#111827;font:14px system-ui"></div>
    <script type="module">
      %s
      const element = document.currentScript.parentElement;
      Promise.all([import(%s), import(%s)]).then(([kit, app]) => {
        kit.start(app, element);
      }).catch((err) => {
        console.error(err);
        const target = document.getElementById('go-panel-boot-error');
        target.style.display = 'block';
        target.textContent = 'Azure Panel 前端启动失败: ' + (err && err.message ? err.message : String(err));
      });
    </script>
  </div>
</body>
</html>`, styles.String(), globalInit, string(startScript), string(appScript))
}

func (s *server) serveBuiltInShell(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, `<!doctype html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Azure Panel Go</title>
  <style>
    :root{color-scheme:dark}
    body{margin:0;background:#070b12;color:#eef3ff;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{min-height:100vh;display:grid;place-items:center;padding:32px}
    .panel{width:min(760px,100%);border:1px solid #263244;background:#0d1320;border-radius:10px;padding:28px;box-shadow:0 20px 80px #0008}
    h1{margin:0 0 8px;font-size:28px}.muted{color:#9aa8bf}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:22px}
    .item{border:1px solid #263244;border-radius:8px;padding:14px;background:#111a2a}.ok{color:#6ee7a8}code{color:#93c5fd}
  </style>
</head>
<body>
<main>
  <section class="panel">
    <h1>Azure Panel Go</h1>
    <p class="muted">Go 主进程已接管面板入口。构建后的前端静态文件缺失时会显示这个内置状态页。</p>
    <div class="grid">
      <div class="item"><strong>Web</strong><br><span class="ok">Go</span></div>
      <div class="item"><strong>Health</strong><br><code>/api/health</code></div>
      <div class="item"><strong>Go Status</strong><br><code>/api/go/status</code></div>
      <div class="item"><strong>Dispatch</strong><br><code>/v1/replenishment/dispatch</code></div>
    </div>
    <p class="muted" id="status" style="margin-top:22px">正在读取运行状态...</p>
  </section>
</main>
<script>
fetch('/api/health').then(r=>r.json()).then(data=>{
  document.getElementById('status').textContent='运行状态: '+JSON.stringify(data);
}).catch(err=>{
  document.getElementById('status').textContent='运行状态读取失败: '+err.message;
});
</script>
</body>
</html>`)
}

func (s *server) shouldServeStaticAsset(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	path := strings.TrimSpace(r.URL.Path)
	if path == "" || path == "/" || strings.HasPrefix(path, "/api/") {
		return false
	}
	return pathHasExtension(path)
}

func (s *server) staticReady() bool {
	if _, err := os.Stat(filepath.Join(s.cfg.StaticDir, "_app")); err == nil {
		return true
	}
	if _, err := os.Stat(filepath.Join(s.cfg.StaticDir, "index.html")); err == nil {
		return true
	}
	return false
}

func (s *server) authorize(r *http.Request) error {
	if s.cfg.Token == "" {
		return nil
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	token := strings.TrimSpace(r.Header.Get("X-Go-Panel-Token"))
	legacyToken := strings.TrimSpace(r.Header.Get("X-Replenisher-Token"))
	if auth == "Bearer "+s.cfg.Token || token == s.cfg.Token || legacyToken == s.cfg.Token {
		return nil
	}
	return errors.New("invalid go panel token")
}

func (s *server) nodeHealthOK() bool {
	if s.nodeBaseURL == nil {
		return false
	}
	client := http.Client{Timeout: 900 * time.Millisecond}
	healthURL := *s.nodeBaseURL
	healthURL.Path = "/api/health"
	resp, err := client.Get(healthURL.String())
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 500
}

func validateDispatch(req dispatchRequest) error {
	if req.PolicyID <= 0 {
		return errors.New("policyId must be positive")
	}
	if req.UserID <= 0 {
		return errors.New("userId must be positive")
	}
	if req.Deficit <= 0 {
		return errors.New("deficit must be positive")
	}
	if strings.TrimSpace(req.Location) == "" {
		return errors.New("location is required")
	}
	if strings.TrimSpace(req.VMSize) == "" {
		return errors.New("vmSize is required")
	}
	return nil
}

func safeStaticPath(root, requestPath string) (string, bool) {
	trimmed := strings.TrimPrefix(requestPath, "/")
	cleanPath := filepath.Clean(trimmed)
	if cleanPath == "." || strings.HasPrefix(cleanPath, "..") {
		return "", false
	}
	fullPath := filepath.Join(root, cleanPath)
	staticRoot := filepath.Clean(root) + string(os.PathSeparator)
	cleanFullPath := filepath.Clean(fullPath)
	if cleanFullPath != filepath.Clean(root) && !strings.HasPrefix(cleanFullPath, staticRoot) {
		return "", false
	}
	return fullPath, true
}

func pathHasExtension(path string) bool {
	base := filepath.Base(path)
	if !strings.Contains(base, ".") {
		return false
	}
	ext := filepath.Ext(base)
	return ext != "" && mime.TypeByExtension(ext) != ""
}

func wantsJSON(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "application/json") ||
		strings.Contains(r.Header.Get("Content-Type"), "application/json")
}

func newOperationID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func withAccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		if r.URL.Path == "/api/health" {
			return
		}
		log.Printf("%s %s %s", r.Method, r.URL.RequestURI(), time.Since(started).Round(time.Millisecond))
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write json failed: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"ok":      false,
		"message": message,
	})
}

func loadDotEnv() {
	appDir := env("AZURE_PANEL_APP_DIR", env("APP_DIR", mustGetwd()))
	candidates := []string{
		filepath.Join(appDir, ".env"),
		filepath.Join(mustGetwd(), ".env"),
	}
	for _, candidate := range candidates {
		content, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(content), "\n") {
			key, value, ok := parseEnvLine(line)
			if !ok || os.Getenv(key) != "" {
				continue
			}
			_ = os.Setenv(key, value)
		}
		return
	}
}

func parseEnvLine(line string) (string, string, bool) {
	line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
	if line == "" || strings.HasPrefix(line, "#") {
		return "", "", false
	}
	line = strings.TrimPrefix(line, "export ")
	parts := strings.SplitN(line, "=", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	key := strings.TrimSpace(parts[0])
	value := strings.TrimSpace(parts[1])
	if key == "" {
		return "", "", false
	}
	if len(value) >= 2 {
		first := value[0]
		last := value[len(value)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
			value = value[1 : len(value)-1]
		}
	}
	return key, value, true
}

func env(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func intEnv(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func truthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on", "enabled":
		return true
	default:
		return false
	}
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if u.User != nil {
		u.User = url.User("***")
	}
	return u.String()
}
