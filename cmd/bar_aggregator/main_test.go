package main

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"bulldog_alpha/proto/market_data"
	"github.com/go-zeromq/zmq4"
	"google.golang.org/protobuf/proto"
)

type mockZmqPubSocket struct {
	sentChan chan zmq4.Msg
	err      error
}

func (m *mockZmqPubSocket) Close() error                              { return nil }
func (m *mockZmqPubSocket) Send(msg zmq4.Msg) error                   { if m.err != nil { return m.err }; m.sentChan <- msg; return nil }
func (m *mockZmqPubSocket) Recv() (zmq4.Msg, error)                   { return zmq4.Msg{}, nil }
func (m *mockZmqPubSocket) Listen(addr string) error                  { return m.err }
func (m *mockZmqPubSocket) Dial(addr string) error                    { return nil }
func (m *mockZmqPubSocket) Type() zmq4.SocketType                     { return zmq4.Pub }
func (m *mockZmqPubSocket) GetOption(name string) (interface{}, error) { return nil, nil }
func (m *mockZmqPubSocket) SetOption(name string, value interface{}) error {
	return nil
}
func (m *mockZmqPubSocket) Addr() net.Addr                            { return nil }
func (m *mockZmqPubSocket) SendMulti(msg zmq4.Msg) error              { return m.Send(msg) }

type mockZmqSubSocket struct {
	ctx          context.Context
	recvChan     chan zmq4.Msg
	dialErr      error
	setOptionErr error
	recvErr      error
}

func (m *mockZmqSubSocket) Close() error                              { return nil }
func (m *mockZmqSubSocket) Send(msg zmq4.Msg) error                   { return nil }
func (m *mockZmqSubSocket) Recv() (zmq4.Msg, error)                   {
	if m.recvErr != nil {
		return zmq4.Msg{}, m.recvErr
	}
	select {
	case msg := <-m.recvChan:
		return msg, nil
	case <-m.ctx.Done():
		return zmq4.Msg{}, m.ctx.Err()
	}
}
func (m *mockZmqSubSocket) Listen(addr string) error                  { return nil }
func (m *mockZmqSubSocket) Dial(addr string) error                    { return m.dialErr }
func (m *mockZmqSubSocket) Type() zmq4.SocketType                     { return zmq4.Sub }
func (m *mockZmqSubSocket) GetOption(name string) (interface{}, error) { return nil, nil }
func (m *mockZmqSubSocket) SetOption(name string, value interface{}) error {
	return m.setOptionErr
}
func (m *mockZmqSubSocket) Addr() net.Addr                            { return nil }
func (m *mockZmqSubSocket) SendMulti(msg zmq4.Msg) error              { return nil }

func TestBarAggregatorSlicingAndWatermark(t *testing.T) {
	sentChan := make(chan zmq4.Msg, 10)
	mockPub := &mockZmqPubSocket{sentChan: sentChan}

	agg := &SymbolAggregator{
		symbol:    "AAPL",
		tickChan:  make(chan *market_data.EquityTick, 100),
		pubSocket: mockPub,
	}

	windowStart := int64(1685599980000)

	// Tick A: price 100, volume 10, ts = windowStart + 10s (06:13:10)
	agg.processTick(&market_data.EquityTick{
		Symbol:    "AAPL",
		Price:     100.0,
		Size:      10.0,
		Timestamp: windowStart + 10000,
	})

	// Tick B: price 105 (new high), volume 15, ts = windowStart + 30s (06:13:30)
	agg.processTick(&market_data.EquityTick{
		Symbol:    "AAPL",
		Price:     105.0,
		Size:      15.0,
		Timestamp: windowStart + 30000,
	})

	// Tick C: price 98 (new low), volume 5, ts = windowStart + 45s (06:13:45)
	agg.processTick(&market_data.EquityTick{
		Symbol:    "AAPL",
		Price:     98.0,
		Size:      5.0,
		Timestamp: windowStart + 45000,
	})

	// 2. Feed a tick in the next window to trigger publishing the closed bar
	agg.processTick(&market_data.EquityTick{
		Symbol:    "AAPL",
		Price:     101.0,
		Size:      20.0,
		Timestamp: windowStart + 65000,
	})

	// Assert that a Bar was published for AAPL for the 06:13:00 window
	select {
	case msg := <-sentChan:
		if len(msg.Frames) < 2 {
			t.Fatal("Expected Bar message to have 2 frames")
		}
		if string(msg.Frames[0]) != "BAR.AAPL" {
			t.Errorf("Expected topic 'BAR.AAPL', got '%s'", string(msg.Frames[0]))
		}

		var bar market_data.EquityBar
		if err := proto.Unmarshal(msg.Frames[1], &bar); err != nil {
			t.Fatalf("Failed to unmarshal EquityBar proto: %v", err)
		}

		if bar.Open != 100.0 || bar.High != 105.0 || bar.Low != 98.0 || bar.Close != 98.0 || bar.Volume != 30.0 {
			t.Errorf("Bar aggregation incorrect. Got Open=%f, High=%f, Low=%f, Close=%f, Volume=%f",
				bar.Open, bar.High, bar.Low, bar.Close, bar.Volume)
		}
		if bar.Timestamp != windowStart {
			t.Errorf("Expected window timestamp %d, got %d", windowStart, bar.Timestamp)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Timeout waiting for Bar message to be published")
	}

	// 3. Test watermark/late tick handling
	agg.processTick(&market_data.EquityTick{
		Symbol:        "AAPL",
		Price:         97.0, // New Low
		Size:          10.0,
		Timestamp:     windowStart + 59950,
		CorrelationId: "late-correlation-1",
	})

	// Assert that the updated Bar was re-published
	select {
	case msg := <-sentChan:
		var bar market_data.EquityBar
		if err := proto.Unmarshal(msg.Frames[1], &bar); err != nil {
			t.Fatalf("Failed to unmarshal EquityBar proto: %v", err)
		}

		if bar.Low != 97.0 || bar.Close != 97.0 || bar.Volume != 40.0 {
			t.Errorf("Late bar update incorrect. Got Low=%f, Close=%f, Volume=%f", bar.Low, bar.Close, bar.Volume)
		}
	}

	// Test late tick with a new high
	agg.processTick(&market_data.EquityTick{
		Symbol:        "AAPL",
		Price:         110.0, // New High
		Size:          5.0,
		Timestamp:     windowStart + 59960,
		CorrelationId: "late-correlation-high",
	})

	select {
	case msg := <-sentChan:
		var bar market_data.EquityBar
		_ = proto.Unmarshal(msg.Frames[1], &bar)
		if bar.High != 110.0 || bar.Close != 110.0 || bar.Volume != 45.0 {
			t.Errorf("Late bar update with high incorrect. Got High=%f, Close=%f, Volume=%f", bar.High, bar.Close, bar.Volume)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Timeout waiting for updated Bar message (high) to be published")
	}

	// 4. Send an out-of-watermark tick
	agg.processTick(&market_data.EquityTick{
		Symbol:        "AAPL",
		Price:         90.0,
		Size:          10.0,
		Timestamp:     windowStart + 59000,
		CorrelationId: "too-late-correlation-1",
	})

	// Assert no publication occurs
	select {
	case msg := <-sentChan:
		t.Errorf("Did not expect any Bar to be published for out-of-watermark tick, got: %v", msg)
	case <-time.After(50 * time.Millisecond):
		// Passed!
	}

	// Test publisher error branch
	mockPub.err = errors.New("zmq send failed")
	agg.publishBar(agg.currentBar) // Should handle err and log
}

func TestBarAggregatorProcessingLoopAndRouting(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	recvChan := make(chan zmq4.Msg, 5)
	mockSub := &mockZmqSubSocket{ctx: ctx, recvChan: recvChan}

	sentChan := make(chan zmq4.Msg, 5)
	mockPub := &mockZmqPubSocket{sentChan: sentChan}

	// 1. Send invalid ZMQ messages (less than 2 frames) to test error path
	recvChan <- zmq4.NewMsgFrom([]byte("TICK.AAPL")) // Only 1 frame

	// 2. Send malformed protobuf payload to test unmarshal error path
	recvChan <- zmq4.NewMsgFrom([]byte("TICK.AAPL"), []byte("invalid-proto"))

	// 3. Send valid TICK message
	tick := &market_data.EquityTick{
		Symbol:    "AAPL",
		Price:     100.0,
		Size:      10,
		Timestamp: 1685600000000,
	}
	tickBytes, _ := proto.Marshal(tick)
	recvChan <- zmq4.NewMsgFrom([]byte("TICK.AAPL"), tickBytes)

	// 4. Trigger future tick to push AAPL bar publication
	tickFuture := &market_data.EquityTick{
		Symbol:    "AAPL",
		Price:     102.0,
		Size:      20,
		Timestamp: 1685600065000,
	}
	futureBytes, _ := proto.Marshal(tickFuture)
	recvChan <- zmq4.NewMsgFrom([]byte("TICK.AAPL"), futureBytes)

	// Run processing loop in a goroutine
	go func() {
		runProcessingLoop(ctx, mockSub, mockPub)
	}()

	// Verify we published AAPL bar
	select {
	case msg := <-sentChan:
		if string(msg.Frames[0]) != "BAR.AAPL" {
			t.Errorf("Expected topic BAR.AAPL, got %s", string(msg.Frames[0]))
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for published bar")
	}

	// 5. Test sub socket recv error path
	mockSub.recvErr = errors.New("sub socket read error")
	// Queue a dummy message to wake up the blocked Recv() and test frames < 2
	recvChan <- zmq4.Msg{}
	time.Sleep(10 * time.Millisecond)
	// Make sure it doesn't block forever by forcing loop exit
	cancel()
}

func TestBarAggregatorRunMainErrors(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mockPub := &mockZmqPubSocket{}
	mockSub := &mockZmqSubSocket{ctx: ctx}

	// 1. Listen failure
	mockPub.err = errors.New("listen error")
	oldPubCreator := newPubSocket
	newPubSocket = func(c context.Context) zmq4.Socket {
		return mockPub
	}
	defer func() { newPubSocket = oldPubCreator }()

	err := runMain(ctx, "tcp://dummy-sub", "tcp://dummy-pub")
	if err == nil || !errors.Is(err, mockPub.err) {
		t.Fatalf("Expected listen error, got %v", err)
	}

	// Reset pub error
	mockPub.err = nil

	// 2. Dial failure
	mockSub.dialErr = errors.New("dial error")
	oldSubCreator := newSubSocket
	newSubSocket = func(c context.Context) zmq4.Socket {
		return mockSub
	}
	defer func() { newSubSocket = oldSubCreator }()

	err = runMain(ctx, "tcp://dummy-sub", "tcp://dummy-pub")
	if err == nil || !errors.Is(err, mockSub.dialErr) {
		t.Fatalf("Expected dial error, got %v", err)
	}

	// Reset sub dial error, set option error
	mockSub.dialErr = nil
	// For SetOption, the error is returned on SetOption call
	mockSub.setOptionErr = errors.New("set option error")
	err = runMain(ctx, "tcp://dummy-sub", "tcp://dummy-pub")
	if err == nil || !errors.Is(err, mockSub.setOptionErr) {
		t.Fatalf("Expected set option error, got %v", err)
	}
}

func TestBarAggregatorRunMainSuccess(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	mockPub := &mockZmqPubSocket{}
	recvChan := make(chan zmq4.Msg, 5)
	mockSub := &mockZmqSubSocket{ctx: ctx, recvChan: recvChan}

	// Override ZMQ factory functions
	oldPubCreator := newPubSocket
	newPubSocket = func(c context.Context) zmq4.Socket {
		return mockPub
	}
	oldSubCreator := newSubSocket
	newSubSocket = func(c context.Context) zmq4.Socket {
		return mockSub
	}
	defer func() {
		newPubSocket = oldPubCreator
		newSubSocket = oldSubCreator
	}()

	errChan := make(chan error)
	go func() {
		errChan <- runMain(ctx, "tcp://dummy-sub", "tcp://dummy-pub")
	}()

	select {
	case err := <-errChan:
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("Expected nil, context.Canceled or context.DeadlineExceeded, got %v", err)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for runMain to exit")
	}
}

func BenchmarkBarAggregatorThroughput(b *testing.B) {
	sentChan := make(chan zmq4.Msg, 10000)
	mockPub := &mockZmqPubSocket{sentChan: sentChan}

	agg := &SymbolAggregator{
		symbol:    "AAPL",
		tickChan:  make(chan *market_data.EquityTick, 10000),
		pubSocket: mockPub,
	}

	baseTime := int64(1685600000000)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		agg.processTick(&market_data.EquityTick{
			Symbol:    "AAPL",
			Price:     100.0 + float64(i%10),
			Size:      1.0,
			Timestamp: baseTime + int64(i)*10, // increments by 10ms
		})
	}
}

func TestBarAggregatorNewSockets(t *testing.T) {
	ctx := context.Background()
	pub := newPubSocket(ctx)
	if pub == nil {
		t.Error("Expected newPubSocket to return a socket, got nil")
	}
	pub.Close()

	sub := newSubSocket(ctx)
	if sub == nil {
		t.Error("Expected newSubSocket to return a socket, got nil")
	}
	sub.Close()
}

func TestBarAggregatorRunAppCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	mockPub := &mockZmqPubSocket{}
	mockSub := &mockZmqSubSocket{ctx: ctx}

	oldPubCreator := newPubSocket
	newPubSocket = func(c context.Context) zmq4.Socket {
		return mockPub
	}
	oldSubCreator := newSubSocket
	newSubSocket = func(c context.Context) zmq4.Socket {
		return mockSub
	}
	defer func() {
		newPubSocket = oldPubCreator
		newSubSocket = oldSubCreator
	}()

	err := runApp(ctx, "tcp://dummy-sub", "tcp://dummy-pub")
	if err != nil {
		t.Fatalf("Expected nil error for canceled context, got %v", err)
	}
}
