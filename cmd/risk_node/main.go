package main

import (
	"context"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"

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

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	slog.Info("starting_risk_node", "redis_addr", *redisAddr, "grpc_port", *grpcPort)

	rdb := redis.NewClient(&redis.Options{
		Addr: *redisAddr,
	})

	luaBytes, err := os.ReadFile(*luaPath)
	if err != nil {
		slog.Error("failed_to_read_lua_script", "path", *luaPath, "error", err)
		os.Exit(1)
	}

	rn, err := interceptor.NewRiskNode(rdb, string(luaBytes), *maxCap)
	if err != nil {
		slog.Error("failed_to_initialize_risk_node", "error", err)
		os.Exit(1)
	}

	go func() {
		http.Handle("/metrics", promhttp.Handler())
		slog.Info("metrics_server_listening", "port", *metricsPort)
		if err := http.ListenAndServe(":"+*metricsPort, nil); err != nil {
			slog.Error("metrics_server_failed", "error", err)
		}
	}()

	lis, err := net.Listen("tcp", ":"+*grpcPort)
	if err != nil {
		slog.Error("failed_to_listen_grpc", "port", *grpcPort, "error", err)
		os.Exit(1)
	}

	s := grpc.NewServer(
		grpc.UnaryInterceptor(rn.RiskInterceptor),
	)
	order.RegisterOrderServiceServer(s, &Server{})

	go func() {
		slog.Info("grpc_server_listening", "port", *grpcPort)
		if err := s.Serve(lis); err != nil {
			slog.Error("grpc_server_failed", "error", err)
		}
	}()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	slog.Info("shutting_down_gracefully")
	s.GracefulStop()
	rdb.Close()
}
