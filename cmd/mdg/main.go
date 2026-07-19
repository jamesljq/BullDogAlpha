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
	"sync"
	"syscall"
	"time"

	"bulldog_alpha/proto/market_data"
	"github.com/coder/websocket"
	"github.com/go-zeromq/zmq4"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/protobuf/proto"
)

var notifyContext = signal.NotifyContext
var protoMarshal = proto.Marshal
var jsonMarshal = json.Marshal
var osExit = os.Exit

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
	feedURL    = flag.String("feed-url", "ws://localhost:8080/polygon", "Market data feed WebSocket connection URL")
	apiKey     = flag.String("api-key", "", "API key token for market data feed authentication")
	feedVendor = flag.String("feed-vendor", "polygon", "Market data feed vendor (polygon, alpaca)")
	redisAddr  = flag.String("redis-addr", "", "Redis connection address (optional)")
	zmqAddr    = flag.String("zmq-addr", "tcp://*:5555", "ZeroMQ PUB socket binding address")
	healthPort = flag.String("health-port", "50053", "gRPC health check server port")
)

var (
	configMu      sync.RWMutex
	activeTickers = []string{"AAPL", "MSFT", "TSLA", "AMZN", "NVDA"}
	activeVendor  = "polygon"
	activeStatus  = "RUNNING"
	activeURL     = ""
	reconnectChan = make(chan struct{}, 1)
	rdbClient     *redis.Client
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

var runAppHook = runApp

func main() {
	flag.Parse()
	ctx, stop := notifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runAppHook(ctx, *feedURL, *apiKey, *zmqAddr); err != nil {
		slog.Error("MDG terminated with fatal error", "error", err)
		osExit(1)
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

	configMu.Lock()
	activeVendor = *feedVendor
	activeURL = wsURL
	configMu.Unlock()

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

	// Connect to Redis if address is supplied
	if redisAddr != nil && *redisAddr != "" {
		rdb := redis.NewClient(&redis.Options{
			Addr:        *redisAddr,
			DialTimeout: 200 * time.Millisecond,
		})
		pingCtx, pingCancel := context.WithTimeout(ctx, 200*time.Millisecond)
		_, err := rdb.Ping(pingCtx).Result()
		pingCancel()
		if err != nil {
			slog.Warn("Failed to connect to Redis; running in local standalone mode", "error", err)
			rdb.Close()
		} else {
			slog.Info("Connected to Redis successfully", "redis_addr", *redisAddr)
			rdbClient = rdb
			defer func() {
				rdbClient = nil
			}()
			
			// Load active tickers
			tickersJSON, err := rdb.Get(ctx, "mdg:active_tickers").Result()
			if err == nil && tickersJSON != "" {
				var tickers []string
				if err := json.Unmarshal([]byte(tickersJSON), &tickers); err == nil && len(tickers) > 0 {
					configMu.Lock()
					activeTickers = tickers
					configMu.Unlock()
					slog.Info("Loaded active tickers from Redis", "tickers", tickers)
				}
			} else {
				// Initialize Redis with default tickers
				defJSON, _ := jsonMarshal(activeTickers)
				rdb.Set(ctx, "mdg:active_tickers", string(defJSON), 0)
			}

			// Load active vendor
			vendor, err := rdb.Get(ctx, "mdg:vendor").Result()
			if err == nil && vendor != "" {
				configMu.Lock()
				activeVendor = vendor
				configMu.Unlock()
				slog.Info("Loaded active vendor from Redis", "vendor", vendor)
			} else {
				rdb.Set(ctx, "mdg:vendor", activeVendor, 0)
			}

			// Load active status
			status, err := rdb.Get(ctx, "mdg:status").Result()
			if err == nil && status != "" {
				configMu.Lock()
				activeStatus = status
				configMu.Unlock()
				slog.Info("Loaded active status from Redis", "status", status)
			} else {
				rdb.Set(ctx, "mdg:status", activeStatus, 0)
			}

			// Start PubSub subscription monitor
			go func() {
				pubsub := rdb.Subscribe(ctx, "mdg:control_events")
				defer pubsub.Close()
				ch := pubsub.Channel()
				slog.Info("Subscribed to Redis control channel mdg:control_events")
				for {
					select {
					case <-ctx.Done():
						return
					case msg, ok := <-ch:
						if !ok {
							return
						}
						var cmd struct {
							Action  string   `json:"action"`
							Tickers []string `json:"tickers"`
							Vendor  string   `json:"vendor"`
							URL     string   `json:"url"`
						}
						if err := json.Unmarshal([]byte(msg.Payload), &cmd); err != nil {
							slog.Error("Failed to unmarshal PubSub control command", "error", err, "payload", msg.Payload)
							continue
						}
						slog.Info("Received Redis control command", "action", cmd.Action, "vendor", cmd.Vendor, "tickers", cmd.Tickers)

						configMu.Lock()
						if cmd.Action == "pause" {
							activeStatus = "PAUSED"
						} else if cmd.Action == "resume" {
							activeStatus = "RUNNING"
						} else if cmd.Action == "update_subscriptions" {
							activeTickers = cmd.Tickers
						} else if cmd.Action == "set_vendor" {
							activeVendor = cmd.Vendor
							if cmd.URL != "" {
								activeURL = cmd.URL
							}
						}
						configMu.Unlock()

						// Signal ingest loop reconnection
						select {
						case reconnectChan <- struct{}{}:
						default:
						}
					}
				}
			}()
		}
	}

	// Initialize ZeroMQ PUB socket.
	pubSocket := newPubSocket(ctx)
	if err := pubSocket.Listen(bindAddr); err != nil {
		return fmt.Errorf("failed to listen on ZeroMQ PUB address %s: %w", bindAddr, err)
	}
	defer pubSocket.Close()
	slog.Info("ZeroMQ PUB socket listening successfully", "zmq_addr", bindAddr)

	return runIngestionLoop(ctx, pubSocket, key)
}

func runIngestionLoop(ctx context.Context, pubSocket MessageSender, key string) error {
	const maxBackoff = 30 * time.Second
	var backoffAttempt float64 = 0

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		configMu.RLock()
		status := activeStatus
		vendor := activeVendor
		wsURL := activeURL
		tickers := make([]string, len(activeTickers))
		copy(tickers, activeTickers)
		configMu.RUnlock()

		if status == "PAUSED" {
			slog.Info("MDG is PAUSED. Waiting for RESUME command...")
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-reconnectChan:
				continue
			}
		}

		slog.Info("Connecting to market data feed...", "vendor", vendor, "url", wsURL, "tickers", tickers)

		ingestCtx, cancelIngest := context.WithCancel(ctx)
		go func() {
			select {
			case <-ingestCtx.Done():
			case <-reconnectChan:
				slog.Info("Reconnection signaled. Cancelling current ingestion stream.")
				cancelIngest()
			}
		}()

		err := connectAndIngest(ingestCtx, pubSocket, wsURL, key, vendor, tickers)
		cancelIngest()

		if errors.Is(err, context.Canceled) {
			slog.Info("Ingestion context was cancelled; checking for configuration updates.")
			backoffAttempt = 0
			continue
		}

		backoffDuration := time.Duration(math.Min(float64(maxBackoff), math.Pow(2, backoffAttempt)*100)) * time.Millisecond
		if key == "" {
			slog.Info("MDG: Local development mode active (no API key). Gateway is serving health checks.",
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
		case <-reconnectChan:
			slog.Info("Reconnection signaled during backoff sleep.")
			backoffAttempt = 0
		case <-time.After(backoffDuration):
			backoffAttempt++
		}
	}
}

func connectAndIngest(ctx context.Context, pubSocket MessageSender, wsURL, key, vendor string, tickers []string) error {
	conn, err := dialWebSocket(ctx, wsURL)
	if err != nil {
		return fmt.Errorf("dial failed: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "Closing connection")
	slog.Info("WebSocket connected successfully", "url", wsURL)

	// Optional authentication step if API Key is supplied.
	if key != "" {
		isAlpaca := vendor == "alpaca"
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
			authBytes, err = jsonMarshal(authMsg)
		} else {
			authMsg := map[string]interface{}{
				"action": "auth",
				"params": key,
			}
			authBytes, err = jsonMarshal(authMsg)
		}

		if err != nil {
			return fmt.Errorf("failed to marshal auth message: %w", err)
		}
		if err := conn.Write(ctx, websocket.MessageText, authBytes); err != nil {
			return fmt.Errorf("failed to write auth message: %w", err)
		}
		slog.Info("Sent authentication message to server")

		// Read the first response.
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return fmt.Errorf("failed to read welcome/auth status: %w", err)
		}
		slog.Info("Received first payload from server", "payload", string(payload))

		if isAlpaca {
			if strings.Contains(string(payload), "authenticated") || strings.Contains(string(payload), "success") {
				subMsg := map[string]interface{}{
					"action": "subscribe",
					"trades": tickers,
				}
				subBytes, err := jsonMarshal(subMsg)
				if err != nil {
					return fmt.Errorf("failed to marshal subscribe message: %w", err)
				}
				if err := conn.Write(ctx, websocket.MessageText, subBytes); err != nil {
					return fmt.Errorf("failed to write subscribe message: %w", err)
				}
				slog.Info("Sent Alpaca stock trades subscription request", "tickers", tickers)
			}
		} else if strings.Contains(string(payload), "\"ev\":\"status\"") {
			_, authPayload, err := conn.Read(ctx)
			if err != nil {
				return fmt.Errorf("failed to read authentication status: %w", err)
			}
			slog.Info("Received authentication status from Polygon", "payload", string(authPayload))

			var formatted []string
			for _, t := range tickers {
				formatted = append(formatted, "T."+t)
			}
			subMsg := map[string]interface{}{
				"action": "subscribe",
				"params": strings.Join(formatted, ","),
			}
			subBytes, err := jsonMarshal(subMsg)
			if err != nil {
				return fmt.Errorf("failed to marshal subscribe message: %w", err)
			}
			if err := conn.Write(ctx, websocket.MessageText, subBytes); err != nil {
				return fmt.Errorf("failed to write subscribe message: %w", err)
			}
			slog.Info("Sent stock ticker subscription request to Polygon", "params", subMsg["params"])
		} else {
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

	configMu.RLock()
	vendor := activeVendor
	configMu.RUnlock()

	// Check if the feed vendor is Alpaca
	if vendor == "alpaca" {
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

		protoBytes, err := protoMarshal(equityTick)
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

		if rdbClient != nil {
			tickBytes, err := jsonMarshal(tick)
			if err == nil {
				rdbClient.Publish(context.Background(), "mdg:ticks", string(tickBytes))
			}
		}
	}
}
