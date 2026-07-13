package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"os/signal"
	"syscall"
	"time"

	"bulldog_alpha/proto/market_data"
	"github.com/coder/websocket"
	"github.com/go-zeromq/zmq4"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
)

// RawTick represents the raw JSON message format expected from the websocket.
type RawTick struct {
	Symbol    string  `json:"sym"`
	Price     float64 `json:"p"`
	Size      float64 `json:"s"`
	Timestamp int64   `json:"t"` // Millisecond epoch
}

// MessageSender abstracts ZeroMQ socket sending for decoupling and testing.
type MessageSender interface {
	Send(msg zmq4.Msg) error
}

// WebSocketConn abstracts the coder/websocket Conn for testing.
type WebSocketConn interface {
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Write(ctx context.Context, typ websocket.MessageType, data []byte) error
	Close(code websocket.StatusCode, reason string) error
}

var (
	polygonURL = flag.String("polygon-url", "ws://localhost:8080/polygon", "Polygon.io WebSocket connection URL")
	apiKey     = flag.String("api-key", "", "API key token for Polygon.io authentication")
	zmqAddr    = flag.String("zmq-addr", "tcp://*:5555", "ZeroMQ PUB socket binding address")
)

// dialWebSocket wraps websocket.Dial to allow mocking in tests.
var dialWebSocket = func(ctx context.Context, url string) (WebSocketConn, error) {
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

// newPubSocket wraps zmq4.NewPub to allow mocking in tests.
var newPubSocket = func(ctx context.Context) zmq4.Socket {
	return zmq4.NewPub(ctx)
}

func main() {
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runApp(ctx, *polygonURL, *apiKey, *zmqAddr); err != nil {
		slog.Error("MDG terminated with fatal error", "error", err)
		os.Exit(1)
	}
}

func runApp(ctx context.Context, wsURL, key, bindAddr string) error {
	// Configure structured slog JSON logging to stdout in English.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	if err := runMain(ctx, wsURL, key, bindAddr); err != nil && err != context.Canceled {
		return err
	}
	slog.Info("MDG shutdown gracefully")
	return nil
}

func runMain(ctx context.Context, wsURL, key, bindAddr string) error {
	slog.Info("Starting Market Data Ingestion Gateway (MDG)",
		"polygon_url", wsURL,
		"zmq_addr", bindAddr,
		"component", "mdg")

	// Initialize ZeroMQ PUB socket.
	pubSocket := newPubSocket(ctx)
	if err := pubSocket.Listen(bindAddr); err != nil {
		return fmt.Errorf("failed to listen on ZeroMQ PUB address %s: %w", bindAddr, err)
	}
	defer pubSocket.Close()
	slog.Info("ZeroMQ PUB socket listening successfully", "zmq_addr", bindAddr)

	return runIngestionLoop(ctx, pubSocket, wsURL, key)
}

func runIngestionLoop(ctx context.Context, pubSocket MessageSender, wsURL, key string) error {
	const maxBackoff = 30 * time.Second
	var backoffAttempt float64 = 0

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		slog.Info("Connecting to Polygon.io WebSocket...", "polygon_url", wsURL)
		err := connectAndIngest(ctx, pubSocket, wsURL, key)
		if errors.Is(err, context.Canceled) {
			return err
		}

		// Handle connection drops and apply exponential backoff.
		backoffDuration := time.Duration(math.Min(float64(maxBackoff), math.Pow(2, backoffAttempt)*100)) * time.Millisecond
		slog.Warn("WebSocket disconnected, retrying with exponential backoff",
			"error", err,
			"backoff_duration", backoffDuration.String(),
			"attempt", int(backoffAttempt+1))

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoffDuration):
		}
		backoffAttempt++
	}
}

func connectAndIngest(ctx context.Context, pubSocket MessageSender, wsURL, key string) error {
	conn, err := dialWebSocket(ctx, wsURL)
	if err != nil {
		return fmt.Errorf("dial failed: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "Closing connection")
	slog.Info("WebSocket connected successfully", "polygon_url", wsURL)

	// Optional authentication step if API Key is supplied.
	if key != "" {
		authMsg := map[string]interface{}{
			"action": "auth",
			"params": key,
		}
		authBytes, err := json.Marshal(authMsg)
		if err != nil {
			return fmt.Errorf("failed to marshal auth message: %w", err)
		}
		if err := conn.Write(ctx, websocket.MessageText, authBytes); err != nil {
			return fmt.Errorf("failed to write auth message: %w", err)
		}
		slog.Info("Sent authentication message to server")
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		messageType, payload, err := conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != -1 || err == io.EOF {
				slog.Info("WebSocket closed by server")
				return err
			}
			return fmt.Errorf("read error: %w", err)
		}

		if messageType != websocket.MessageText && messageType != websocket.MessageBinary {
			continue
		}

		go processAndPublish(payload, pubSocket)
	}
}

func processAndPublish(payload []byte, pubSocket MessageSender) {
	if len(payload) == 0 {
		slog.Warn("Empty websocket payload received, discarding")
		return
	}

	var rawTicks []RawTick
	if payload[0] == '[' {
		if err := json.Unmarshal(payload, &rawTicks); err != nil {
			slog.Warn("Failed to unmarshal JSON array payload", "error", err, "payload", string(payload))
			return
		}
	} else {
		var singleTick RawTick
		if err := json.Unmarshal(payload, &singleTick); err != nil {
			slog.Warn("Failed to unmarshal JSON object payload", "error", err, "payload", string(payload))
			return
		}
		rawTicks = append(rawTicks, singleTick)
	}

	for _, tick := range rawTicks {
		if tick.Symbol == "" || tick.Timestamp == 0 {
			slog.Warn("Received tick with empty symbol or timestamp, discarding",
				"symbol", tick.Symbol,
				"timestamp", tick.Timestamp)
			continue
		}

		correlationID := uuid.New().String()

		equityTick := &market_data.EquityTick{
			Symbol:        tick.Symbol,
			Price:         tick.Price,
			Size:          tick.Size,
			Timestamp:     tick.Timestamp,
			CorrelationId: correlationID,
		}

		protoBytes, err := proto.Marshal(equityTick)
		if err != nil {
			slog.Error("Failed to marshal EquityTick to protobuf",
				"error", err,
				"symbol", tick.Symbol,
				"correlation_id", correlationID)
			continue
		}

		topic := []byte("TICK." + tick.Symbol)
		msg := zmq4.NewMsgFrom(topic, protoBytes)

		if err := pubSocket.Send(msg); err != nil {
			slog.Error("Failed to publish tick over ZeroMQ",
				"error", err,
				"symbol", tick.Symbol,
				"correlation_id", correlationID)
		} else {
			slog.Debug("Published EquityTick successfully",
				"symbol", tick.Symbol,
				"price", tick.Price,
				"correlation_id", correlationID)
		}
	}
}
