package state

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"bulldog_alpha/proto/order"
)

type OrderRuntime struct {
	mu            sync.Mutex
	OrderID       string
	Symbol        string
	Price         float64
	TotalQty      int32
	CumQty        int32
	State         order.OrderStatus
	CorrelationID string
}

type StateMachine struct {
	orders   sync.Map // string -> *OrderRuntime
	wal      WAL
	degraded int32 // 0 = active, 1 = degraded (read-only)
}

func NewStateMachine(wal WAL) *StateMachine {
	return &StateMachine{
		wal: wal,
	}
}

func (sm *StateMachine) SetDegraded(val bool) {
	if val {
		atomic.StoreInt32(&sm.degraded, 1)
	} else {
		atomic.StoreInt32(&sm.degraded, 0)
	}
}

func (sm *StateMachine) IsDegraded() bool {
	return atomic.LoadInt32(&sm.degraded) == 1
}

func (sm *StateMachine) SubmitOrder(ctx context.Context, req *order.OrderRequest) (*OrderRuntime, bool, error) {
	if val, loaded := sm.orders.Load(req.OrderId); loaded {
		runtime := val.(*OrderRuntime)
		return runtime, true, nil
	}

	if sm.IsDegraded() {
		return nil, false, errors.New("EMS_DEGRADED_READ_ONLY: server in degraded mode due to storage failure")
	}

	runtime := &OrderRuntime{
		OrderID:       req.OrderId,
		Symbol:        req.Symbol,
		Price:         req.Price,
		TotalQty:      int32(req.Quantity),
		CumQty:        0,
		State:         order.OrderStatus_PENDING,
		CorrelationID: req.CorrelationId,
	}

	sm.orders.Store(req.OrderId, runtime)

	if sm.wal != nil {
		ev := &OrderEvent{
			OrderID:       runtime.OrderID,
			State:         runtime.State,
			Timestamp:     time.Now(),
			CorrelationID: runtime.CorrelationID,
			Symbol:        runtime.Symbol,
			Price:         runtime.Price,
			TotalQty:      runtime.TotalQty,
		}
		if err := sm.wal.Append(ev); err != nil {
			sm.SetDegraded(true)
			sm.orders.Delete(req.OrderId)
			return nil, false, fmt.Errorf("WAL write failed: %w", err)
		}
	}

	err := sm.TransitionState(ctx, req.OrderId, order.OrderStatus_SUBMITTED, 0, req.CorrelationId)
	if err != nil {
		return nil, false, fmt.Errorf("failed to transition to SUBMITTED: %w", err)
	}

	return runtime, false, nil
}

func (sm *StateMachine) TransitionState(ctx context.Context, orderID string, targetState order.OrderStatus, deltaQty int32, correlationID string) error {
	val, exists := sm.orders.Load(orderID)
	if !exists {
		return fmt.Errorf("order %s not found", orderID)
	}

	runtime := val.(*OrderRuntime)
	runtime.mu.Lock()
	defer runtime.mu.Unlock()

	currentState := runtime.State

	if !isValidTransition(currentState, targetState) {
		return fmt.Errorf("invalid transition from %s to %s", currentState.String(), targetState.String())
	}

	if sm.IsDegraded() && (targetState == order.OrderStatus_PENDING || targetState == order.OrderStatus_SUBMITTED) {
		return errors.New("EMS_DEGRADED_READ_ONLY: transition blocked in degraded mode")
	}

	nextState := targetState
	if targetState == order.OrderStatus_PARTIALLY_FILLED || targetState == order.OrderStatus_FILLED {
		runtime.CumQty += deltaQty
		if runtime.CumQty > runtime.TotalQty {
			panic(fmt.Sprintf("FATAL: Over-fill on order %s (CumQty: %d, TotalQty: %d)", orderID, runtime.CumQty, runtime.TotalQty))
		}
		if runtime.CumQty == runtime.TotalQty {
			nextState = order.OrderStatus_FILLED
		}
	}

	if sm.wal != nil {
		ev := &OrderEvent{
			OrderID:       orderID,
			State:         nextState,
			DeltaQty:      deltaQty,
			Timestamp:     time.Now(),
			CorrelationID: correlationID,
		}
		if err := sm.wal.Append(ev); err != nil {
			sm.SetDegraded(true)
			if nextState == order.OrderStatus_PENDING || nextState == order.OrderStatus_SUBMITTED {
				return fmt.Errorf("WAL write failed: %w", err)
			}
		}
	}

	runtime.State = nextState
	runtime.CorrelationID = correlationID

	return nil
}

func (sm *StateMachine) RecoverFromWAL() error {
	if sm.wal == nil {
		return nil
	}

	events, err := sm.wal.Recover()
	if err != nil {
		return fmt.Errorf("failed to recover WAL logs: %w", err)
	}

	for _, ev := range events {
		val, loaded := sm.orders.Load(ev.OrderID)
		if !loaded {
			runtime := &OrderRuntime{
				OrderID:       ev.OrderID,
				Symbol:        ev.Symbol,
				Price:         ev.Price,
				TotalQty:      ev.TotalQty,
				CumQty:        0,
				State:         ev.State,
				CorrelationID: ev.CorrelationID,
			}
			sm.orders.Store(ev.OrderID, runtime)
		} else {
			runtime := val.(*OrderRuntime)
			runtime.mu.Lock()
			if ev.State == order.OrderStatus_PARTIALLY_FILLED || ev.State == order.OrderStatus_FILLED {
				runtime.CumQty += ev.DeltaQty
			}
			runtime.State = ev.State
			runtime.CorrelationID = ev.CorrelationID
			runtime.mu.Unlock()
		}
	}

	return nil
}

func (sm *StateMachine) GetOrder(orderID string) (*OrderRuntime, bool) {
	val, exists := sm.orders.Load(orderID)
	if !exists {
		return nil, false
	}
	return val.(*OrderRuntime), true
}

func isValidTransition(current, target order.OrderStatus) bool {
	switch current {
	case order.OrderStatus_PENDING:
		return target == order.OrderStatus_SUBMITTED || target == order.OrderStatus_REJECTED
	case order.OrderStatus_SUBMITTED:
		return target == order.OrderStatus_PARTIALLY_FILLED || target == order.OrderStatus_FILLED || target == order.OrderStatus_PENDING_CANCEL || target == order.OrderStatus_REJECTED
	case order.OrderStatus_PARTIALLY_FILLED:
		return target == order.OrderStatus_PARTIALLY_FILLED || target == order.OrderStatus_FILLED || target == order.OrderStatus_PENDING_CANCEL
	case order.OrderStatus_PENDING_CANCEL:
		return target == order.OrderStatus_CANCELED || target == order.OrderStatus_FILLED
	case order.OrderStatus_FILLED, order.OrderStatus_CANCELED, order.OrderStatus_REJECTED:
		return false
	}
	return false
}

func (or *OrderRuntime) GetState() order.OrderStatus {
	or.mu.Lock()
	defer or.mu.Unlock()
	return or.State
}

func (or *OrderRuntime) GetCumQty() int32 {
	or.mu.Lock()
	defer or.mu.Unlock()
	return or.CumQty
}

