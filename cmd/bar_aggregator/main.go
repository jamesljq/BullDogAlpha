package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"bulldog_alpha/proto/market_data"
	"github.com/go-zeromq/zmq4"
	"google.golang.org/protobuf/proto"
)

var (
	subAddr = flag.String("zmq-sub-addr", "tcp://localhost:5555", "ZeroMQ SUB socket connection address")
	pubAddr = flag.String("zmq-pub-addr", "tcp://*:5556", "ZeroMQ PUB socket binding address")
)

const (
	windowSizeMS = 60000 // 1 minute in milliseconds
	watermarkMS  = 100   // 100 milliseconds latency threshold
)

// ActiveBar holds the current in-memory aggregation state for a symbol.
type ActiveBar struct {
	Symbol     string
	Open       float64
	High       float64
	Low        float64
	Close      float64
	Volume     float64
	StartTime  int64 // Window start timestamp in event-time (ms)
	LastTickTS int64 // Timestamp of the last processed tick in event-time (ms)
}

// MessageSender abstracts ZeroMQ socket sending for decoupling and testing.
type MessageSender interface {
	Send(msg zmq4.Msg) error
}

// MessageReceiver abstracts ZeroMQ socket receiving for decoupling and testing.
type MessageReceiver interface {
	Recv() (zmq4.Msg, error)
}

type SymbolAggregator struct {
	symbol      string
	tickChan    chan *market_data.EquityTick
	pubSocket   MessageSender
	currentBar  *ActiveBar
	previousBar *ActiveBar // Kept for 100ms watermark late-tick updates
}

type AggregatorManager struct {
	mu          sync.RWMutex
	aggregators map[string]*SymbolAggregator
	pubSocket   MessageSender
}

// newPubSocket wraps zmq4.NewPub to allow mocking in tests.
var newPubSocket = func(ctx context.Context) zmq4.Socket {
	return zmq4.NewPub(ctx)
}

// newSubSocket wraps zmq4.NewSub to allow mocking in tests.
var newSubSocket = func(ctx context.Context) zmq4.Socket {
	return zmq4.NewSub(ctx)
}

func main() {
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runApp(ctx, *subAddr, *pubAddr); err != nil {
		slog.Error("Bar Aggregator terminated with fatal error", "error", err)
		os.Exit(1)
	}
}

func runApp(ctx context.Context, subAddress, pubAddress string) error {
	// Configure structured slog JSON logging in English.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	if err := runMain(ctx, subAddress, pubAddress); err != nil && err != context.Canceled {
		return err
	}
	slog.Info("Bar Aggregator shutdown gracefully")
	return nil
}

func runMain(ctx context.Context, subAddress, pubAddress string) error {
	slog.Info("Starting K-Line Bar Aggregator",
		"sub_addr", subAddress,
		"pub_addr", pubAddress,
		"component", "bar_aggregator")

	// Initialize ZeroMQ PUB socket.
	pubSocket := newPubSocket(ctx)
	if err := pubSocket.Listen(pubAddress); err != nil {
		return fmt.Errorf("failed to listen on ZeroMQ PUB address %s: %w", pubAddress, err)
	}
	defer pubSocket.Close()
	slog.Info("ZeroMQ PUB socket listening successfully", "pub_addr", pubAddress)

	// Initialize ZeroMQ SUB socket.
	subSocket := newSubSocket(ctx)
	if err := subSocket.Dial(subAddress); err != nil {
		return fmt.Errorf("failed to connect to ZeroMQ SUB address %s: %w", subAddress, err)
	}
	defer subSocket.Close()

	// Subscribe to all TICK events.
	if err := subSocket.SetOption(zmq4.OptionSubscribe, "TICK."); err != nil {
		return fmt.Errorf("failed to subscribe to TICK. topic: %w", err)
	}
	slog.Info("Subscribed to ZeroMQ TICK. topic successfully", "sub_addr", subAddress)

	runProcessingLoop(ctx, subSocket, pubSocket)
	return nil
}

func runProcessingLoop(ctx context.Context, subSocket MessageReceiver, pubSocket MessageSender) {
	manager := &AggregatorManager{
		aggregators: make(map[string]*SymbolAggregator),
		pubSocket:   pubSocket,
	}

	loopDone := make(chan struct{})

	go func() {
		defer close(loopDone)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			msg, err := subSocket.Recv()
			if err != nil {
				select {
				case <-ctx.Done():
					return
				default:
				}
				slog.Error("Failed to receive ZeroMQ message", "error", err)
				continue
			}

			// Expecting 2 frames: Topic, Payload
			if len(msg.Frames) < 2 {
				slog.Warn("Received invalid ZeroMQ message (less than 2 frames)")
				continue
			}

			var tick market_data.EquityTick
			if err := proto.Unmarshal(msg.Frames[1], &tick); err != nil {
				slog.Warn("Failed to unmarshal EquityTick proto", "error", err)
				continue
			}

			// Route tick to its dedicated symbol aggregator.
			agg := manager.getOrCreateAggregator(ctx, tick.Symbol)
			select {
			case agg.tickChan <- &tick:
			case <-ctx.Done():
				return
			}
		}
	}()

	select {
	case <-ctx.Done():
	case <-loopDone:
	}
}

func (m *AggregatorManager) getOrCreateAggregator(ctx context.Context, symbol string) *SymbolAggregator {
	m.mu.Lock()
	defer m.mu.Unlock()

	agg, exists := m.aggregators[symbol]
	if !exists {
		agg = &SymbolAggregator{
			symbol:    symbol,
			tickChan:  make(chan *market_data.EquityTick, 1000),
			pubSocket: m.pubSocket,
		}
		m.aggregators[symbol] = agg
		go agg.run(ctx)
		slog.Info("Created new symbol aggregator", "symbol", symbol)
	}
	return agg
}

func (sa *SymbolAggregator) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case tick := <-sa.tickChan:
			sa.processTick(tick)
		}
	}
}

func (sa *SymbolAggregator) processTick(tick *market_data.EquityTick) {
	tickTime := tick.Timestamp
	windowStart := tickTime - (tickTime % windowSizeMS)

	// Case 1: First tick for this symbol
	if sa.currentBar == nil {
		sa.currentBar = &ActiveBar{
			Symbol:     tick.Symbol,
			Open:       tick.Price,
			High:       tick.Price,
			Low:        tick.Price,
			Close:      tick.Price,
			Volume:     tick.Size,
			StartTime:  windowStart,
			LastTickTS: tickTime,
		}
		return
	}

	// Case 2: Tick fits in the current active window
	if windowStart == sa.currentBar.StartTime {
		sa.currentBar.Volume += tick.Size
		if tick.Price > sa.currentBar.High {
			sa.currentBar.High = tick.Price
		}
		if tick.Price < sa.currentBar.Low {
			sa.currentBar.Low = tick.Price
		}
		if tickTime >= sa.currentBar.LastTickTS {
			sa.currentBar.Close = tick.Price
			sa.currentBar.LastTickTS = tickTime
		}
		return
	}

	// Case 3: Tick is ahead of the current window (forward event-time shift)
	if windowStart > sa.currentBar.StartTime {
		sa.publishBar(sa.currentBar)
		sa.previousBar = sa.currentBar

		sa.currentBar = &ActiveBar{
			Symbol:     tick.Symbol,
			Open:       tick.Price,
			High:       tick.Price,
			Low:        tick.Price,
			Close:      tick.Price,
			Volume:     tick.Size,
			StartTime:  windowStart,
			LastTickTS: tickTime,
		}
		return
	}

	// Case 4: Late tick (windowStart < currentBar.StartTime)
	if windowStart < sa.currentBar.StartTime {
		if tickTime >= (sa.currentBar.StartTime - watermarkMS) && sa.previousBar != nil && windowStart == sa.previousBar.StartTime {
			slog.Info("Processing late tick within watermark window",
				"symbol", tick.Symbol,
				"tick_timestamp", tickTime,
				"active_window_start", sa.currentBar.StartTime,
				"correlation_id", tick.CorrelationId)

			sa.previousBar.Volume += tick.Size
			if tick.Price > sa.previousBar.High {
				sa.previousBar.High = tick.Price
			}
			if tick.Price < sa.previousBar.Low {
				sa.previousBar.Low = tick.Price
			}
			if tickTime >= sa.previousBar.LastTickTS {
				sa.previousBar.Close = tick.Price
				sa.previousBar.LastTickTS = tickTime
			}

			sa.publishBar(sa.previousBar)
		} else {
			slog.Warn("Late tick discarded (exceeded watermark threshold)",
				"symbol", tick.Symbol,
				"tick_timestamp", tickTime,
				"active_window_start", sa.currentBar.StartTime,
				"correlation_id", tick.CorrelationId)
		}
	}
}

func (sa *SymbolAggregator) publishBar(bar *ActiveBar) {
	equityBar := &market_data.EquityBar{
		Symbol:     bar.Symbol,
		Open:       bar.Open,
		High:       bar.High,
		Low:        bar.Low,
		Close:      bar.Close,
		Volume:     bar.Volume,
		WindowSize: int64(windowSizeMS / 1000), // Seconds (60)
		Timestamp:  bar.StartTime,
	}

	protoBytes, err := proto.Marshal(equityBar)
	if err != nil {
		slog.Error("Failed to marshal EquityBar proto", "error", err, "symbol", bar.Symbol)
		return
	}

	topic := []byte("BAR." + bar.Symbol)
	msg := zmq4.NewMsgFrom(topic, protoBytes)

	if err := sa.pubSocket.Send(msg); err != nil {
		slog.Error("Failed to publish EquityBar over ZeroMQ", "error", err, "symbol", bar.Symbol)
	} else {
		slog.Info("Published EquityBar successfully",
			"symbol", bar.Symbol,
			"open", bar.Open,
			"close", bar.Close,
			"high", bar.High,
			"low", bar.Low,
			"volume", bar.Volume,
			"timestamp", bar.StartTime)
	}
}
