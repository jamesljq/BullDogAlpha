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

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"

	"bulldog_alpha/cmd/ems/state"
	"bulldog_alpha/proto/order"
)

type EMSServer struct {
	order.UnimplementedOrderServiceServer
	order.UnimplementedControlServiceServer
	SM *state.StateMachine
}

func (s *EMSServer) ForcePause(ctx context.Context, req *order.ForcePauseRequest) (*order.ForcePauseResponse, error) {
	slog.Info("ems_force_pause_received", "reason", req.Reason)
	if s.SM != nil {
		s.SM.SetDegraded(true)
	}
	return &order.ForcePauseResponse{Success: true, CorrelationId: req.CorrelationId}, nil
}

func (s *EMSServer) SubmitOrder(ctx context.Context, req *order.OrderRequest) (*order.OrderResponse, error) {
	slog.Info("ems_submitting_order", "order_id", req.OrderId, "symbol", req.Symbol, "qty", req.Quantity, "price", req.Price)

	runtime, idempotent, err := s.SM.SubmitOrder(ctx, req)
	if err != nil {
		slog.Error("ems_submit_failed", "order_id", req.OrderId, "error", err)
		return &order.OrderResponse{
			OrderId:       req.OrderId,
			Status:        order.OrderStatus_REJECTED,
			Reason:        err.Error(),
			CorrelationId: req.CorrelationId,
		}, nil
	}

	statusVal := order.OrderStatus_SUBMITTED
	reason := "SUBMITTED"
	if idempotent {
		statusVal = runtime.GetState()
		reason = "IDEMPOTENT_RETRY"
	}

	return &order.OrderResponse{
		OrderId:       req.OrderId,
		Status:        statusVal,
		Reason:        reason,
		CorrelationId: req.CorrelationId,
	}, nil
}

func (s *EMSServer) CancelOrder(ctx context.Context, req *order.CancelOrderRequest) (*order.OrderResponse, error) {
	slog.Info("ems_canceling_order", "order_id", req.OrderId)

	runtime, exists := s.SM.GetOrder(req.OrderId)
	if !exists {
		return &order.OrderResponse{
			OrderId:       req.OrderId,
			Status:        order.OrderStatus_REJECTED,
			Reason:        "ORDER_NOT_FOUND",
			CorrelationId: req.CorrelationId,
		}, nil
	}

	currentState := runtime.GetState()

	if currentState == order.OrderStatus_FILLED || currentState == order.OrderStatus_CANCELED || currentState == order.OrderStatus_REJECTED {
		return &order.OrderResponse{
			OrderId:       req.OrderId,
			Status:        currentState,
			Reason:        "REJECTED_ALREADY_TERMINAL",
			CorrelationId: req.CorrelationId,
		}, nil
	}

	err := s.SM.TransitionState(ctx, req.OrderId, order.OrderStatus_PENDING_CANCEL, 0, req.CorrelationId)
	if err != nil {
		return &order.OrderResponse{
			OrderId:       req.OrderId,
			Status:        order.OrderStatus_REJECTED,
			Reason:        fmt.Sprintf("failed to transition to PENDING_CANCEL: %v", err),
			CorrelationId: req.CorrelationId,
		}, nil
	}

	err = s.SM.TransitionState(ctx, req.OrderId, order.OrderStatus_CANCELED, 0, req.CorrelationId)
	if err != nil {
		return &order.OrderResponse{
			OrderId:       req.OrderId,
			Status:        order.OrderStatus_REJECTED,
			Reason:        fmt.Sprintf("failed to transition to CANCELED: %v", err),
			CorrelationId: req.CorrelationId,
		}, nil
	}

	return &order.OrderResponse{
		OrderId:       req.OrderId,
		Status:        order.OrderStatus_CANCELED,
		Reason:        "CANCELED",
		CorrelationId: req.CorrelationId,
	}, nil
}

func main() {
	port := flag.String("port", "50052", "gRPC port")
	walPath := flag.String("wal-path", "ems.wal", "Write-Ahead Log path")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := runEMS(ctx, *port, *walPath); err != nil {
		slog.Error("ems_failed", "error", err)
		os.Exit(1)
	}
}

func runEMS(ctx context.Context, port, walPath string) error {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	slog.Info("starting_ems_service", "port", port, "wal_path", walPath)

	wal, err := state.NewFileWAL(walPath)
	if err != nil {
		return fmt.Errorf("failed to initialize WAL: %w", err)
	}

	sm := state.NewStateMachine(wal)

	slog.Info("replaying_wal_log")
	if err := sm.RecoverFromWAL(); err != nil {
		wal.Close()
		return fmt.Errorf("wal replay failed: %w", err)
	}
	slog.Info("wal_replay_completed")

	lis, err := net.Listen("tcp", ":"+port)
	if err != nil {
		wal.Close()
		return fmt.Errorf("failed to listen on port %s: %w", port, err)
	}

	s := grpc.NewServer()
	emsSrv := &EMSServer{SM: sm}
	order.RegisterOrderServiceServer(s, emsSrv)
	order.RegisterControlServiceServer(s, emsSrv)

	healthServer := health.NewServer()
	grpc_health_v1.RegisterHealthServer(s, healthServer)
	healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)

	errChan := make(chan error, 1)
	go func() {
		slog.Info("ems_grpc_server_listening", "port", port)
		if err := s.Serve(lis); err != nil {
			errChan <- err
		}
	}()

	select {
	case <-ctx.Done():
		slog.Info("shutting_down_ems_gracefully")
		s.GracefulStop()
		wal.Close()
		return nil
	case err := <-errChan:
		wal.Close()
		return err
	}
}
