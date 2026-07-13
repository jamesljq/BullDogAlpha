package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"bulldog_alpha/proto/market_data"
	"github.com/coder/websocket"
	"github.com/go-zeromq/zmq4"
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

	err := connectAndIngest(ctx, mockZmq, "ws://dummy", "my-api-key")
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
	err := connectAndIngest(ctx, mockZmq, "ws://invalid-address:99999", "")
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
	err := connectAndIngest(ctx, mockZmq, "ws://dummy", "key")
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
	err := runIngestionLoop(ctx, mockZmq, "ws://dummy", "")
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
		errChan <- runIngestionLoop(ctx, mockZmq, "ws://dummy", "")
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

	err := connectAndIngest(ctx, mockZmq, "ws://dummy", "")
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
