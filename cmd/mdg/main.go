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
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"bulldog_alpha/proto/market_data"
	"github.com/coder/websocket"
	"github.com/go-zeromq/zmq4"
	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
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
	healthPort = flag.String("health-port", "50053", "gRPC health check server port")
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

	// Initialize standard gRPC health check server
	healthLis, err := net.Listen("tcp", ":"+*healthPort)
	if err != nil {
		return fmt.Errorf("failed to listen for gRPC health server: %w", err)
	}
	grpcServer := grpc.NewServer()
	healthServer := health.NewServer()
	grpc_health_v1.RegisterHealthServer(grpcServer, healthServer)
	healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	go func() {
		if err := grpcServer.Serve(healthLis); err != nil {
			slog.Error("gRPC health server failed", "error", err)
		}
	}()
	defer grpcServer.GracefulStop()

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
		if key == "" {
			slog.Info("MDG: Local development mode active (no Polygon API key). Gateway is serving health checks on port 50053.",
				"retry_backoff", backoffDuration.String(),
				"error", err.Error())
		} else {
			slog.Warn("WebSocket disconnected, retrying with exponential backoff",
				"error", err,
				"backoff_duration", backoffDuration.String(),
				"attempt", int(backoffAttempt+1))
		}

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
		isAlpaca := strings.Contains(wsURL, "alpaca.markets")
		var authBytes []byte
		var err error

		if isAlpaca {
			parts := strings.Split(key, ":")
			if len(parts) != 2 {
				return fmt.Errorf("for Alpaca, api-key must be in the format 'KEY_ID:SECRET_KEY'")
			}
			authMsg := map[string]interface{}{
				"action": "auth",
				"key":    parts[0],
				"secret": parts[1],
			}
			authBytes, err = json.Marshal(authMsg)
		} else {
			authMsg := map[string]interface{}{
				"action": "auth",
				"params": key,
			}
			authBytes, err = json.Marshal(authMsg)
		}

		if err != nil {
			return fmt.Errorf("failed to marshal auth message: %w", err)
		}
		if err := conn.Write(ctx, websocket.MessageText, authBytes); err != nil {
			return fmt.Errorf("failed to write auth message: %w", err)
		}
		slog.Info("Sent authentication message to server")

		// Read the first response.
		// If it's a real Polygon server, it sends a welcome status message first.
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return fmt.Errorf("failed to read welcome/auth status: %w", err)
		}
		slog.Info("Received first payload from server", "payload", string(payload))

		if isAlpaca {
			// For Alpaca, verify auth success in the response and send subscription
			if strings.Contains(string(payload), "authenticated") || strings.Contains(string(payload), "success") {
				subMsg := map[string]interface{}{
					"action": "subscribe",
					"trades": []string{"AAPL", "MSFT", "TSLA", "AMZN", "NVDA"},
				}
				subBytes, err := json.Marshal(subMsg)
				if err != nil {
					return fmt.Errorf("failed to marshal subscribe message: %w", err)
				}
				if err := conn.Write(ctx, websocket.MessageText, subBytes); err != nil {
					return fmt.Errorf("failed to write subscribe message: %w", err)
				}
				slog.Info("Sent Alpaca stock trades subscription request for AAPL, MSFT, TSLA, AMZN, NVDA")
			}
		} else if strings.Contains(string(payload), "\"ev\":\"status\"") {
			// Polygon status path
			_, authPayload, err := conn.Read(ctx)
			if err != nil {
				return fmt.Errorf("failed to read authentication status: %w", err)
			}
			slog.Info("Received authentication status from Polygon", "payload", string(authPayload))

			// Send the subscribe message.
			subMsg := map[string]interface{}{
				"action": "subscribe",
				"params": "T.AAPL,T.MSFT,T.TSLA,T.AMZN,T.NVDA",
			}
			subBytes, err := json.Marshal(subMsg)
			if err != nil {
				return fmt.Errorf("failed to marshal subscribe message: %w", err)
			}
			if err := conn.Write(ctx, websocket.MessageText, subBytes); err != nil {
				return fmt.Errorf("failed to write subscribe message: %w", err)
			}
			slog.Info("Sent stock ticker subscription request for AAPL, MSFT, TSLA, AMZN, NVDA")
		} else {
			// If it's not a status event, it must be tick data from our unit test mock server.
			slog.Info("First payload is not a status message; assuming test mock feed. Processing payload immediately.")
			go processAndPublish(payload, pubSocket)
		}
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

	// Check if the payload is in Alpaca stock trade tick format (tagged with "T":"t")
	if strings.Contains(string(payload), "\"T\":\"t\"") {
		var alpacaTicks []struct {
			Type      string  `json:"T"`
			Symbol    string  `json:"S"`
			Price     float64 `json:"p"`
			Size      float64 `json:"s"`
			Timestamp string  `json:"t"`
		}
		if err := json.Unmarshal(payload, &alpacaTicks); err != nil {
			slog.Warn("Failed to unmarshal Alpaca tick array", "error", err, "payload", string(payload))
			return
		}
		for _, at := range alpacaTicks {
			if at.Type == "t" {
				ts, err := time.Parse(time.RFC3339, at.Timestamp)
				var msTimestamp int64
				if err != nil {
					msTimestamp = time.Now().UnixNano() / 1e6
				} else {
					msTimestamp = ts.UnixNano() / 1e6
				}
				rawTicks = append(rawTicks, RawTick{
					Symbol:    at.Symbol,
					Price:     at.Price,
					Size:      at.Size,
					Timestamp: msTimestamp,
				})
			}
		}
	} else {
		// Standard Polygon or Test Mock JSON format
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
