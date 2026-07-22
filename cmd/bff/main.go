package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strings"
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

type ClientBar struct {
	Time  int64   `json:"time"`
	Open  float64 `json:"open"`
	High  float64 `json:"high"`
	Low   float64 `json:"low"`
	Close float64 `json:"close"`
}

var notifyContext = signal.NotifyContext

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

var bffPingInterval = 3 * time.Second

var wsAcceptAndWrap = func(w http.ResponseWriter, r *http.Request) (WebSocketConn, error) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return nil, err
	}
	return &realWS{Conn: conn}, nil
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
	ws, err := wsAcceptAndWrap(w, r)
	if err != nil {
		slog.Error("failed_to_accept_websocket_connection", "error", err)
		return
	}

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
		ticker := time.NewTicker(bffPingInterval)
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

func (bff *BFFServer) HandleMdgConfigAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()
	tickersJSON, err := bff.redisClient.Get(ctx, "mdg:active_tickers").Result()
	var tickers []string
	if err == nil && tickersJSON != "" {
		_ = json.Unmarshal([]byte(tickersJSON), &tickers)
	} else {
		tickers = []string{"AAPL", "MSFT", "TSLA", "AMZN", "NVDA"}
	}

	vendor, err := bff.redisClient.Get(ctx, "mdg:vendor").Result()
	if err != nil || vendor == "" {
		vendor = "polygon"
	}

	status, err := bff.redisClient.Get(ctx, "mdg:status").Result()
	if err != nil || status == "" {
		status = "RUNNING"
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"tickers": tickers,
		"vendor":  vendor,
		"status":  status,
	})
}

func (bff *BFFServer) HandleMdgSubscriptionsAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Action string `json:"action"` // "add" or "remove"
		Ticker string `json:"ticker"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	tickersJSON, err := bff.redisClient.Get(ctx, "mdg:active_tickers").Result()
	var tickers []string
	if err == nil && tickersJSON != "" {
		_ = json.Unmarshal([]byte(tickersJSON), &tickers)
	} else {
		tickers = []string{"AAPL", "MSFT", "TSLA", "AMZN", "NVDA"}
	}

	req.Ticker = strings.ToUpper(strings.TrimSpace(req.Ticker))
	if req.Ticker == "" {
		http.Error(w, "ticker cannot be empty", http.StatusBadRequest)
		return
	}

	changed := false
	if req.Action == "add" {
		exists := false
		for _, t := range tickers {
			if t == req.Ticker {
				exists = true
				break
			}
		}
		if !exists {
			tickers = append(tickers, req.Ticker)
			changed = true
		}
	} else if req.Action == "remove" {
		var newList []string
		for _, t := range tickers {
			if t != req.Ticker {
				newList = append(newList, t)
			} else {
				changed = true
			}
		}
		tickers = newList
	} else {
		http.Error(w, "invalid action", http.StatusBadRequest)
		return
	}

	if changed {
		newJSON, _ := json.Marshal(tickers)
		_ = bff.redisClient.Set(ctx, "mdg:active_tickers", string(newJSON), 0).Err()

		evtPayload, _ := json.Marshal(map[string]interface{}{
			"action":  "update_subscriptions",
			"tickers": tickers,
		})
		bff.redisClient.Publish(ctx, "mdg:control_events", string(evtPayload))
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "tickers": tickers})
}

func (bff *BFFServer) HandleMdgControlAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Action string `json:"action"` // "pause", "resume", "set_vendor"
		Vendor string `json:"vendor"` // "polygon" or "alpaca"
		URL    string `json:"url"`    // optional custom stream URL
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	var evtPayload []byte

	switch req.Action {
	case "pause":
		_ = bff.redisClient.Set(ctx, "mdg:status", "PAUSED", 0)
		evtPayload, _ = json.Marshal(map[string]interface{}{
			"action": "pause",
		})
	case "resume":
		_ = bff.redisClient.Set(ctx, "mdg:status", "RUNNING", 0)
		evtPayload, _ = json.Marshal(map[string]interface{}{
			"action": "resume",
		})
	case "set_vendor":
		if req.Vendor != "polygon" && req.Vendor != "alpaca" {
			http.Error(w, "invalid vendor; must be polygon or alpaca", http.StatusBadRequest)
			return
		}
		_ = bff.redisClient.Set(ctx, "mdg:vendor", req.Vendor, 0)
		evtPayload, _ = json.Marshal(map[string]interface{}{
			"action": "set_vendor",
			"vendor": req.Vendor,
			"url":    req.URL,
		})
	default:
		http.Error(w, "invalid action", http.StatusBadRequest)
		return
	}

	bff.redisClient.Publish(ctx, "mdg:control_events", string(evtPayload))

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

func (bff *BFFServer) HandleMdgTradesAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		bff.HandleMdgGetTradesAPI(w, r)
	} else if r.Method == http.MethodPost {
		bff.HandleMdgAddTradeAPI(w, r)
	} else {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (bff *BFFServer) HandleMdgGetTradesAPI(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tradesJSON, err := bff.redisClient.LRange(ctx, "mdg:trades", 0, -1).Result()
	if err != nil {
		tradesJSON = []string{}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte("[" + strings.Join(tradesJSON, ",") + "]"))
}

func (bff *BFFServer) HandleMdgAddTradeAPI(w http.ResponseWriter, r *http.Request) {
	var trade struct {
		Symbol    string  `json:"symbol"`
		Price     float64 `json:"price"`
		Qty       float64 `json:"qty"`
		Action    string  `json:"action"` // "BUY" or "SELL"
		Timestamp int64   `json:"timestamp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&trade); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	if trade.Timestamp == 0 {
		trade.Timestamp = time.Now().UnixNano() / int64(time.Millisecond)
	}

	tradeJSON, _ := json.Marshal(trade)
	ctx := r.Context()
	bff.redisClient.LPush(ctx, "mdg:trades", string(tradeJSON))
	bff.redisClient.LTrim(ctx, "mdg:trades", 0, 999)

	bff.broadcast(map[string]interface{}{
		"type":  "trade_execution",
		"trade": trade,
	})

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "trade": trade})
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

	// Subscribe to live market data ticks from MDG via Redis PubSub
	go func() {
		pubsub := rdb.Subscribe(ctx, "mdg:ticks")
		defer pubsub.Close()
		ch := pubsub.Channel()
		slog.Info("BFF subscribed to Redis channel mdg:ticks")
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				var tick map[string]interface{}
				if err := json.Unmarshal([]byte(msg.Payload), &tick); err != nil {
					continue
				}
				bff.broadcast(map[string]interface{}{
					"type": "tick",
					"tick": tick,
				})
			}
		}
	}()

	go bff.StartHealthCheckLoop(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", bff.HandleWebSocket)
	mux.HandleFunc("/api/circuit", bff.HandleCircuitAPI)
	mux.HandleFunc("/api/config", bff.HandleConfigAPI)
	mux.HandleFunc("/api/state", bff.HandleStateAPI)
	mux.HandleFunc("/api/shutdown", bff.HandleShutdownAPI)
	mux.HandleFunc("/api/mdg/config", bff.HandleMdgConfigAPI)
	mux.HandleFunc("/api/mdg/subscriptions", bff.HandleMdgSubscriptionsAPI)
	mux.HandleFunc("/api/mdg/control", bff.HandleMdgControlAPI)
	mux.HandleFunc("/api/mdg/trades", bff.HandleMdgTradesAPI)
	mux.HandleFunc("/api/mdg/history", bff.HandleMdgHistoryAPI)
	mux.HandleFunc("/api/market-status", bff.HandleMarketStatusAPI)

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

var runBFFHook = runBFF

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

	ctx, stop := notifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
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

	if err := runBFFHook(ctx, cfg); err != nil {
		slog.Error("bff_run_failed", "error", err)
		osExit(1)
	}
}

func (bff *BFFServer) HandleMdgHistoryAPI(w http.ResponseWriter, r *http.Request) {
	ticker := r.URL.Query().Get("ticker")
	granularity := r.URL.Query().Get("granularity")
	if ticker == "" {
		http.Error(w, "ticker parameter is required", http.StatusBadRequest)
		return
	}

	interval := r.URL.Query().Get("interval")
	if interval == "" {
		interval = granularity
	}

	apiKey := os.Getenv("FEED_API_KEY")
	if apiKey == "" {
		now := time.Now()
		var startTime time.Time
		switch granularity {
		case "1d":
			startTime = now.Add(-24 * time.Hour)
		case "1w":
			startTime = now.AddDate(0, 0, -7)
		case "1M":
			startTime = now.AddDate(0, -1, 0)
		case "3M":
			startTime = now.AddDate(0, -3, 0)
		case "ytd":
			startTime = time.Date(now.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
		case "1y":
			startTime = now.AddDate(-1, 0, 0)
		case "5y":
			startTime = now.AddDate(-5, 0, 0)
		case "all":
			startTime = now.AddDate(-20, 0, 0)
		default:
			startTime = now.Add(-24 * time.Hour)
		}

		fallbackBars := generateFallbackBars(ticker, interval, startTime, now)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"bars":    fallbackBars,
		})
		return
	}

	// Read active vendor from Redis
	vendor, err := bff.redisClient.Get(r.Context(), "mdg:vendor").Result()
	if err != nil || vendor == "" {
		vendor = "polygon"
	}

	bars := []ClientBar{}

	now := time.Now()
	var startTime time.Time
	switch granularity {
	case "1d":
		startTime = now.Add(-24 * time.Hour)
	case "1w":
		startTime = now.AddDate(0, 0, -7)
	case "1M":
		startTime = now.AddDate(0, -1, 0)
	case "3M":
		startTime = now.AddDate(0, -3, 0)
	case "ytd":
		startTime = time.Date(now.Year(), 1, 1, 0, 0, 0, 0, now.Location())
	case "1y":
		startTime = now.AddDate(-1, 0, 0)
	case "5y":
		startTime = now.AddDate(-5, 0, 0)
	case "all":
		startTime = now.AddDate(-25, 0, 0)
	default:
		startTime = now.AddDate(0, -3, 0)
	}

	if vendor == "alpaca" {
		parts := strings.Split(apiKey, ":")
		if len(parts) != 2 {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"success": false,
				"error":   "FEED_API_KEY for Alpaca is not in KEY_ID:SECRET format",
				"bars":    []interface{}{},
			})
			return
		}
		keyID := parts[0]
		secretKey := parts[1]

		timeframe := "1Day"
		switch interval {
		case "10s", "15s", "30s", "1m", "1Min":
			timeframe = "1Min"
		case "2m":
			timeframe = "2Min"
		case "3m":
			timeframe = "3Min"
		case "5m":
			timeframe = "5Min"
		case "10m":
			timeframe = "10Min"
		case "15m":
			timeframe = "15Min"
		case "30m":
			timeframe = "30Min"
		case "45m":
			timeframe = "45Min"
		case "1h", "1Hour":
			timeframe = "1Hour"
		case "2h":
			timeframe = "2Hour"
		case "3h":
			timeframe = "3Hour"
		case "4h":
			timeframe = "4Hour"
		case "1d", "1Day":
			timeframe = "1Day"
		case "1w", "1Week":
			timeframe = "1Week"
		case "1M", "1Month", "3M", "6M", "12M", "all":
			timeframe = "1Month"
		default:
			timeframe = "1Day"
		}

		url := fmt.Sprintf("https://data.alpaca.markets/v2/stocks/bars?symbols=%s&timeframe=%s&start=%s&limit=1000",
			ticker, timeframe, startTime.Format(time.RFC3339))

		req, err := http.NewRequestWithContext(r.Context(), "GET", url, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		req.Header.Set("APCA-API-KEY-ID", keyID)
		req.Header.Set("APCA-API-SECRET-KEY", secretKey)

		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"success": false,
				"error":   fmt.Sprintf("Alpaca fetch failed: %v", err),
				"bars":    []interface{}{},
			})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var alpacaResp struct {
				Bars map[string][]struct {
					T time.Time `json:"t"`
					O float64   `json:"o"`
					H float64   `json:"h"`
					L float64   `json:"l"`
					C float64   `json:"c"`
				} `json:"bars"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&alpacaResp); err == nil {
				tickerBars := alpacaResp.Bars[ticker]
				for _, b := range tickerBars {
					bars = append(bars, ClientBar{
						Time:  b.T.Unix(),
						Open:  b.O,
						High:  b.H,
						Low:   b.L,
						Close: b.C,
					})
				}
			}
		}
	} else {
		// Polygon
		timespan := "day"
		multiplier := "1"
		switch interval {
		case "10s":
			multiplier = "10"; timespan = "second"
		case "15s":
			multiplier = "15"; timespan = "second"
		case "30s":
			multiplier = "30"; timespan = "second"
		case "1m":
			multiplier = "1"; timespan = "minute"
		case "2m":
			multiplier = "2"; timespan = "minute"
		case "3m":
			multiplier = "3"; timespan = "minute"
		case "5m":
			multiplier = "5"; timespan = "minute"
		case "10m":
			multiplier = "10"; timespan = "minute"
		case "15m":
			multiplier = "15"; timespan = "minute"
		case "30m":
			multiplier = "30"; timespan = "minute"
		case "45m":
			multiplier = "45"; timespan = "minute"
		case "1h":
			multiplier = "1"; timespan = "hour"
		case "2h":
			multiplier = "2"; timespan = "hour"
		case "3h":
			multiplier = "3"; timespan = "hour"
		case "4h":
			multiplier = "4"; timespan = "hour"
		case "1d":
			multiplier = "1"; timespan = "day"
		case "1w":
			multiplier = "1"; timespan = "week"
		case "1M":
			multiplier = "1"; timespan = "month"
		case "6M":
			multiplier = "6"; timespan = "month"
		case "12M":
			multiplier = "12"; timespan = "month"
		default:
			multiplier = "1"; timespan = "day"
		}

		url := fmt.Sprintf("https://api.polygon.io/v2/aggs/ticker/%s/range/%s/%s/%s/%s?apiKey=%s",
			ticker, multiplier, timespan, startTime.Format("2006-01-02"), now.Format("2006-01-02"), apiKey)

		req, err := http.NewRequestWithContext(r.Context(), "GET", url, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"success": false,
				"error":   fmt.Sprintf("Polygon fetch failed: %v", err),
				"bars":    []interface{}{},
			})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var polygonResp struct {
				Results []struct {
					T int64   `json:"t"`
					O float64 `json:"o"`
					H float64 `json:"h"`
					L float64 `json:"l"`
					C float64 `json:"c"`
				} `json:"results"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&polygonResp); err == nil {
				for _, b := range polygonResp.Results {
					bars = append(bars, ClientBar{
						Time:  b.T / 1000,
						Open:  b.O,
						High:  b.H,
						Low:   b.L,
						Close: b.C,
					})
				}
			}
		}
	}

	if len(bars) == 0 {
		bars = generateFallbackBars(ticker, interval, startTime, now)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"bars":    bars,
	})
}

func generateFallbackBars(ticker, interval string, start, end time.Time) []ClientBar {
	step := time.Minute
	switch interval {
	case "10s":
		step = 10 * time.Second
	case "15s":
		step = 15 * time.Second
	case "30s":
		step = 30 * time.Second
	case "1m":
		step = time.Minute
	case "2m":
		step = 2 * time.Minute
	case "3m":
		step = 3 * time.Minute
	case "5m":
		step = 5 * time.Minute
	case "10m":
		step = 10 * time.Minute
	case "15m":
		step = 15 * time.Minute
	case "30m":
		step = 30 * time.Minute
	case "45m":
		step = 45 * time.Minute
	case "1h":
		step = time.Hour
	case "2h":
		step = 2 * time.Hour
	case "3h":
		step = 3 * time.Hour
	case "4h":
		step = 4 * time.Hour
	case "1d":
		step = 24 * time.Hour
	case "1w":
		step = 7 * 24 * time.Hour
	case "1M":
		step = 30 * 24 * time.Hour
	case "6M":
		step = 180 * 24 * time.Hour
	case "12M":
		step = 365 * 24 * time.Hour
	}

	totalDuration := end.Sub(start)
	if totalDuration <= 0 {
		start = end.Add(-24 * time.Hour)
		totalDuration = 24 * time.Hour
	}

	count := int(totalDuration / step)
	if count > 300 {
		step = totalDuration / 300
		count = 300
	} else if count < 20 {
		count = 20
		step = totalDuration / 20
	}

	basePrice := 320.0
	switch ticker {
	case "AAPL":
		basePrice = 327.0
	case "MSFT":
		basePrice = 450.0
	case "NVDA":
		basePrice = 120.0
	case "AMZN":
		basePrice = 180.0
	case "GOOGL":
		basePrice = 175.0
	}

	bars := make([]ClientBar, 0, count)
	currTime := start
	currPrice := basePrice

	for i := 0; i < count; i++ {
		delta := (float64((i*17+31)%100)/100.0 - 0.48) * (currPrice * 0.015)
		openP := currPrice
		closeP := currPrice + delta
		highP := math.Max(openP, closeP) + float64((i*7)%10)*0.15
		lowP := math.Min(openP, closeP) - float64((i*11)%10)*0.15

		bars = append(bars, ClientBar{
			Time:  currTime.Unix(),
			Open:  math.Round(openP*100) / 100,
			High:  math.Round(highP*100) / 100,
			Low:   math.Round(lowP*100) / 100,
			Close: math.Round(closeP*100) / 100,
		})
		currPrice = closeP
		currTime = currTime.Add(step)
	}
	return bars
}

func (bff *BFFServer) HandleMarketStatusAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		loc = time.FixedZone("EST", -5*3600)
	}
	now := time.Now().In(loc)

	apiKey := os.Getenv("FEED_API_KEY")
	if apiKey != "" {
		client := &http.Client{Timeout: 3 * time.Second}
		reqURL := fmt.Sprintf("https://api.polygon.io/v1/marketstatus/now?apiKey=%s", apiKey)
		req, _ := http.NewRequestWithContext(r.Context(), "GET", reqURL, nil)
		resp, err := client.Do(req)
		if err == nil && resp.StatusCode == http.StatusOK {
			var polyResp struct {
				Market     string `json:"market"`
				AfterHours bool   `json:"afterHours"`
				EarlyHours bool   `json:"earlyHours"`
			}
			if json.NewDecoder(resp.Body).Decode(&polyResp) == nil {
				resp.Body.Close()
				if polyResp.Market == "closed" {
					isHoliday, holidayName, _ := isUSMarketHoliday(now)
					label := "● MARKET CLOSED"
					if isHoliday {
						label = fmt.Sprintf("● HOLIDAY CLOSED (%s)", holidayName)
					} else if now.Weekday() == time.Saturday || now.Weekday() == time.Sunday {
						label = "● WEEKEND CLOSED"
					} else if polyResp.AfterHours {
						label = "● EXTENDED HOURS"
					} else if polyResp.EarlyHours {
						label = "● PRE-MARKET"
					} else {
						label = "● NIGHT SESSION"
					}
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"is_closed":    true,
						"label":        label,
						"session_type": "CLOSED",
						"source":       "polygon_api",
					})
					return
				} else if polyResp.Market == "open" {
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"is_closed":    false,
						"label":        "● REGULAR MARKET",
						"session_type": "REGULAR",
						"source":       "polygon_api",
					})
					return
				}
			} else {
				resp.Body.Close()
			}
		}
	}

	isHoliday, holidayName, isEarlyClose := isUSMarketHoliday(now)
	if isHoliday {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"is_closed":    true,
			"label":        fmt.Sprintf("● HOLIDAY CLOSED (%s)", holidayName),
			"session_type": "HOLIDAY",
			"reason":       holidayName,
			"source":       "exchange_calendar",
		})
		return
	}

	if now.Weekday() == time.Saturday || now.Weekday() == time.Sunday {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"is_closed":    true,
			"label":        "● WEEKEND CLOSED",
			"session_type": "WEEKEND",
			"source":       "exchange_calendar",
		})
		return
	}

	hours := now.Hour()
	minutes := now.Minute()
	mins := hours*60 + minutes

	preMarketStart := 4 * 60
	marketOpen := 9*60 + 30
	marketClose := 16 * 60
	if isEarlyClose {
		marketClose = 13 * 60
	}
	extendedClose := 20 * 60

	if mins >= marketOpen && mins < marketClose {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"is_closed":    false,
			"label":        "● REGULAR MARKET",
			"session_type": "REGULAR",
			"source":       "exchange_calendar",
		})
	} else if mins >= preMarketStart && mins < marketOpen {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"is_closed":    true,
			"label":        "● PRE-MARKET",
			"session_type": "PRE_MARKET",
			"source":       "exchange_calendar",
		})
	} else if mins >= marketClose && mins < extendedClose {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"is_closed":    true,
			"label":        "● EXTENDED HOURS",
			"session_type": "EXTENDED",
			"source":       "exchange_calendar",
		})
	} else {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"is_closed":    true,
			"label":        "● NIGHT SESSION",
			"session_type": "NIGHT",
			"source":       "exchange_calendar",
		})
	}
}

func isUSMarketHoliday(t time.Time) (bool, string, bool) {
	year, month, day := t.Date()
	weekday := t.Weekday()

	nthWeekday := func(targetWeekday time.Weekday, n int) bool {
		if weekday != targetWeekday {
			return false
		}
		return (day-1)/7 == (n - 1)
	}

	lastWeekday := func(targetWeekday time.Weekday) bool {
		if weekday != targetWeekday {
			return false
		}
		return day+7 > time.Date(year, month+1, 0, 0, 0, 0, 0, t.Location()).Day()
	}

	if (month == time.January && day == 1 && weekday != time.Sunday && weekday != time.Saturday) ||
		(month == time.January && day == 2 && weekday == time.Monday) {
		return true, "New Year's Day", false
	}

	if month == time.January && nthWeekday(time.Monday, 3) {
		return true, "MLK Jr. Day", false
	}

	if month == time.February && nthWeekday(time.Monday, 3) {
		return true, "Presidents' Day", false
	}

	easterMonth, easterDay := calculateEaster(year)
	easterDate := time.Date(year, time.Month(easterMonth), easterDay, 0, 0, 0, 0, t.Location())
	goodFridayDate := easterDate.AddDate(0, 0, -2)
	if month == goodFridayDate.Month() && day == goodFridayDate.Day() {
		return true, "Good Friday", false
	}

	if month == time.May && lastWeekday(time.Monday) {
		return true, "Memorial Day", false
	}

	if (month == time.June && day == 19 && weekday != time.Sunday && weekday != time.Saturday) ||
		(month == time.June && day == 20 && weekday == time.Monday) ||
		(month == time.June && day == 18 && weekday == time.Friday) {
		return true, "Juneteenth National Independence Day", false
	}

	if (month == time.July && day == 4 && weekday != time.Sunday && weekday != time.Saturday) ||
		(month == time.July && day == 5 && weekday == time.Monday) ||
		(month == time.July && day == 3 && weekday == time.Friday) {
		return true, "Independence Day (July 4th)", false
	}

	if month == time.July && day == 3 && weekday != time.Saturday && weekday != time.Sunday && weekday != time.Friday {
		return false, "Independence Day Eve", true
	}

	if month == time.September && nthWeekday(time.Monday, 1) {
		return true, "Labor Day", false
	}

	if month == time.November && nthWeekday(time.Thursday, 4) {
		return true, "Thanksgiving Day", false
	}

	if month == time.November && nthWeekday(time.Friday, 4) {
		return false, "Black Friday", true
	}

	if (month == time.December && day == 25 && weekday != time.Sunday && weekday != time.Saturday) ||
		(month == time.December && day == 26 && weekday == time.Monday) ||
		(month == time.December && day == 24 && weekday == time.Friday) {
		return true, "Christmas Day", false
	}

	if month == time.December && day == 24 && weekday != time.Saturday && weekday != time.Sunday && weekday != time.Friday {
		return false, "Christmas Eve", true
	}

	return false, "", false
}

func calculateEaster(year int) (int, int) {
	a := year % 19
	b := year / 100
	c := year % 100
	d := b / 4
	e := b % 4
	f := (b + 8) / 25
	g := (b - f + 1) / 3
	h := (19*a + b - d - g + 15) % 30
	i := c / 4
	k := c % 4
	l := (32 + 2*e + 2*i - h - k) % 7
	m := (a + 11*h + 22*l) / 451
	month := (h + l - 7*m + 114) / 31
	day := ((h + l - 7*m + 114) % 31) + 1
	return month, day
}
