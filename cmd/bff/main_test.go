package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"

	"bulldog_alpha/proto/order"
)

// MockControlServer implements the ControlService gRPC interface.
type MockControlServer struct {
	order.UnimplementedControlServiceServer
	mu            sync.Mutex
	lastReason    string
	pauseReceived bool
}

func (m *MockControlServer) ForcePause(ctx context.Context, req *order.ForcePauseRequest) (*order.ForcePauseResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastReason = req.Reason
	m.pauseReceived = true
	return &order.ForcePauseResponse{Success: true, CorrelationId: req.CorrelationId}, nil
}

type MockWSConn struct {
	mu        sync.Mutex
	writeChan chan []byte
	readChan  chan []byte
	pingChan  chan struct{}
	closed    bool
}

func NewMockWSConn() *MockWSConn {
	return &MockWSConn{
		writeChan: make(chan []byte, 100),
		readChan:  make(chan []byte, 100),
		pingChan:  make(chan struct{}, 100),
	}
}

func (m *MockWSConn) Write(ctx context.Context, typ websocket.MessageType, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return fmt.Errorf("connection closed")
	}
	m.writeChan <- data
	return nil
}

func (m *MockWSConn) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	select {
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	case data := <-m.readChan:
		return websocket.MessageText, data, nil
	}
}

func (m *MockWSConn) Close(code websocket.StatusCode, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	return nil
}

func (m *MockWSConn) Ping(ctx context.Context) error {
	m.pingChan <- struct{}{}
	return nil
}

func startMockGRPCHealthServer(t *testing.T) (*grpc.Server, string, *health.Server, *MockControlServer) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}

	s := grpc.NewServer()
	hServer := health.NewServer()
	grpc_health_v1.RegisterHealthServer(s, hServer)
	hServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)

	controlSrv := &MockControlServer{}
	order.RegisterControlServiceServer(s, controlSrv)

	go func() {
		_ = s.Serve(lis)
	}()

	return s, lis.Addr().String(), hServer, controlSrv
}

func TestBFFWebSocketLeak(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	// High frequency reconnect test
	conns := make([]*MockWSConn, 50)
	for i := 0; i < 50; i++ {
		conns[i] = NewMockWSConn()
		_, cancel := context.WithCancel(context.Background())
		bff.registerClient(conns[i], cancel)
	}

	if len(bff.clients) != 50 {
		t.Errorf("expected 50 clients, got %d", len(bff.clients))
	}

	// Disconnect them all and assert cleanup
	for i := 0; i < 50; i++ {
		bff.unregisterClient(conns[i])
	}

	if len(bff.clients) != 0 {
		t.Errorf("expected 0 clients after cleanup, got %d", len(bff.clients))
	}
}

func TestBFFCascadeDegradation(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	// Spin up 4 mock gRPC health servers
	s1, addr1, h1, _ := startMockGRPCHealthServer(t)
	defer s1.GracefulStop()
	s2, addr2, h2, _ := startMockGRPCHealthServer(t)
	defer s2.GracefulStop()
	s3, addr3, _, _ := startMockGRPCHealthServer(t)
	defer s3.GracefulStop()
	s4, addr4, _, _ := startMockGRPCHealthServer(t)
	defer s4.GracefulStop()

	bff := NewBFFServer(rdb, addr1, addr2, addr3, addr4)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start health checking loop
	go bff.StartHealthCheckLoop(ctx)

	// Connect a WebSocket client mock
	ws := NewMockWSConn()
	_, wsCancel := context.WithCancel(ctx)
	bff.registerClient(ws, wsCancel)

	// Wait for first health updates to populate
	time.Sleep(800 * time.Millisecond)

	// Set risk_node to NOT_SERVING to trigger cascade degradation
	h2.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)

	// Expect system status to transition to DEGRADED and broadcast within 1 second
	deadline := time.After(1200 * time.Millisecond)
	degradedReceived := false

	for !degradedReceived {
		select {
		case <-deadline:
			t.Fatal("timed out waiting for SYSTEM_DEGRADED status push")
		case msgBytes := <-ws.writeChan:
			var status SystemStatusMsg
			if err := json.Unmarshal(msgBytes, &status); err == nil {
				if status.Type == "system_status" && status.SystemState == "DEGRADED" {
					degradedReceived = true
				}
			}
		}
	}

	// Turn risk_node back to SERVING, but MDG to NOT_SERVING
	h2.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	h1.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)

	degradedReceived = false
	deadline = time.After(1200 * time.Millisecond)
	for !degradedReceived {
		select {
		case <-deadline:
			t.Fatal("timed out waiting for SYSTEM_DEGRADED status push on MDG outage")
		case msgBytes := <-ws.writeChan:
			var status SystemStatusMsg
			if err := json.Unmarshal(msgBytes, &status); err == nil {
				if status.SystemState == "DEGRADED" {
					degradedReceived = true
				}
			}
		}
	}
}

func TestBFFBigRedButtonPriority(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	s, emsAddr, _, emsCtrl := startMockGRPCHealthServer(t)
	defer s.GracefulStop()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", emsAddr, "127.0.0.1:0")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ws := NewMockWSConn()
	_, wsCancel := context.WithCancel(ctx)
	bff.registerClient(ws, wsCancel)

	// Simulate receiving a "panic" command from client via websocket
	payload := `{"action": "panic", "reason": "market crash"}`
	ws.readChan <- []byte(payload)

	// Verify Redis broadcast to strategies (subscribe before publishing)
	pubsub := rdb.Subscribe(ctx, "strategy_control")
	defer pubsub.Close()
	ch := pubsub.Channel()

	// Read and process the message (normally run in HandleWebSocket loop, we test processOOBAction directly here)
	bff.processOOBAction(ctx, "panic", "market crash")

	// Verify Circuit Breaker state was updated to TERMINATED
	state := bff.getCircuitState(ctx)
	if state != StateTerminated {
		t.Errorf("expected TERMINATED state, got %s", state)
	}

	// Verify EMS Ctrl Server received ForcePause call
	time.Sleep(100 * time.Millisecond)
	emsCtrl.mu.Lock()
	defer emsCtrl.mu.Unlock()
	if !emsCtrl.pauseReceived {
		t.Fatal("EMS ForcePause RPC was not called")
	}
	if !strings.Contains(emsCtrl.lastReason, "TERMINATED: market crash") {
		t.Errorf("unexpected pause reason sent to EMS: %s", emsCtrl.lastReason)
	}

	select {
	case msg := <-ch:
		if msg.Payload != "REJECT_ALL" {
			t.Errorf("expected REJECT_ALL pubsub message, got %s", msg.Payload)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for Redis pubsub strategy broadcast")
	}
}

func TestBFFThreeStageResumeHandshake(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	s, emsAddr, _, _ := startMockGRPCHealthServer(t)
	defer s.GracefulStop()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", emsAddr, "127.0.0.1:0")

	// Put it in PAUSED state first
	_ = bff.updateCircuitState(context.Background(), StatePaused)

	// Case 1: Market data check fails because MDG is NOT_SERVING
	bff.services["mdg"] = HealthStatus{Status: "NOT_SERVING"}
	stages := bff.runThreeStageValidation(context.Background())
	if stages["stage1_market_data_flow"] {
		t.Error("expected stage 1 (market data flow) to fail")
	}

	// Case 2: Market data check passes, but Risk redis lock is active
	bff.services["mdg"] = HealthStatus{Status: "SERVING"}
	_ = rdb.Set(context.Background(), "risk_node_lock", "locked", 0).Err()
	stages = bff.runThreeStageValidation(context.Background())
	if !stages["stage1_market_data_flow"] {
		t.Error("expected stage 1 to pass")
	}
	if stages["stage2_risk_redis_lock_free"] {
		t.Error("expected stage 2 (risk lock free) to fail when lock is set")
	}

	// Case 3: All stages pass
	_ = rdb.Del(context.Background(), "risk_node_lock").Err()
	stages = bff.runThreeStageValidation(context.Background())
	if !stages["stage1_market_data_flow"] || !stages["stage2_risk_redis_lock_free"] || !stages["stage3_position_alignment"] {
		t.Errorf("expected all stages to pass, got: %+v", stages)
	}

	// Validate REST request API response handling
	ts := httptest.NewServer(http.HandlerFunc(bff.HandleCircuitAPI))
	defer ts.Close()

	// First try to resume when MDG is unhealthy
	bff.services["mdg"] = HealthStatus{Status: "NOT_SERVING"}
	reqBody := `{"status": "RUNNING", "reason": "resume trading"}`
	resp, err := http.Post(ts.URL, "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatalf("post failed: %v", err)
	}
	if resp.StatusCode != http.StatusPreconditionFailed {
		t.Errorf("expected HTTP 412, got %d", resp.StatusCode)
	}

	// Now fix MDG health and retry
	bff.services["mdg"] = HealthStatus{Status: "SERVING"}
	resp, err = http.Post(ts.URL, "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatalf("post failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", resp.StatusCode)
	}
	if bff.getCircuitState(context.Background()) != StateRunning {
		t.Errorf("expected status to change to RUNNING, got %s", bff.currentState)
	}
}

func TestBFFDynamicConfigPublishing(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	ts := httptest.NewServer(http.HandlerFunc(bff.HandleConfigAPI))
	defer ts.Close()

	pubsub := rdb.Subscribe(context.Background(), "config_updates")
	defer pubsub.Close()
	ch := pubsub.Channel()

	reqBody := `{"max_position": 500, "max_leverage": 1.2}`
	resp, err := http.Post(ts.URL, "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatalf("post failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", resp.StatusCode)
	}

	// Assert message received in Redis pub/sub
	select {
	case msg := <-ch:
		var config map[string]interface{}
		if err := json.Unmarshal([]byte(msg.Payload), &config); err != nil {
			t.Fatalf("failed to unmarshal pubsub: %v", err)
		}
		if config["max_position"].(float64) != 500 || config["max_leverage"].(float64) != 1.2 {
			t.Errorf("unexpected config published: %+v", config)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for config_updates Redis pub/sub broadcast")
	}

	// Assert Redis storage key matches
	val, err := rdb.Get(context.Background(), "risk_limits_config").Result()
	if err != nil {
		t.Fatalf("failed to retrieve config key: %v", err)
	}
	if !strings.Contains(val, `"max_position":500`) {
		t.Errorf("unexpected stored config: %s", val)
	}
}

func TestBFFWebSocketReal(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	s, emsAddr, _, _ := startMockGRPCHealthServer(t)
	defer s.GracefulStop()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", emsAddr, "127.0.0.1:0")

	// Set up server and handler
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", bff.HandleWebSocket)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + ts.URL[4:] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket Dial failed: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Read initial message
	_, msgBytes, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read initial system status: %v", err)
	}
	var initMsg SystemStatusMsg
	if err := json.Unmarshal(msgBytes, &initMsg); err != nil {
		t.Fatalf("failed to unmarshal system status: %v", err)
	}
	if initMsg.Type != "system_status" {
		t.Errorf("expected Type system_status, got %s", initMsg.Type)
	}

	// Start a background read loop to process WebSocket control frames (Ping/Pong)
	go func() {
		for {
			_, _, err := conn.Read(ctx)
			if err != nil {
				return
			}
		}
	}()

	// Trigger ping
	err = conn.Ping(ctx)
	if err != nil {
		t.Errorf("ping failed: %v", err)
	}

	// Send pause action
	actionMsg := `{"action": "pause", "reason": "user pause"}`
	err = conn.Write(ctx, websocket.MessageText, []byte(actionMsg))
	if err != nil {
		t.Fatalf("write failed: %v", err)
	}

	// Wait for status update
	time.Sleep(100 * time.Millisecond)
	if bff.getCircuitState(ctx) != StatePaused {
		t.Errorf("expected circuit state to be PAUSED, got %s", bff.currentState)
	}
}

func TestBFFCoverageHelpers(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	s, emsAddr, hSrv, _ := startMockGRPCHealthServer(t)
	defer s.GracefulStop()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", emsAddr, "127.0.0.1:0")

	// 1. Test pingGRPCService error & success branches
	ctx := context.Background()
	status, _ := bff.pingGRPCService(ctx, "invalid_address:9999")
	if status != "NOT_SERVING" {
		t.Errorf("expected NOT_SERVING for invalid address, got %s", status)
	}

	status, _ = bff.pingGRPCService(ctx, emsAddr)
	if status != "SERVING" {
		t.Errorf("expected SERVING, got %s", status)
	}

	hSrv.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)
	status, _ = bff.pingGRPCService(ctx, emsAddr)
	if status != "NOT_SERVING" {
		t.Errorf("expected NOT_SERVING, got %s", status)
	}

	// 2. Test HandleStateAPI
	stateRec := httptest.NewRecorder()
	stateReq := httptest.NewRequest("GET", "/api/state", nil)
	bff.HandleStateAPI(stateRec, stateReq)
	if stateRec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", stateRec.Code)
	}

	// 3. Test HandleCircuitAPI invalid method
	circRec := httptest.NewRecorder()
	circReq := httptest.NewRequest("GET", "/api/circuit", nil)
	bff.HandleCircuitAPI(circRec, circReq)
	if circRec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405, got %d", circRec.Code)
	}

	// 4. Test HandleCircuitAPI invalid JSON
	circRec = httptest.NewRecorder()
	circReq = httptest.NewRequest("POST", "/api/circuit", strings.NewReader("invalid_json"))
	bff.HandleCircuitAPI(circRec, circReq)
	if circRec.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", circRec.Code)
	}

	// 5. Test HandleConfigAPI invalid method
	confRec := httptest.NewRecorder()
	confReq := httptest.NewRequest("GET", "/api/config", nil)
	bff.HandleConfigAPI(confRec, confReq)
	if confRec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405, got %d", confRec.Code)
	}

	// 6. Test HandleConfigAPI invalid JSON
	confRec = httptest.NewRecorder()
	confReq = httptest.NewRequest("POST", "/api/config", strings.NewReader("invalid_json"))
	bff.HandleConfigAPI(confRec, confReq)
	if confRec.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", confRec.Code)
	}

	// 7. Test realWS coverage using httptest server
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", bff.HandleWebSocket)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	wsURL := "ws" + ts.URL[4:] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket Dial failed: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Start background read loop for client connection so Ping doesn't deadlock
	go func() {
		for {
			_, _, err := conn.Read(ctx)
			if err != nil {
				return
			}
		}
	}()

	rws := &realWS{Conn: conn}
	_ = rws.Ping(ctx)
	_ = rws.Write(ctx, websocket.MessageText, []byte(`{"action":"pause"}`))
	_ = rws.Close(websocket.StatusNormalClosure, "test close")
}

func TestBFFRunApp(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel context immediately to exit runBFF without blocking

	cfg := Config{
		Port:       "0", // random port
		RedisAddr:  mr.Addr(),
		MdgAddr:    "127.0.0.1:0",
		RiskAddr:   "127.0.0.1:0",
		EmsAddr:    "127.0.0.1:0",
		EngineAddr: "127.0.0.1:0",
	}

	err = runBFF(ctx, cfg)
	if err != nil {
		t.Errorf("runBFF failed: %v", err)
	}
}

func TestBFFShutdownAPI(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	// 1. DevMode false, should return Forbidden
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/shutdown", nil)
	bff.HandleShutdownAPI(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403 Forbidden, got %d", rec.Code)
	}

	// 2. DevMode true, Method GET, should return Method Not Allowed
	bff.devMode = true
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/shutdown", nil)
	bff.HandleShutdownAPI(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405 Method Not Allowed, got %d", rec.Code)
	}

	// 3. DevMode true, Method POST, should succeed and call osExit
	var exitCalled bool
	var exitCode int
	oldExit := osExit
	osExit = func(code int) {
		exitCalled = true
		exitCode = code
	}
	defer func() { osExit = oldExit }()

	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/shutdown", nil)
	bff.HandleShutdownAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 OK, got %d", rec.Code)
	}

	// Wait a moment for the exit goroutine to execute
	time.Sleep(300 * time.Millisecond)
	if !exitCalled {
		t.Error("expected osExit to be called")
	}
	if exitCode != 0 {
		t.Errorf("expected exit code 0, got %d", exitCode)
	}
}

func TestBFFMdgConfigAPI(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	// 1. GET /api/mdg/config - initial state
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/mdg/config", nil)
	bff.HandleMdgConfigAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 2. POST /api/mdg/config - method not allowed
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/config", nil)
	bff.HandleMdgConfigAPI(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}
}

func TestBFFMdgSubscriptionsAPI(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	// 1. GET /api/mdg/subscriptions - method not allowed
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/mdg/subscriptions", nil)
	bff.HandleMdgSubscriptionsAPI(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}

	// 2. POST /api/mdg/subscriptions - invalid body
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/subscriptions", strings.NewReader("invalid_json"))
	bff.HandleMdgSubscriptionsAPI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}

	// 3. POST /api/mdg/subscriptions - add subscription
	body := `{"action":"add","ticker":"AAPL"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/subscriptions", strings.NewReader(body))
	bff.HandleMdgSubscriptionsAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 4. POST /api/mdg/subscriptions - remove subscription
	body = `{"action":"remove","ticker":"AAPL"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/subscriptions", strings.NewReader(body))
	bff.HandleMdgSubscriptionsAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 5. POST /api/mdg/subscriptions - invalid action
	body = `{"action":"invalid","ticker":"AAPL"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/subscriptions", strings.NewReader(body))
	bff.HandleMdgSubscriptionsAPI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestBFFMdgControlAPI(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	// 1. GET /api/mdg/control - method not allowed
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/mdg/control", nil)
	bff.HandleMdgControlAPI(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}

	// 2. POST /api/mdg/control - pause
	body := `{"action":"pause"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/control", strings.NewReader(body))
	bff.HandleMdgControlAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 3. POST /api/mdg/control - resume
	body = `{"action":"resume"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/control", strings.NewReader(body))
	bff.HandleMdgControlAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 4. POST /api/mdg/control - set_vendor
	body = `{"action":"set_vendor","vendor":"alpaca","url":"ws://dummy"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/control", strings.NewReader(body))
	bff.HandleMdgControlAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 5. POST /api/mdg/control - invalid vendor
	body = `{"action":"set_vendor","vendor":"invalid"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/control", strings.NewReader(body))
	bff.HandleMdgControlAPI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}

	// 6. POST /api/mdg/control - invalid action
	body = `{"action":"invalid"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/control", strings.NewReader(body))
	bff.HandleMdgControlAPI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestBFFMdgTradesAPI(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	// 1. GET /api/mdg/trades - retrieve empty list
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/mdg/trades", nil)
	bff.HandleMdgTradesAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 2. POST /api/mdg/trades - valid trade execution
	body := `{"symbol":"AAPL","price":150.5,"qty":100,"action":"BUY"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/trades", strings.NewReader(body))
	bff.HandleMdgTradesAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 3. POST /api/mdg/trades - invalid body
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/trades", strings.NewReader("invalid"))
	bff.HandleMdgTradesAPI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}

	// 4. PUT /api/mdg/trades - method not allowed
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("PUT", "/api/mdg/trades", nil)
	bff.HandleMdgTradesAPI(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", rec.Code)
	}

	// 5. GET /api/mdg/trades - with Closed Redis to trigger LRange error
	rdb.Close()
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/mdg/trades", nil)
	bff.HandleMdgTradesAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

type mockWSConn struct {
	readErr  error
	pingErr  error
	writeErr error
	readBuf  [][]byte
	readIdx  int
	mu       sync.Mutex
}

func (m *mockWSConn) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.readErr != nil {
		return websocket.MessageText, nil, m.readErr
	}
	if m.readIdx < len(m.readBuf) {
		res := m.readBuf[m.readIdx]
		m.readIdx++
		return websocket.MessageText, res, nil
	}
	<-ctx.Done()
	return websocket.MessageText, nil, ctx.Err()
}

func (m *mockWSConn) Write(ctx context.Context, typ websocket.MessageType, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.writeErr
}

func (m *mockWSConn) Ping(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pingErr
}

func (m *mockWSConn) Close(code websocket.StatusCode, reason string) error {
	return nil
}

func TestRunBFFIntegration(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	cfg := Config{
		Port:       "0",
		RedisAddr:  mr.Addr(),
		MdgAddr:    "127.0.0.1:0",
		RiskAddr:   "127.0.0.1:0",
		EmsAddr:    "127.0.0.1:0",
		EngineAddr: "127.0.0.1:0",
		DevMode:    true,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	go func() {
		time.Sleep(30 * time.Millisecond)
		rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
		defer rdb.Close()
		rdb.Publish(ctx, "mdg:ticks", `{"sym":"AAPL","p":150.5}`)
		rdb.Publish(ctx, "mdg:ticks", `invalid_json`)
		time.Sleep(10 * time.Millisecond)
		mr.Close()
	}()

	err = runBFF(ctx, cfg)
	if err != nil && err != context.DeadlineExceeded {
		t.Errorf("runBFF failed: %v", err)
	}
}

func TestBFFWebSocketIntegration(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")
	bff.services["mdg"] = HealthStatus{Status: "SERVING"}

	server := httptest.NewServer(http.HandlerFunc(bff.HandleWebSocket))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial websocket: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// 1. Trigger json unmarshal failure (send invalid JSON)
	_ = conn.Write(ctx, websocket.MessageText, []byte("invalid_json"))

	// 2. Trigger OOB pause
	_ = conn.Write(ctx, websocket.MessageText, []byte(`{"action":"pause","reason":"test pause"}`))

	// 3. Trigger OOB panic
	_ = conn.Write(ctx, websocket.MessageText, []byte(`{"action":"panic","reason":"test panic"}`))

	// Let the connection read and ping loops run in background.
	// Close connection at 2.9 seconds to trigger ping loop failure when ticker fires at 3 seconds
	go func() {
		time.Sleep(2900 * time.Millisecond)
		conn.Close(websocket.StatusNormalClosure, "done")
	}()

	time.Sleep(3200 * time.Millisecond)
}

func TestBFFWebSocketUpgradeError(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/ws", nil)
	bff.HandleWebSocket(rec, req)
	if rec.Code != http.StatusUpgradeRequired {
		t.Errorf("expected 426, got %d", rec.Code)
	}
}

func TestBFFWebSocketEMSForcePauseDialError(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	// Empty string EMS address to trigger Dial parsing failure synchronously
	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "", "127.0.0.1:0")
	bff.callEMSForcePause(context.Background(), "test error trigger")
}

func TestBFFHandleStateAPI(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")
	bff.services["mdg"] = HealthStatus{Status: "DEGRADED"}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/state", nil)
	bff.HandleStateAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestBFFCircuitBreakerWriteError(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	rdb.Close() // Closed client to trigger Redis Set failure

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")
	_ = bff.updateCircuitState(context.Background(), StatePaused)
}

func TestBFFBroadcastMarshalError(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")
	// Make a channel which is non-marshallable
	bff.broadcast(make(chan int))
}

func TestBFFMdgConfigAPIWithActiveTickers(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	// Set active tickers in Redis to test unmarshaling path
	ctx := context.Background()
	_ = rdb.Set(ctx, "mdg:active_tickers", `["AAPL","GOOG"]`, 0).Err()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/mdg/config", nil)
	bff.HandleMdgConfigAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestBFFMdgSubscriptionsAPIAddNonexistentTicker(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	// 1. Add nonexistent ticker
	body := `{"action":"add","ticker":"NFLX"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/mdg/subscriptions", strings.NewReader(body))
	bff.HandleMdgSubscriptionsAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 2. Add empty ticker to trigger error
	body = `{"action":"add","ticker":""}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mdg/subscriptions", strings.NewReader(body))
	bff.HandleMdgSubscriptionsAPI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestBFFMdgControlAPIInvalidBody(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/mdg/control", strings.NewReader("invalid_json"))
	bff.HandleMdgControlAPI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestBFFMainFunction(t *testing.T) {
	oldCommandLine := flag.CommandLine
	defer func() { flag.CommandLine = oldCommandLine }()

	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	os.Args = []string{"cmd", "-port", "0", "-redis-addr", "localhost:6379", "-dev-mode"}

	// Mock notifyContext to return a canceled context so main exits immediately
	oldNotifyContext := notifyContext
	notifyContext = func(parent context.Context, signals ...os.Signal) (context.Context, context.CancelFunc) {
		ctx, cancel := context.WithCancel(parent)
		cancel() // cancel immediately
		return ctx, cancel
	}
	defer func() { notifyContext = oldNotifyContext }()

	main()
}

func TestBFFWebSocketPingFailureAndReadError(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	bff := NewBFFServer(rdb, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	// Set ping interval to be very short to run test quickly
	oldInterval := bffPingInterval
	bffPingInterval = 10 * time.Millisecond
	defer func() { bffPingInterval = oldInterval }()

	// mockWSConn returns readErr and pingErr
	ws := &mockWSConn{
		readErr: fmt.Errorf("mock read error"),
		pingErr: fmt.Errorf("mock ping error"),
	}

	// Override wsAcceptAndWrap to return our mockWSConn
	oldAccept := wsAcceptAndWrap
	wsAcceptAndWrap = func(w http.ResponseWriter, r *http.Request) (WebSocketConn, error) {
		return ws, nil
	}
	defer func() { wsAcceptAndWrap = oldAccept }()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/ws", nil)

	bff.HandleWebSocket(rec, req)
}

func TestBFFWebSocketWriteError(t *testing.T) {
	bff := NewBFFServer(nil, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")
	ws := &mockWSConn{writeErr: fmt.Errorf("write error")}
	bff.clients[ws] = func() {}
	bff.broadcast([]byte("test"))
}

func TestBFFMainExitFailure(t *testing.T) {
	oldCommandLine := flag.CommandLine
	defer func() { flag.CommandLine = oldCommandLine }()

	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	os.Args = []string{"cmd", "-port", "-1", "-redis-addr", "localhost:6379", "-dev-mode"}

	var exitCode int
	oldExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("exit called")
	}
	defer func() { osExit = oldExit }()

	oldRunBFF := runBFFHook
	runBFFHook = func(ctx context.Context, cfg Config) error {
		return fmt.Errorf("mock runBFF error")
	}
	defer func() { runBFFHook = oldRunBFF }()

	defer func() {
		r := recover()
		if r == nil {
			t.Error("expected panic from mock exit, got nil")
		}
		if exitCode != 1 {
			t.Errorf("expected exit code 1, got %d", exitCode)
		}
	}()

	main()
}

func TestHandleMdgHistoryAPI_Intervals(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	rClient := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rClient.Close()

	bff := NewBFFServer(rClient, mr.Addr(), "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	intervals := []string{"10s", "15s", "30s", "1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M", "6M", "12M"}
	for _, iv := range intervals {
		req := httptest.NewRequest("GET", "/api/mdg/history?ticker=AAPL&granularity=1D&interval="+iv, nil)
		rec := httptest.NewRecorder()

		bff.HandleMdgHistoryAPI(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("expected 200 OK for interval %s, got %d", iv, rec.Code)
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to parse JSON response for interval %s: %v", iv, err)
		}

		if resp["success"] != true {
			t.Errorf("expected success: true for interval %s", iv)
		}

		bars, ok := resp["bars"].([]interface{})
		if !ok || len(bars) == 0 {
			t.Errorf("expected non-empty bars for interval %s", iv)
		}
	}
}

func TestHandleMdgHistoryAPI_MissingTicker(t *testing.T) {
	bff := NewBFFServer(nil, "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")
	req := httptest.NewRequest("GET", "/api/mdg/history", nil)
	rec := httptest.NewRecorder()
	bff.HandleMdgHistoryAPI(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request, got %d", rec.Code)
	}
}

func TestHandleMdgHistoryAPI_WithApiKey(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed miniredis: %v", err)
	}
	defer mr.Close()

	rClient := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rClient.Close()
	bff := NewBFFServer(rClient, mr.Addr(), "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	// Set Alpaca vendor
	_ = rClient.Set(context.Background(), "mdg:vendor", "alpaca", 0).Err()

	// Invalid key format for Alpaca
	os.Setenv("FEED_API_KEY", "invalid_key_format")
	req := httptest.NewRequest("GET", "/api/mdg/history?ticker=AAPL&granularity=1d", nil)
	rec := httptest.NewRecorder()
	bff.HandleMdgHistoryAPI(rec, req)

	grans := []string{"1d", "1w", "1M", "3M", "ytd", "1y", "5y", "all", "unknown"}
	intervals := []string{"10s", "15s", "30s", "1m", "2m", "3m", "5m", "10m", "15m", "30m", "45m", "1h", "2h", "3h", "4h", "1d", "1w", "1M", "6M", "12M", "unknown"}

	// Valid key format for Alpaca
	os.Setenv("FEED_API_KEY", "key_id:secret_key")
	for _, g := range grans {
		for _, iv := range intervals {
			req := httptest.NewRequest("GET", "/api/mdg/history?ticker=AAPL&granularity="+g+"&interval="+iv, nil)
			rec := httptest.NewRecorder()
			bff.HandleMdgHistoryAPI(rec, req)
		}
	}

	// Polygon vendor
	_ = rClient.Set(context.Background(), "mdg:vendor", "polygon", 0).Err()
	os.Setenv("FEED_API_KEY", "dummy_polygon_key")
	for _, g := range grans {
		for _, iv := range intervals {
			req := httptest.NewRequest("GET", "/api/mdg/history?ticker=AAPL&granularity="+g+"&interval="+iv, nil)
			rec := httptest.NewRecorder()
			bff.HandleMdgHistoryAPI(rec, req)
		}
	}

	os.Unsetenv("FEED_API_KEY")
}

func TestHandleMdgHistoryAPI_Granularities(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed miniredis: %v", err)
	}
	defer mr.Close()

	rClient := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rClient.Close()
	bff := NewBFFServer(rClient, mr.Addr(), "127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0")

	grans := []string{"1d", "1w", "1M", "3M", "ytd", "1y", "5y", "all", "unknown"}
	for _, g := range grans {
		req := httptest.NewRequest("GET", "/api/mdg/history?ticker=AAPL&granularity="+g, nil)
		rec := httptest.NewRecorder()
		bff.HandleMdgHistoryAPI(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("expected 200 OK for granularity %s, got %d", g, rec.Code)
		}
	}
}




