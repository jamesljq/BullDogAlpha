package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"

	"bulldog_alpha/cmd/risk_node/interceptor"
	"bulldog_alpha/proto/order"
)

type Server struct {
	order.UnimplementedOrderServiceServer
}

func (s *Server) SubmitOrder(ctx context.Context, req *order.OrderRequest) (*order.OrderResponse, error) {
	slog.Info("ems_handling_submit_order", "order_id", req.OrderId)
	return &order.OrderResponse{
		OrderId:       req.OrderId,
		Status:        order.OrderStatus_SUBMITTED,
		Reason:        "APPROVED",
		CorrelationId: req.CorrelationId,
	}, nil
}

func (s *Server) CancelOrder(ctx context.Context, req *order.CancelOrderRequest) (*order.OrderResponse, error) {
	slog.Info("ems_handling_cancel_order", "order_id", req.OrderId)
	return &order.OrderResponse{
		OrderId:       req.OrderId,
		Status:        order.OrderStatus_CANCELED,
		Reason:        "CANCELLED",
		CorrelationId: req.CorrelationId,
	}, nil
}

func main() {
	redisAddr := flag.String("redis-addr", "localhost:6379", "Redis connection address")
	grpcPort := flag.String("grpc-port", "50051", "gRPC port")
	metricsPort := flag.String("metrics-port", "2112", "Prometheus metrics port")
	maxCap := flag.Float64("max-cap", 50000.0, "Single order cap limit")
	luaPath := flag.String("lua-path", "cmd/risk_node/lua/risk_check.lua", "Path to Lua check script")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := runRiskNode(ctx, *redisAddr, *grpcPort, *metricsPort, *luaPath, *maxCap); err != nil {
		slog.Error("risk_node_failed", "error", err)
		os.Exit(1)
	}
}

func runRiskNode(ctx context.Context, redisAddr, grpcPort, metricsPort, luaPath string, maxCap float64) error {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	slog.Info("starting_risk_node", "redis_addr", redisAddr, "grpc_port", grpcPort)

	rdb := redis.NewClient(&redis.Options{
		Addr: redisAddr,
	})
	defer rdb.Close()

	luaBytes, err := os.ReadFile(luaPath)
	if err != nil {
		return fmt.Errorf("failed to read lua script: %w", err)
	}

	rn, err := interceptor.NewRiskNode(rdb, string(luaBytes), maxCap)
	if err != nil {
		return fmt.Errorf("failed to initialize risk node: %w", err)
	}

	lis, err := net.Listen("tcp", ":"+grpcPort)
	if err != nil {
		return fmt.Errorf("failed to listen grpc on port %s: %w", grpcPort, err)
	}

	s := grpc.NewServer(
		grpc.UnaryInterceptor(rn.RiskInterceptor),
	)
	order.RegisterOrderServiceServer(s, &Server{})

	healthServer := health.NewServer()
	grpc_health_v1.RegisterHealthServer(s, healthServer)
	healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)

	errChan := make(chan error, 1)
	go func() {
		slog.Info("grpc_server_listening", "port", grpcPort)
		if err := s.Serve(lis); err != nil {
			errChan <- err
		}
	}()

	select {
	case <-ctx.Done():
		slog.Info("shutting_down_gracefully")
		s.GracefulStop()
		return nil
	case err := <-errChan:
		return err
	}
}
