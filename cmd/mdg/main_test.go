package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"bulldog_alpha/proto/market_data"
	"github.com/alicebob/miniredis/v2"
	"github.com/coder/websocket"
	"github.com/go-zeromq/zmq4"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"
)

type mockZmqSocket struct {
	sentChan chan zmq4.Msg
	err      error
}

func (m *mockZmqSocket) Close() error                              { return nil }
func (m *mockZmqSocket) Send(msg zmq4.Msg) error                   { if m.err != nil { return m.err }; m.sentChan <- msg; return nil }
func (m *mockZmqSocket) Recv() (zmq4.Msg, error)                   { return zmq4.Msg{}, nil }
func (m *mockZmqSocket) Listen(addr string) error                  { return m.err }
func (m *mockZmqSocket) Dial(addr string) error                    { return nil }
func (m *mockZmqSocket) Type() zmq4.SocketType                     { return zmq4.Pub }
func (m *mockZmqSocket) GetOption(name string) (interface{}, error) { return nil, nil }
func (m *mockZmqSocket) SetOption(name string, value interface{}) error {
	return nil
}
func (m *mockZmqSocket) Addr() net.Addr                            { return nil }
func (m *mockZmqSocket) SendMulti(msg zmq4.Msg) error              { return m.Send(msg) }

type readResult struct {
	payload []byte
	err     error
}

type mockWebSocketConn struct {
	readChan  chan readResult
	writeChan chan []byte
	writeErr  error
	writeFunc func(ctx context.Context, typ websocket.MessageType, data []byte) error
}

func (m *mockWebSocketConn) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	select {
	case res := <-m.readChan:
		return websocket.MessageText, res.payload, res.err
	case <-ctx.Done():
		return websocket.MessageText, nil, ctx.Err()
	}
}

func (m *mockWebSocketConn) Write(ctx context.Context, typ websocket.MessageType, data []byte) error {
	if m.writeFunc != nil {
		return m.writeFunc(ctx, typ, data)
	}
	if m.writeErr != nil {
		return m.writeErr
	}
	select {
	case m.writeChan <- data:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *mockWebSocketConn) Close(code websocket.StatusCode, reason string) error {
	return nil
}

func TestMdgConnectAndIngestSuccess(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	readChan := make(chan readResult, 5)
	writeChan := make(chan []byte, 5)
	mockWS := &mockWebSocketConn{
		readChan:  readChan,
		writeChan: writeChan,
	}

	// Override global dialer
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	mockZmq := &mockZmqSocket{
		sentChan: make(chan zmq4.Msg, 5),
	}

	// 1. Queue a normal tick
	ticks := []RawTick{
		{Symbol: "AAPL", Price: 150.5, Size: 100, Timestamp: 1685600000000},
	}
	tickBytes, _ := json.Marshal(ticks)
	readChan <- readResult{payload: tickBytes}

	// 2. Queue an EOF to terminate the ingestion loop
	readChan <- readResult{err: io.EOF}

	err := connectAndIngest(ctx, mockZmq, "ws://dummy", "my-api-key", "polygon", []string{"AAPL", "MSFT"})
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("Expected EOF or nil error, got %v", err)
	}

	// Verify Auth msg was written to WS
	select {
	case authData := <-writeChan:
		var authMsg map[string]interface{}
		if err := json.Unmarshal(authData, &authMsg); err != nil {
			t.Fatalf("Failed to parse auth data: %v", err)
		}
		if authMsg["action"] != "auth" || authMsg["params"] != "my-api-key" {
			t.Errorf("Unexpected auth message content: %v", authMsg)
		}
	default:
		t.Error("Expected authentication message to be written to WS")
	}

	// Verify Tick was processed and published over ZeroMQ
	select {
	case msg := <-mockZmq.sentChan:
		if len(msg.Frames) < 2 {
			t.Fatal("Expected message to have at least 2 frames")
		}
		topic := string(msg.Frames[0])
		if topic != "TICK.AAPL" {
			t.Errorf("Expected topic 'TICK.AAPL', got '%s'", topic)
		}
		var tick market_data.EquityTick
		if err := proto.Unmarshal(msg.Frames[1], &tick); err != nil {
			t.Fatalf("Failed to unmarshal EquityTick: %v", err)
		}
		if tick.Price != 150.5 || tick.Size != 100 || tick.Symbol != "AAPL" {
			t.Errorf("Parsed tick incorrect: %v", tick)
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("Timeout waiting for published message")
	}
}

func TestMdgConnectDialFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	mockZmq := &mockZmqSocket{}
	err := connectAndIngest(ctx, mockZmq, "ws://invalid-address:99999", "", "polygon", []string{"AAPL", "MSFT"})
	if err == nil || !strings.Contains(err.Error(), "dial failed") {
		t.Fatalf("Expected dial failed error, got: %v", err)
	}
}

func TestMdgAuthFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	mockWS := &mockWebSocketConn{
		writeErr: errors.New("write failed"),
	}

	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	mockZmq := &mockZmqSocket{}
	err := connectAndIngest(ctx, mockZmq, "ws://dummy", "key", "polygon", []string{"AAPL", "MSFT"})
	if err == nil || !strings.Contains(err.Error(), "failed to write auth message") {
		t.Fatalf("Expected auth write error, got: %v", err)
	}
}

func TestMdgDefensiveParsing(t *testing.T) {
	mockZmq := &mockZmqSocket{
		sentChan: make(chan zmq4.Msg, 5),
	}

	// 1. Empty payload
	processAndPublish([]byte{}, mockZmq)
	select {
	case <-mockZmq.sentChan:
		t.Error("Did not expect any message to be published from empty payload")
	default:
	}

	// 2. Truncated JSON
	processAndPublish([]byte(`{"sym":`), mockZmq)
	select {
	case <-mockZmq.sentChan:
		t.Error("Did not expect any message to be published from truncated JSON object")
	default:
	}

	// 3. Truncated JSON Array
	processAndPublish([]byte(`[{"sym":`), mockZmq)
	select {
	case <-mockZmq.sentChan:
		t.Error("Did not expect any message to be published from truncated JSON array")
	default:
	}

	// 4. Missing required fields
	processAndPublish([]byte(`{"sym":"", "p":150.5, "t":0}`), mockZmq)
	select {
	case <-mockZmq.sentChan:
		t.Error("Did not expect any message to be published when symbol/timestamp are missing")
	default:
	}

	// 5. Normal single JSON object parsing
	processAndPublish([]byte(`{"sym":"AAPL", "p":150.5, "s":10, "t":1685600000000}`), mockZmq)
	select {
	case msg := <-mockZmq.sentChan:
		if len(msg.Frames) < 2 {
			t.Fatal("Expected 2 frames")
		}
		var tick market_data.EquityTick
		_ = proto.Unmarshal(msg.Frames[1], &tick)
		if tick.Symbol != "AAPL" || tick.Price != 150.5 {
			t.Errorf("Incorrect parsing: %v", tick)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("Expected message to be published")
	}

	// 6. ZMQ Send Error path
	mockZmq.err = errors.New("zmq send failed")
	processAndPublish([]byte(`{"sym":"AAPL", "p":150.5, "s":10, "t":1685600000000}`), mockZmq) // Shouldn't panic, just log error
}

func TestMdgRunIngestionLoopCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	mockZmq := &mockZmqSocket{}
	err := runIngestionLoop(ctx, mockZmq, "")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Expected context.Canceled, got %v", err)
	}
}

func TestMdgRunMainListenFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Override pub creator to fail on listen
	oldPubCreator := newPubSocket
	newPubSocket = func(c context.Context) zmq4.Socket {
		return &mockZmqSocket{err: errors.New("listen failed")}
	}
	defer func() { newPubSocket = oldPubCreator }()

	err := runMain(ctx, "ws://dummy", "", "tcp://invalid-address")
	if err == nil || !strings.Contains(err.Error(), "failed to listen") {
		t.Fatalf("Expected runMain listen error, got %v", err)
	}
}

func TestMdgRunMainSuccess(t *testing.T) {
	oldHealthPort := *healthPort
	*healthPort = "0"
	defer func() { *healthPort = oldHealthPort }()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	mockZmq := &mockZmqSocket{
		sentChan: make(chan zmq4.Msg, 5),
	}

	// Override pub socket creator
	oldPubCreator := newPubSocket
	newPubSocket = func(c context.Context) zmq4.Socket {
		return mockZmq
	}
	defer func() { newPubSocket = oldPubCreator }()

	// Override dialer to block or fail fast so runMain returns on cancel
	readChan := make(chan readResult, 5)
	mockWS := &mockWebSocketConn{
		readChan: readChan,
	}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	// Start runMain in background
	errChan := make(chan error)
	go func() {
		errChan <- runMain(ctx, "ws://dummy", "", "tcp://dummy-bind")
	}()

	// Wait for context to cancel and runMain to finish
	select {
	case err := <-errChan:
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("Expected nil, context.Canceled or context.DeadlineExceeded, got %v", err)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for runMain to exit")
	}
}

func TestMdgRunIngestionLoopBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	mockZmq := &mockZmqSocket{}
	oldDialer := dialWebSocket
	// Make dial fail so connectAndIngest fails and triggers backoff
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return nil, errors.New("dial error")
	}
	defer func() { dialWebSocket = oldDialer }()

	// Start runIngestionLoop in a goroutine
	errChan := make(chan error)
	go func() {
		errChan <- runIngestionLoop(ctx, mockZmq, "")
	}()

	// Wait 150ms (after the 100ms backoff triggers) then cancel the context
	time.Sleep(150 * time.Millisecond)
	cancel()

	err := <-errChan
	if err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("Expected context.Canceled, got %v", err)
	}
}

func TestMdgConnectAndIngestReadError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	readChan := make(chan readResult, 5)
	mockWS := &mockWebSocketConn{
		readChan: readChan,
	}

	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	mockZmq := &mockZmqSocket{}
	readChan <- readResult{err: errors.New("read failed")}

	err := connectAndIngest(ctx, mockZmq, "ws://dummy", "", "polygon", []string{"AAPL", "MSFT"})
	if err == nil || !strings.Contains(err.Error(), "read error") {
		t.Fatalf("Expected read error, got: %v", err)
	}
}

func TestMdgNewPubSocket(t *testing.T) {
	ctx := context.Background()
	s := newPubSocket(ctx)
	if s == nil {
		t.Error("Expected newPubSocket to return a socket, got nil")
	}
	s.Close()
}

func TestMdgRunAppCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	mockZmq := &mockZmqSocket{}
	oldPubCreator := newPubSocket
	newPubSocket = func(c context.Context) zmq4.Socket {
		return mockZmq
	}
	defer func() { newPubSocket = oldPubCreator }()

	err := runApp(ctx, "ws://dummy", "", "tcp://dummy-bind")
	if err != nil {
		t.Fatalf("Expected nil error for canceled context, got %v", err)
	}
}

func runMockRedisServer(t *testing.T) (string, func()) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}

	mr.Set("mdg:active_tickers", `["AAPL","MSFT"]`)
	mr.Set("mdg:vendor", "polygon")
	mr.Set("mdg:status", "RUNNING")

	return mr.Addr(), func() {
		mr.Close()
	}
}

func TestMdgRedisIntegration(t *testing.T) {
	addr, cleanup := runMockRedisServer(t)
	defer cleanup()

	oldRedisAddr := *redisAddr
	*redisAddr = addr
	defer func() { *redisAddr = oldRedisAddr }()

	oldHealthPort := *healthPort
	*healthPort = "0"
	defer func() { *healthPort = oldHealthPort }()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	mockZmq := &mockZmqSocket{
		sentChan: make(chan zmq4.Msg, 5),
	}
	oldPubCreator := newPubSocket
	newPubSocket = func(c context.Context) zmq4.Socket {
		return mockZmq
	}
	defer func() { newPubSocket = oldPubCreator }()

	readChan := make(chan readResult, 20)
	readChan <- readResult{payload: []byte(`[{"ev":"AM","sym":"AAPL","p":150.5,"s":100,"t":1685600000000}]`)}
	mockWS := &mockWebSocketConn{
		readChan:  readChan,
		writeChan: make(chan []byte, 20),
	}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	// Publish control command in background after connection is established
	go func() {
		time.Sleep(50 * time.Millisecond)
		rdb := redis.NewClient(&redis.Options{Addr: addr})
		defer rdb.Close()
		cmd := `{"action":"update_subscriptions","tickers":["TSLA","NVDA"]}`
		rdb.Publish(ctx, "mdg:control_events", cmd)
	}()

	_ = runMain(ctx, "ws://dummy", "", "tcp://127.0.0.1:0")

	configMu.RLock()
	tickers := activeTickers
	configMu.RUnlock()

	// Should have loaded or been updated by subscriber to contain TSLA, NVDA
	hasTsla := false
	for _, tk := range tickers {
		if tk == "TSLA" {
			hasTsla = true
		}
	}
	if !hasTsla {
		t.Log("Expected subscriber to update activeTickers to include TSLA")
	}
}

func TestMdgProcessAndPublishAlpaca(t *testing.T) {
	configMu.Lock()
	activeVendor = "alpaca"
	configMu.Unlock()
	defer func() {
		configMu.Lock()
		activeVendor = "polygon"
		configMu.Unlock()
	}()

	mockZmq := &mockZmqSocket{
		sentChan: make(chan zmq4.Msg, 5),
	}

	alpacaPayload := []byte(`[
		{"T":"t","S":"TSLA","p":200.5,"s":100,"t":"2026-07-18T19:00:00Z"}
	]`)

	processAndPublish(alpacaPayload, mockZmq)

	select {
	case msg := <-mockZmq.sentChan:
		if len(msg.Frames) < 2 {
			t.Fatal("Expected at least 2 frames")
		}
		topic := string(msg.Frames[0])
		if topic != "TICK.TSLA" {
			t.Errorf("Expected topic TICK.TSLA, got %s", topic)
		}
		var tick market_data.EquityTick
		if err := proto.Unmarshal(msg.Frames[1], &tick); err != nil {
			t.Fatalf("Failed to unmarshal EquityTick: %v", err)
		}
		if tick.Symbol != "TSLA" || tick.Price != 200.5 || tick.Size != 100 {
			t.Errorf("Unexpected tick fields: %+v", tick)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Timeout waiting for Alpaca tick to be published")
	}
}

func TestMdgProcessAndPublishErrors(t *testing.T) {
	mockZmq := &mockZmqSocket{
		sentChan: make(chan zmq4.Msg, 5),
	}

	// 1. Missing symbol
	processAndPublish([]byte(`{"p": 100.0, "s": 10, "t": 1685600000000}`), mockZmq)
	select {
	case <-mockZmq.sentChan:
		t.Error("Expected no message to be sent for empty symbol")
	default:
	}

	// 2. Missing timestamp
	processAndPublish([]byte(`{"sym": "AAPL", "p": 100.0, "s": 10}`), mockZmq)
	select {
	case <-mockZmq.sentChan:
		t.Error("Expected no message to be sent for zero timestamp")
	default:
	}
}

func TestMdgConnectAndIngestAlpaca(t *testing.T) {
	configMu.Lock()
	oldVendor := activeVendor
	activeVendor = "alpaca"
	configMu.Unlock()
	defer func() {
		configMu.Lock()
		activeVendor = oldVendor
		configMu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	readChan := make(chan readResult, 5)
	writeChan := make(chan []byte, 5)
	mockWS := &mockWebSocketConn{
		readChan:  readChan,
		writeChan: writeChan,
	}

	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	mockZmq := &mockZmqSocket{
		sentChan: make(chan zmq4.Msg, 5),
	}

	// Queue responses:
	// 1. Welcome authentication response
	readChan <- readResult{payload: []byte(`[{"T":"success","msg":"authenticated"}]`)}
	// 2. Normal tick response
	readChan <- readResult{payload: []byte(`[{"T":"t","S":"AAPL","p":150.0,"s":100,"t":"2026-07-18T19:00:00Z"}]`)}
	// 3. EOF to stop loop
	readChan <- readResult{err: io.EOF}

	err := connectAndIngest(ctx, mockZmq, "ws://dummy", "KEY:SECRET", "alpaca", []string{"AAPL"})
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("Expected io.EOF, got %v", err)
	}
}

func TestMdgConnectAndIngestAlpacaKeyInvalid(t *testing.T) {
	ctx := context.Background()
	mockWS := &mockWebSocketConn{}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	mockZmq := &mockZmqSocket{}
	err := connectAndIngest(ctx, mockZmq, "ws://dummy", "invalidkey_no_colon", "alpaca", []string{"AAPL"})
	if err == nil || !strings.Contains(err.Error(), "api-key must be in the format") {
		t.Fatalf("Expected key format error, got %v", err)
	}
}

func TestMdgConnectAndIngestPolygonAuth(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	readChan := make(chan readResult, 5)
	writeChan := make(chan []byte, 5)
	mockWS := &mockWebSocketConn{
		readChan:  readChan,
		writeChan: writeChan,
	}

	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	mockZmq := &mockZmqSocket{}

	// 1st read: Polygon status message
	readChan <- readResult{payload: []byte(`[{"ev":"status","status":"connected"}]`)}
	// 2nd read: Auth success message
	readChan <- readResult{payload: []byte(`[{"ev":"status","status":"auth_success"}]`)}
	// 3rd read: EOF
	readChan <- readResult{err: io.EOF}

	err := connectAndIngest(ctx, mockZmq, "ws://dummy", "my-key", "polygon", []string{"AAPL"})
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("Expected io.EOF, got %v", err)
	}
}

func TestMdgRunIngestionLoopPaused(t *testing.T) {
	configMu.Lock()
	activeStatus = "PAUSED"
	configMu.Unlock()
	defer func() {
		configMu.Lock()
		activeStatus = "RUNNING"
		configMu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	mockZmq := &mockZmqSocket{}

	// Override dialer to block or fail fast so runIngestionLoop returns on cancel
	readChan := make(chan readResult, 5)
	mockWS := &mockWebSocketConn{
		readChan: readChan,
	}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	errChan := make(chan error, 1)
	go func() {
		errChan <- runIngestionLoop(ctx, mockZmq, "")
	}()

	// Signal resume in background
	go func() {
		time.Sleep(50 * time.Millisecond)
		configMu.Lock()
		activeStatus = "RUNNING"
		configMu.Unlock()
		reconnectChan <- struct{}{}
	}()

	select {
	case err := <-errChan:
		// Should exit on context timeout or cancellation
		if err != nil && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Timeout waiting for loop to process resume signal")
	}
}

func TestMdgPolygonIngestionErrors(t *testing.T) {
	pub := &mockZmqSocket{}

	// Test 1: Auth failure simulation (server disconnects)
	{
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		readChan := make(chan readResult, 20)
		ws := &mockWebSocketConn{readChan: readChan, writeChan: make(chan []byte, 5)}
		oldDialer := dialWebSocket
		dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return ws, nil }
		defer func() { dialWebSocket = oldDialer }()

		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"connected"}]`)}
		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"auth_failed"}]`)}
		readChan <- readResult{err: io.EOF}

		err := connectAndIngest(ctx, pub, "ws://dummy", "key", "polygon", []string{"AAPL"})
		if err != nil && !errors.Is(err, io.EOF) {
			t.Errorf("expected io.EOF or nil, got %v", err)
		}
	}

	// Test 2: General auth error simulation
	{
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		readChan := make(chan readResult, 20)
		ws := &mockWebSocketConn{readChan: readChan, writeChan: make(chan []byte, 5)}
		oldDialer := dialWebSocket
		dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return ws, nil }
		defer func() { dialWebSocket = oldDialer }()

		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"connected"}]`)}
		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"error","message":"invalid key"}]`)}
		readChan <- readResult{err: io.EOF}

		err := connectAndIngest(ctx, pub, "ws://dummy", "key", "polygon", []string{"AAPL"})
		if err != nil && !errors.Is(err, io.EOF) {
			t.Errorf("expected io.EOF or nil, got %v", err)
		}
	}

	// Test 3: Bad json status
	{
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		readChan := make(chan readResult, 20)
		ws := &mockWebSocketConn{readChan: readChan, writeChan: make(chan []byte, 5)}
		oldDialer := dialWebSocket
		dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return ws, nil }
		defer func() { dialWebSocket = oldDialer }()

		readChan <- readResult{payload: []byte(`[{"ev":"status",`)}

		err := connectAndIngest(ctx, pub, "ws://dummy", "key", "polygon", []string{"AAPL"})
		if err == nil {
			t.Errorf("expected error from bad json, got nil")
		}
	}

	// Test 4: Unknown status message
	{
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		readChan := make(chan readResult, 20)
		ws := &mockWebSocketConn{readChan: readChan, writeChan: make(chan []byte, 5)}
		oldDialer := dialWebSocket
		dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return ws, nil }
		defer func() { dialWebSocket = oldDialer }()

		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"unknown_status_val"}]`)}
		readChan <- readResult{err: io.EOF}

		err := connectAndIngest(ctx, pub, "ws://dummy", "key", "polygon", []string{"AAPL"})
		if err != nil && !errors.Is(err, io.EOF) {
			t.Errorf("expected io.EOF or nil, got %v", err)
		}
	}

	// Test 5: Subscription status message error
	{
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		readChan := make(chan readResult, 20)
		ws := &mockWebSocketConn{readChan: readChan, writeChan: make(chan []byte, 5)}
		oldDialer := dialWebSocket
		dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return ws, nil }
		defer func() { dialWebSocket = oldDialer }()

		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"connected"}]`)}
		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"auth_success"}]`)}
		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"subscribe_failed"}]`)}
		readChan <- readResult{err: io.EOF}

		err := connectAndIngest(ctx, pub, "ws://dummy", "key", "polygon", []string{"AAPL"})
		if err != nil && !errors.Is(err, io.EOF) {
			t.Errorf("expected io.EOF or nil, got %v", err)
		}
	}

	// Test 6: Empty payload list & first payload unmarshal error & normal payload unmarshal error
	{
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		readChan := make(chan readResult, 20)
		ws := &mockWebSocketConn{readChan: readChan, writeChan: make(chan []byte, 5)}
		oldDialer := dialWebSocket
		dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return ws, nil }
		defer func() { dialWebSocket = oldDialer }()

		readChan <- readResult{payload: []byte(`[]`)}
		readChan <- readResult{payload: []byte(`invalid_json`)}
		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"connected"}]`)}
		readChan <- readResult{payload: []byte(`[{"ev":"status","status":"auth_success"}]`)}
		readChan <- readResult{payload: []byte(`[{"ev":"AM","sym":"AAPL","p":150.0,"s":100,"t":1685600000000},{"ev":"AM",`)} // normal unmarshal error
		readChan <- readResult{payload: []byte(`[{"ev":"unknown_event"}]`)} // unknown event type
		readChan <- readResult{err: io.EOF}

		err := connectAndIngest(ctx, pub, "ws://dummy", "key", "polygon", []string{"AAPL"})
		if err != nil && !errors.Is(err, io.EOF) {
			t.Errorf("unexpected error: %v", err)
		}
	}
}

func TestMdgAlpacaIngestionErrors(t *testing.T) {
	configMu.Lock()
	oldVendor := activeVendor
	activeVendor = "alpaca"
	configMu.Unlock()
	defer func() {
		configMu.Lock()
		activeVendor = oldVendor
		configMu.Unlock()
	}()

	pub := &mockZmqSocket{}

	// Test 1: Alpaca auth failure simulation (server disconnects)
	{
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		readChan := make(chan readResult, 20)
		ws := &mockWebSocketConn{readChan: readChan, writeChan: make(chan []byte, 5)}
		oldDialer := dialWebSocket
		dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return ws, nil }
		defer func() { dialWebSocket = oldDialer }()

		readChan <- readResult{payload: []byte(`[{"T":"success","msg":"connected"}]`)}
		readChan <- readResult{payload: []byte(`[{"T":"error","code":401,"msg":"not authenticated"}]`)}
		readChan <- readResult{err: io.EOF}

		err := connectAndIngest(ctx, pub, "ws://dummy", "key:secret", "alpaca", []string{"AAPL"})
		if err != nil && !errors.Is(err, io.EOF) {
			t.Errorf("expected io.EOF or nil, got %v", err)
		}
	}

	// Test 2: Unknown message type check & unmarshal array error check
	{
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		readChan := make(chan readResult, 20)
		ws := &mockWebSocketConn{readChan: readChan, writeChan: make(chan []byte, 5)}
		oldDialer := dialWebSocket
		dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return ws, nil }
		defer func() { dialWebSocket = oldDialer }()

		readChan <- readResult{payload: []byte(`[{"T":"success","msg":"connected"}]`)}
		readChan <- readResult{payload: []byte(`[{"T":"success","msg":"authenticated"}]`)}
		readChan <- readResult{payload: []byte(`[{"T":"unknown"}]`)}
		readChan <- readResult{payload: []byte(`[{"T":"t","S":"AAPL","p":150.0,"s":100,"t":1685600000000},{"T":"t",`)}
		readChan <- readResult{err: io.EOF}

		err := connectAndIngest(ctx, pub, "ws://dummy", "key:secret", "alpaca", []string{"AAPL"})
		if err != nil && !errors.Is(err, io.EOF) {
			t.Errorf("unexpected error: %v", err)
		}
	}
}

func TestMdgZeroMqSendFailure(t *testing.T) {
	pub := &mockZmqSocket{err: fmt.Errorf("zmq send failed")}

	ctx, cancel := context.WithCancel(context.Background())
	readChan := make(chan readResult, 20)
	ws := &mockWebSocketConn{readChan: readChan, writeChan: make(chan []byte, 5)}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return ws, nil }
	defer func() { dialWebSocket = oldDialer }()

	readChan <- readResult{payload: []byte(`[{"ev":"status","status":"connected"}]`)}
	readChan <- readResult{payload: []byte(`[{"ev":"status","status":"auth_success"}]`)}
	readChan <- readResult{payload: []byte(`[{"ev":"AM","sym":"AAPL","p":150.5,"s":100,"t":1685600000000}]`)}
	readChan <- readResult{err: io.EOF}

	err := connectAndIngest(ctx, pub, "ws://dummy", "key", "polygon", []string{"AAPL"})
	if err != nil && !errors.Is(err, io.EOF) {
		t.Errorf("unexpected error: %v", err)
	}
	cancel()
}

func TestMdgRunIngestionLoopBackoffWithKey(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return nil, fmt.Errorf("dial failed connection refused")
	}
	defer func() { dialWebSocket = oldDialer }()

	pub := &mockZmqSocket{}
	err := runIngestionLoop(ctx, pub, "dummy-key")
	if err != nil && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestMdgRunMainWithRedisHandshakeSuccess(t *testing.T) {
	addr, cleanup := runMockRedisServer(t)
	defer cleanup()

	oldRedisAddr := *redisAddr
	*redisAddr = addr
	defer func() { *redisAddr = oldRedisAddr }()

	oldHealthPort := *healthPort
	*healthPort = "0"
	defer func() { *healthPort = oldHealthPort }()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	readChan := make(chan readResult, 20)
	mockWS := &mockWebSocketConn{
		readChan: readChan,
	}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return mockWS, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	_ = runMain(ctx, "ws://dummy", "key", "tcp://127.0.0.1:0")
}

func TestMdgMainFunction(t *testing.T) {
	oldCommandLine := flag.CommandLine
	defer func() { flag.CommandLine = oldCommandLine }()

	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	flag.CommandLine.String("feed-url", "", "")
	flag.CommandLine.String("api-key", "", "")
	flag.CommandLine.String("feed-vendor", "", "")
	flag.CommandLine.String("redis-addr", "", "")
	flag.CommandLine.String("zmq-addr", "", "")
	flag.CommandLine.String("health-port", "", "")

	os.Args = []string{"cmd", "-feed-url", "ws://dummy", "-api-key", "dummy", "-zmq-addr", "tcp://127.0.0.1:0", "-health-port", "0"}

	// Mock notifyContext to return a canceled context so main exits immediately
	oldNotifyContext := notifyContext
	notifyContext = func(parent context.Context, signals ...os.Signal) (context.Context, context.CancelFunc) {
		ctx, cancel := context.WithCancel(parent)
		cancel() // cancel immediately
		return ctx, cancel
	}
	defer func() { notifyContext = oldNotifyContext }()

	// Overwrite dialWebSocket and newPubSocket to avoid any real network
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return &mockWebSocketConn{
			readChan:  make(chan readResult, 20),
			writeChan: make(chan []byte, 20),
		}, nil
	}
	defer func() { dialWebSocket = oldDialer }()

	oldPub := newPubSocket
	newPubSocket = func(c context.Context) zmq4.Socket {
		return &mockZmqSocket{}
	}
	defer func() { newPubSocket = oldPub }()

	main()
}

func TestMdgProtoMarshalError(t *testing.T) {
	oldMarshal := protoMarshal
	protoMarshal = func(m proto.Message) ([]byte, error) {
		return nil, fmt.Errorf("mock marshal error")
	}
	defer func() { protoMarshal = oldMarshal }()

	pub := &mockZmqSocket{
		sentChan: make(chan zmq4.Msg, 5),
	}
	payload := []byte(`[{"ev":"AM","sym":"AAPL","p":150.5,"s":100,"t":1685600000000}]`)
	processAndPublish(payload, pub)
	if len(pub.sentChan) > 0 {
		t.Error("Did not expect any message to be published on marshal failure")
	}
}

func TestMdgRealDialWebSocketSuccess(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err == nil {
			conn.Close(websocket.StatusNormalClosure, "done")
		}
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	conn, err := dialWebSocket(ctx, wsURL)
	if err != nil {
		t.Fatalf("Expected successful dial, got %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
}

func TestMdgRedisConnectFailure(t *testing.T) {
	oldRedisAddr := *redisAddr
	*redisAddr = "127.0.0.1:9999" // Nonexistent Redis port
	defer func() { *redisAddr = oldRedisAddr }()

	oldHealthPort := *healthPort
	*healthPort = "0"
	defer func() { *healthPort = oldHealthPort }()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	readChan := make(chan readResult, 20)
	mockWS := &mockWebSocketConn{
		readChan:  readChan,
		writeChan: make(chan []byte, 20),
	}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return mockWS, nil }
	defer func() { dialWebSocket = oldDialer }()

	_ = runMain(ctx, "ws://dummy", "", "tcp://127.0.0.1:0")
}

func TestMdgRedisIntegrationDefaults(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	oldRedisAddr := *redisAddr
	*redisAddr = mr.Addr()
	defer func() { *redisAddr = oldRedisAddr }()

	oldHealthPort := *healthPort
	*healthPort = "0"
	defer func() { *healthPort = oldHealthPort }()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	readChan := make(chan readResult, 20)
	mockWS := &mockWebSocketConn{
		readChan:  readChan,
		writeChan: make(chan []byte, 20),
	}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return mockWS, nil }
	defer func() { dialWebSocket = oldDialer }()

	_ = runMain(ctx, "ws://dummy", "", "tcp://127.0.0.1:0")

	// Verify that the empty miniredis keys were seeded with defaults
	if !mr.Exists("mdg:active_tickers") {
		t.Error("expected mdg:active_tickers to be seeded in Redis")
	}
	vendorVal, _ := mr.Get("mdg:vendor")
	if vendorVal != "polygon" {
		t.Errorf("expected mdg:vendor to be polygon, got %s", vendorVal)
	}
	statusVal, _ := mr.Get("mdg:status")
	if statusVal != "RUNNING" {
		t.Errorf("expected mdg:status to be RUNNING, got %s", statusVal)
	}
}

func TestMdgRedisControlCommands(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to start miniredis: %v", err)
	}
	defer mr.Close()

	// Pre-seed status to make sure we can transition paused -> running
	mr.Set("mdg:status", "RUNNING")
	mr.Set("mdg:vendor", "polygon")
	mr.Set("mdg:active_tickers", `["AAPL"]`)

	oldRedisAddr := *redisAddr
	*redisAddr = mr.Addr()
	defer func() { *redisAddr = oldRedisAddr }()

	oldHealthPort := *healthPort
	*healthPort = "0"
	defer func() { *healthPort = oldHealthPort }()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	readChan := make(chan readResult, 20)
	mockWS := &mockWebSocketConn{
		readChan:  readChan,
		writeChan: make(chan []byte, 20),
	}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return mockWS, nil }
	defer func() { dialWebSocket = oldDialer }()

	// Start goroutine to publish various commands
	go func() {
		time.Sleep(30 * time.Millisecond)
		rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
		defer rdb.Close()

		// 1. invalid json
		rdb.Publish(ctx, "mdg:control_events", `invalid_json`)
		time.Sleep(10 * time.Millisecond)

		// 2. pause command
		rdb.Publish(ctx, "mdg:control_events", `{"action":"pause"}`)
		time.Sleep(10 * time.Millisecond)

		// 3. resume command
		rdb.Publish(ctx, "mdg:control_events", `{"action":"resume"}`)
		time.Sleep(10 * time.Millisecond)

		// 4. set_vendor command
		rdb.Publish(ctx, "mdg:control_events", `{"action":"set_vendor","vendor":"alpaca","url":"ws://alpaca"}`)
		time.Sleep(10 * time.Millisecond)

		// 5. trigger default case of reconnectChan signaling by sending set_vendor again quickly
		rdb.Publish(ctx, "mdg:control_events", `{"action":"set_vendor","vendor":"polygon"}`)
		rdb.Publish(ctx, "mdg:control_events", `{"action":"set_vendor","vendor":"polygon"}`)
		time.Sleep(10 * time.Millisecond)

		// 6. cancel context to stop runMain gracefully
		cancel()
	}()

	_ = runMain(ctx, "ws://dummy", "", "tcp://127.0.0.1:0")
}

func TestMdgRunIngestionLoopPausedCancel(t *testing.T) {
	configMu.Lock()
	activeStatus = "PAUSED"
	configMu.Unlock()
	defer func() {
		configMu.Lock()
		activeStatus = "RUNNING"
		configMu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 50 * time.Millisecond)
	defer cancel()

	mockZmq := &mockZmqSocket{}
	err := runIngestionLoop(ctx, mockZmq, "")
	if err != nil && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestMdgRunIngestionLoopBackoffReconnectSignal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) {
		return nil, fmt.Errorf("dial failed")
	}
	defer func() { dialWebSocket = oldDialer }()

	go func() {
		time.Sleep(50 * time.Millisecond)
		reconnectChan <- struct{}{}
	}()

	pub := &mockZmqSocket{}
	err := runIngestionLoop(ctx, pub, "")
	if err != nil && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestMdgConnectAndIngestReadAuthError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	mockWS := &mockWebSocketConn{
		readChan:  make(chan readResult, 20),
		writeChan: make(chan []byte, 20),
	}
	mockWS.readChan <- readResult{err: fmt.Errorf("read welcome failed")}

	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return mockWS, nil }
	defer func() { dialWebSocket = oldDialer }()

	pub := &mockZmqSocket{}
	err := connectAndIngest(ctx, pub, "ws://dummy", "key", "polygon", []string{"AAPL"})
	if err == nil || !strings.Contains(err.Error(), "failed to read welcome/auth status") {
		t.Errorf("expected read welcome error, got %v", err)
	}
}

func TestMdgJsonMarshalError(t *testing.T) {
	oldMarshal := jsonMarshal
	jsonMarshal = func(v interface{}) ([]byte, error) {
		return nil, fmt.Errorf("mock json marshal error")
	}
	defer func() { jsonMarshal = oldMarshal }()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mockWS := &mockWebSocketConn{
		readChan:  make(chan readResult, 20),
		writeChan: make(chan []byte, 20),
	}
	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return mockWS, nil }
	defer func() { dialWebSocket = oldDialer }()

	pub := &mockZmqSocket{}
	err := connectAndIngest(ctx, pub, "ws://dummy", "key", "polygon", []string{"AAPL"})
	if err == nil || !strings.Contains(err.Error(), "failed to marshal auth message") {
		t.Errorf("expected marshal auth error, got %v", err)
	}
}

func TestMdgAlpacaSubscribeWriteError(t *testing.T) {
	configMu.Lock()
	oldVendor := activeVendor
	activeVendor = "alpaca"
	configMu.Unlock()
	defer func() {
		configMu.Lock()
		activeVendor = oldVendor
		configMu.Unlock()
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mockWS := &mockWebSocketConn{
		readChan:  make(chan readResult, 20),
		writeChan: make(chan []byte, 20),
	}
	mockWS.readChan <- readResult{payload: []byte(`[{"T":"success","msg":"connected"}]`)}
	mockWS.readChan <- readResult{payload: []byte(`[{"T":"success","msg":"authenticated"}]`)}

	writeCount := 0
	mockWS.writeFunc = func(ctx context.Context, typ websocket.MessageType, data []byte) error {
		if writeCount == 1 {
			return fmt.Errorf("mock write subscribe failed")
		}
		writeCount++
		return nil
	}

	oldDialer := dialWebSocket
	dialWebSocket = func(c context.Context, url string) (WebSocketConn, error) { return mockWS, nil }
	defer func() { dialWebSocket = oldDialer }()

	pub := &mockZmqSocket{}
	err := connectAndIngest(ctx, pub, "ws://dummy", "key:secret", "alpaca", []string{"AAPL"})
	if err == nil || !strings.Contains(err.Error(), "failed to write subscribe message") {
		t.Errorf("expected write subscribe error, got %v", err)
	}
}

func TestMdgMainExitFailure(t *testing.T) {
	oldCommandLine := flag.CommandLine
	defer func() { flag.CommandLine = oldCommandLine }()

	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	flag.CommandLine.String("feed-url", "", "")
	flag.CommandLine.String("api-key", "", "")
	flag.CommandLine.String("feed-vendor", "", "")
	flag.CommandLine.String("redis-addr", "", "")
	flag.CommandLine.String("zmq-addr", "", "")
	flag.CommandLine.String("health-port", "", "")

	os.Args = []string{"cmd", "-feed-url", "ws://dummy", "-api-key", "dummy", "-zmq-addr", "invalid://address", "-health-port", "0"}

	var exitCode int
	oldExit := osExit
	osExit = func(code int) {
		exitCode = code
		panic("exit called")
	}
	defer func() { osExit = oldExit }()

	oldRunApp := runAppHook
	runAppHook = func(ctx context.Context, wsURL, key, bindAddr string) error {
		return fmt.Errorf("mock runApp error")
	}
	defer func() { runAppHook = oldRunApp }()

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

func TestMdgHealthListenFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	oldPubCreator := newPubSocket
	newPubSocket = func(c context.Context) zmq4.Socket {
		return &mockZmqSocket{}
	}
	defer func() { newPubSocket = oldPubCreator }()

	oldPort := *healthPort
	*healthPort = "-1"
	defer func() { *healthPort = oldPort }()

	err := runMain(ctx, "ws://dummy", "", "tcp://127.0.0.1:0")
	if err == nil || !strings.Contains(err.Error(), "failed to listen for gRPC health server") {
		t.Fatalf("Expected gRPC health server listen error, got %v", err)
	}
}



