package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const serviceName = "azure-panel-go-replenisher"

type config struct {
	Host                  string
	Port                  string
	Mode                  string
	Token                 string
	SubmitDeadlineSeconds int
}

type server struct {
	cfg       config
	startedAt time.Time
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

type dispatchResponse struct {
	Accepted              bool   `json:"accepted"`
	OperationID           string `json:"operationId"`
	Mode                  string `json:"mode"`
	DeadlineSeconds       int    `json:"deadlineSeconds"`
	Message               string `json:"message"`
	SubmittedAt           string `json:"submittedAt"`
	ObservedAccountPool   int    `json:"observedAccountPool"`
	ObservedCreateDeficit int    `json:"observedCreateDeficit"`
}

func main() {
	cfg := loadConfig()
	srv := &server{cfg: cfg, startedAt: time.Now()}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", srv.handleHealth)
	mux.HandleFunc("/v1/replenishment/dispatch", srv.handleDispatch)

	addr := net.JoinHostPort(cfg.Host, cfg.Port)
	log.Printf("%s starting on http://%s mode=%s deadline=%ds", serviceName, addr, cfg.Mode, cfg.SubmitDeadlineSeconds)
	if err := http.ListenAndServe(addr, withSecurityHeaders(mux)); err != nil {
		log.Fatalf("%s stopped: %v", serviceName, err)
	}
}

func loadConfig() config {
	host := env("GO_REPLENISHER_HOST", "127.0.0.1")
	port := env("GO_REPLENISHER_PORT", "43170")
	mode := strings.ToLower(env("GO_REPLENISHER_MODE", "observe"))
	if mode == "" {
		mode = "observe"
	}
	return config{
		Host:                  host,
		Port:                  port,
		Mode:                  mode,
		Token:                 os.Getenv("GO_REPLENISHER_TOKEN"),
		SubmitDeadlineSeconds: intEnv("GO_REPLENISHER_SUBMIT_DEADLINE_SECONDS", 30),
	}
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

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                    true,
		"service":               serviceName,
		"mode":                  s.cfg.Mode,
		"submitDeadlineSeconds": s.cfg.SubmitDeadlineSeconds,
		"uptimeSeconds":         int64(time.Since(s.startedAt).Seconds()),
		"startedAt":             s.startedAt.UTC().Format(time.RFC3339),
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

	operationID := newOperationID()
	log.Printf(
		"dispatch accepted operation=%s policy=%d user=%d deficit=%d pool=%d state=%s location=%s size=%s",
		operationID,
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
		OperationID:           operationID,
		Mode:                  s.cfg.Mode,
		DeadlineSeconds:       s.cfg.SubmitDeadlineSeconds,
		Message:               "accepted in observe mode; the Node worker keeps Azure ARM compatibility execution",
		SubmittedAt:           time.Now().UTC().Format(time.RFC3339),
		ObservedAccountPool:   req.AccountPoolSize,
		ObservedCreateDeficit: req.Deficit,
	})
}

func (s *server) authorize(r *http.Request) error {
	if s.cfg.Token == "" {
		return nil
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	token := strings.TrimSpace(r.Header.Get("X-Replenisher-Token"))
	if auth == "Bearer "+s.cfg.Token || token == s.cfg.Token {
		return nil
	}
	return errors.New("invalid replenisher token")
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
		next.ServeHTTP(w, r)
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
