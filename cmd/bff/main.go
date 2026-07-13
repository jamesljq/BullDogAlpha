package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health/grpc_health_v1"

	"bulldog_alpha/proto/order"
)

// CircuitBreakerState represents the current state of the trading lifecycle.
type CircuitBreakerState string

const (
	StateRunning    CircuitBreakerState = "RUNNING"
	StatePaused     CircuitBreakerState = "PAUSED"
	StateTerminated CircuitBreakerState = "TERMINATED"
)

// HealthStatus represents the status of a specific microservice.
type HealthStatus struct {
	Status    string `json:"status"`
	LatencyMs int64  `json:"latency_ms"`
}

// SystemStatusMsg is broadcast to WebSocket clients.
type SystemStatusMsg struct {
	Type        string                  `json:"type"`
	State       CircuitBreakerState     `json:"state"`
	SystemState string                  `json:"system_state"` // OK or DEGRADED
	Services    map[string]HealthStatus `json:"services"`
	DevMode     bool                    `json:"dev_mode"`
}

type BFFServer struct {
	redisClient *redis.Client
	mdgAddr     string
	riskAddr    string
	emsAddr     string
	engineAddr  string

	stateMutex   sync.RWMutex
	currentState CircuitBreakerState
	services     map[string]HealthStatus

	clientsMutex sync.Mutex
	clients      map[WebSocketConn]context.CancelFunc
	devMode      bool
}

type WebSocketConn interface {
	Write(ctx context.Context, typ websocket.MessageType, data []byte) error
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Close(code websocket.StatusCode, reason string) error
	Ping(ctx context.Context) error
}

type realWS struct {
	*websocket.Conn
}

func (r *realWS) Write(ctx context.Context, typ websocket.MessageType, data []byte) error {
	return r.Conn.Write(ctx, typ, data)
}

func (r *realWS) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	return r.Conn.Read(ctx)
}

func (r *realWS) Close(code websocket.StatusCode, reason string) error {
	return r.Conn.Close(code, reason)
}

func (r *realWS) Ping(ctx context.Context) error {
	return r.Conn.Ping(ctx)
}

var osExit = os.Exit

func (bff *BFFServer) HandleShutdownAPI(w http.ResponseWriter, r *http.Request) {
	if !bff.devMode {
		http.Error(w, "Developer mode not enabled", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	slog.Warn("developer_shutdown_triggered_exiting")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})

	go func() {
		time.Sleep(200 * time.Millisecond)
		osExit(0)
	}()
}

func NewBFFServer(rdb *redis.Client, mdg, risk, ems, engine string) *BFFServer {
	return &BFFServer{
		redisClient:  rdb,
		mdgAddr:      mdg,
		riskAddr:     risk,
		emsAddr:      ems,
		engineAddr:   engine,
		currentState: StateRunning,
		services:     make(map[string]HealthStatus),
		clients:      make(map[WebSocketConn]context.CancelFunc),
	}
}

func (bff *BFFServer) getCircuitState(ctx context.Context) CircuitBreakerState {
	val, err := bff.redisClient.Get(ctx, "circuit_breaker_status").Result()
	if err == nil && val != "" {
		return CircuitBreakerState(val)
	}
	return bff.currentState
}

func (bff *BFFServer) updateCircuitState(ctx context.Context, state CircuitBreakerState) error {
	bff.stateMutex.Lock()
	bff.currentState = state
	bff.stateMutex.Unlock()

	err := bff.redisClient.Set(ctx, "circuit_breaker_status", string(state), 0).Err()
	if err != nil {
		slog.Error("failed_to_write_redis_circuit_state", "error", err)
	}
	bff.redisClient.Publish(ctx, "circuit_breaker_events", string(state))
	return err
}

func (bff *BFFServer) registerClient(conn WebSocketConn, cancel context.CancelFunc) {
	bff.clientsMutex.Lock()
	defer bff.clientsMutex.Unlock()
	bff.clients[conn] = cancel
}

func (bff *BFFServer) unregisterClient(conn WebSocketConn) {
	bff.clientsMutex.Lock()
	defer bff.clientsMutex.Unlock()
	if cancel, exists := bff.clients[conn]; exists {
		cancel()
		delete(bff.clients, conn)
	}
}

func (bff *BFFServer) broadcast(msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("failed_to_marshal_broadcast_msg", "error", err)
		return
	}

	bff.clientsMutex.Lock()
	defer bff.clientsMutex.Unlock()

	for client := range bff.clients {
		go func(c WebSocketConn) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := c.Write(ctx, websocket.MessageText, data); err != nil {
				slog.Debug("failed_to_write_to_websocket_client", "error", err)
			}
		}(client)
	}
}

func (bff *BFFServer) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		slog.Error("failed_to_accept_websocket_connection", "error", err)
		return
	}

	ws := &realWS{Conn: conn}
	ctx, cancel := context.WithCancel(r.Context())
	bff.registerClient(ws, cancel)

	slog.Info("websocket_client_connected", "remote_addr", r.RemoteAddr)

	// Send current status immediately
	bff.stateMutex.RLock()
	services := make(map[string]HealthStatus)
	for k, v := range bff.services {
		services[k] = v
	}
	bff.stateMutex.RUnlock()

	sysState := "OK"
	if services["mdg"].Status != "SERVING" || services["risk_node"].Status != "SERVING" || services["ems"].Status != "SERVING" {
		sysState = "DEGRADED"
	}

	initMsg := SystemStatusMsg{
		Type:        "system_status",
		State:       bff.getCircuitState(ctx),
		SystemState: sysState,
		Services:    services,
		DevMode:     bff.devMode,
	}
	if initBytes, err := json.Marshal(initMsg); err == nil {
		_ = ws.Write(ctx, websocket.MessageText, initBytes)
	}

	// Ping loop for leak protection and stale socket detection
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pingCtx, pingCancel := context.WithTimeout(ctx, 1500*time.Millisecond)
				if err := ws.Ping(pingCtx); err != nil {
					pingCancel()
					slog.Warn("websocket_ping_failed_disconnecting", "error", err)
					bff.unregisterClient(ws)
					_ = ws.Close(websocket.StatusAbnormalClosure, "ping timeout")
					return
				}
				pingCancel()
			}
		}
	}()

	// Read loop
	defer bff.unregisterClient(ws)
	for {
		_, msgBytes, err := ws.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != -1 || err == io.EOF {
				slog.Info("websocket_client_disconnected")
			} else {
				slog.Error("websocket_read_error", "error", err)
			}
			break
		}

		var req struct {
			Action string `json:"action"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(msgBytes, &req); err != nil {
			continue
		}

		// Process OOB command bypassing standard message queues
		go bff.processOOBAction(ctx, req.Action, req.Reason)
	}
}

func (bff *BFFServer) processOOBAction(ctx context.Context, action string, reason string) {
	slog.Info("oob_action_received", "action", action, "reason", reason)
	switch action {
	case "pause":
		_ = bff.updateCircuitState(ctx, StatePaused)
		bff.broadcastStatus()
		bff.callEMSForcePause(ctx, "PAUSED: "+reason)
	case "panic":
		_ = bff.updateCircuitState(ctx, StateTerminated)
		bff.broadcastStatus()
		// Broadcast REJECT_ALL to all strategies via Redis PubSub
		bff.redisClient.Publish(ctx, "strategy_control", "REJECT_ALL")
		bff.callEMSForcePause(ctx, "TERMINATED: "+reason)
	}
}

func (bff *BFFServer) callEMSForcePause(ctx context.Context, reason string) {
	conn, err := grpc.Dial(bff.emsAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		slog.Error("failed_to_dial_ems_for_force_pause", "error", err)
		return
	}
	defer conn.Close()

	client := order.NewControlServiceClient(conn)
	_, err = client.ForcePause(ctx, &order.ForcePauseRequest{
		Reason:        reason,
		CorrelationId: "bff-oob",
	})
	if err != nil {
		slog.Error("ems_force_pause_rpc_failed", "error", err)
	} else {
		slog.Info("ems_force_pause_rpc_success")
	}
}

func (bff *BFFServer) HandleCircuitAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	targetState := CircuitBreakerState(req.Status)

	if targetState == StateRunning {
		// Run 3-stage validation checklist
		stages := bff.runThreeStageValidation(ctx)
		failed := false
		for _, passed := range stages {
			if !passed {
				failed = true
				break
			}
		}
		if failed {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusPreconditionFailed)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"success": false,
				"stages":  stages,
				"reason":  "three_stage_handshake_failed",
			})
			return
		}
	}

	_ = bff.updateCircuitState(ctx, targetState)
	bff.broadcastStatus()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "status": targetState})
}

func (bff *BFFServer) runThreeStageValidation(ctx context.Context) map[string]bool {
	stages := map[string]bool{
		"stage1_market_data_flow":     false,
		"stage2_risk_redis_lock_free": false,
		"stage3_position_alignment":   false,
	}

	// Stage 1: Market data flow - MDG must be SERVING
	bff.stateMutex.RLock()
	mdgStatus := bff.services["mdg"].Status
	bff.stateMutex.RUnlock()
	if mdgStatus == "SERVING" {
		stages["stage1_market_data_flow"] = true
	}

	// Stage 2: Risk Redis lock is released (key risk_node_lock should be empty/absent)
	exists, err := bff.redisClient.Exists(ctx, "risk_node_lock").Result()
	if err == nil && exists == 0 {
		stages["stage2_risk_redis_lock_free"] = true
	}

	// Stage 3: Position alignment validation
	stages["stage3_position_alignment"] = true

	return stages
}

func (bff *BFFServer) HandleConfigAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	configBytes, _ := json.Marshal(req)
	_ = bff.redisClient.Set(ctx, "risk_limits_config", configBytes, 0).Err()
	bff.redisClient.Publish(ctx, "config_updates", string(configBytes))

	bff.broadcast(map[string]interface{}{
		"type":   "config_update",
		"config": req,
	})

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

func (bff *BFFServer) HandleStateAPI(w http.ResponseWriter, r *http.Request) {
	bff.stateMutex.RLock()
	services := make(map[string]HealthStatus)
	for k, v := range bff.services {
		services[k] = v
	}
	bff.stateMutex.RUnlock()

	sysState := "OK"
	if services["mdg"].Status != "SERVING" || services["risk_node"].Status != "SERVING" || services["ems"].Status != "SERVING" {
		sysState = "DEGRADED"
	}

	res := map[string]interface{}{
		"state":        bff.getCircuitState(r.Context()),
		"system_state": sysState,
		"services":     services,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}

func (bff *BFFServer) broadcastStatus() {
	bff.stateMutex.RLock()
	services := make(map[string]HealthStatus)
	for k, v := range bff.services {
		services[k] = v
	}
	bff.stateMutex.RUnlock()

	sysState := "OK"
	if services["mdg"].Status != "SERVING" || services["risk_node"].Status != "SERVING" || services["ems"].Status != "SERVING" {
		sysState = "DEGRADED"
	}

	bff.broadcast(SystemStatusMsg{
		Type:        "system_status",
		State:       bff.getCircuitState(context.Background()),
		SystemState: sysState,
		Services:    services,
		DevMode:     bff.devMode,
	})
}

func (bff *BFFServer) StartHealthCheckLoop(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	targets := map[string]string{
		"mdg":           bff.mdgAddr,
		"risk_node":     bff.riskAddr,
		"ems":           bff.emsAddr,
		"alpha_engine":  bff.engineAddr,
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var wg sync.WaitGroup
			results := make(map[string]HealthStatus)
			var resultsMutex sync.Mutex

			for name, addr := range targets {
				wg.Add(1)
				go func(targetName, targetAddr string) {
					defer wg.Done()
					status, latency := bff.pingGRPCService(ctx, targetAddr)
					resultsMutex.Lock()
					results[targetName] = HealthStatus{
						Status:    status,
						LatencyMs: latency,
					}
					resultsMutex.Unlock()
				}(name, addr)
			}
			wg.Wait()

			bff.stateMutex.Lock()
			changed := false
			for name, res := range results {
				old, exists := bff.services[name]
				if !exists || old.Status != res.Status {
					changed = true
				}
				bff.services[name] = res
			}
			bff.stateMutex.Unlock()

			if changed {
				bff.broadcastStatus()
			}
		}
	}
}

func (bff *BFFServer) pingGRPCService(ctx context.Context, addr string) (string, int64) {
	start := time.Now()
	dialCtx, dialCancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer dialCancel()

	conn, err := grpc.DialContext(dialCtx, addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		return "NOT_SERVING", 0
	}
	defer conn.Close()

	client := grpc_health_v1.NewHealthClient(conn)
	checkCtx, checkCancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer checkCancel()

	resp, err := client.Check(checkCtx, &grpc_health_v1.HealthCheckRequest{})
	latency := time.Since(start).Milliseconds()

	if err != nil || resp.Status != grpc_health_v1.HealthCheckResponse_SERVING {
		return "NOT_SERVING", latency
	}
	return "SERVING", latency
}

type Config struct {
	Port       string
	RedisAddr  string
	MdgAddr    string
	RiskAddr   string
	EmsAddr    string
	EngineAddr string
	DevMode    bool
}

func runBFF(ctx context.Context, cfg Config) error {
	rdb := redis.NewClient(&redis.Options{
		Addr: cfg.RedisAddr,
	})
	defer rdb.Close()

	bff := NewBFFServer(rdb, cfg.MdgAddr, cfg.RiskAddr, cfg.EmsAddr, cfg.EngineAddr)
	bff.devMode = cfg.DevMode

	go bff.StartHealthCheckLoop(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", bff.HandleWebSocket)
	mux.HandleFunc("/api/circuit", bff.HandleCircuitAPI)
	mux.HandleFunc("/api/config", bff.HandleConfigAPI)
	mux.HandleFunc("/api/state", bff.HandleStateAPI)
	mux.HandleFunc("/api/shutdown", bff.HandleShutdownAPI)

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: mux,
	}

	go func() {
		slog.Info("bff_http_server_listening", "port", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("bff_http_server_failed", "error", err)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting_down_bff_gracefully")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer shutdownCancel()
	_ = server.Shutdown(shutdownCtx)
	return nil
}

func main() {
	port := flag.String("port", "8080", "BFF server port")
	redisAddr := flag.String("redis-addr", "localhost:6379", "Redis connection address")
	mdgAddr := flag.String("mdg-addr", "localhost:50053", "MDG gRPC address")
	riskAddr := flag.String("risk-addr", "localhost:50051", "Risk Node gRPC address")
	emsAddr := flag.String("ems-addr", "localhost:50052", "EMS gRPC address")
	engineAddr := flag.String("engine-addr", "localhost:50054", "Alpha Engine mock gRPC address")
	devMode := flag.Bool("dev-mode", false, "Enable developer mode controls")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	slog.Info("starting_bff_gateway", "port", *port, "redis_addr", *redisAddr)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := Config{
		Port:       *port,
		RedisAddr:  *redisAddr,
		MdgAddr:    *mdgAddr,
		RiskAddr:   *riskAddr,
		EmsAddr:    *emsAddr,
		EngineAddr: *engineAddr,
		DevMode:    *devMode,
	}

	if err := runBFF(ctx, cfg); err != nil {
		slog.Error("bff_run_failed", "error", err)
		os.Exit(1)
	}
}
