package main

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"bulldog_alpha/cmd/ems/state"
	"bulldog_alpha/proto/order"
)

type MockBrokenWAL struct{}

func (m *MockBrokenWAL) Append(event *state.OrderEvent) error {
	return errors.New("DISK_FULL")
}
func (m *MockBrokenWAL) Recover() ([]*state.OrderEvent, error) {
	return nil, nil
}
func (m *MockBrokenWAL) Close() error {
	return nil
}

func TestExecutionRace(t *testing.T) {
	sm := state.NewStateMachine(nil)

	req := &order.OrderRequest{
		OrderId:       "order-race",
		Symbol:        "AAPL",
		Price:         150.0,
		Quantity:      100.0,
		CorrelationId: "corr-race",
	}

	_, _, err := sm.SubmitOrder(context.Background(), req)
	if err != nil {
		t.Fatalf("failed to submit order: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_ = sm.TransitionState(context.Background(), "order-race", order.OrderStatus_PENDING_CANCEL, 0, "cancel-corr")
		_ = sm.TransitionState(context.Background(), "order-race", order.OrderStatus_CANCELED, 0, "cancel-corr")
	}()

	go func() {
		defer wg.Done()
		_ = sm.TransitionState(context.Background(), "order-race", order.OrderStatus_FILLED, 100, "fill-corr")
	}()

	wg.Wait()

	ord, exists := sm.GetOrder("order-race")
	if !exists {
		t.Fatalf("order not found after race")
	}

	stateVal := ord.GetState()
	cumQty := ord.GetCumQty()

	if stateVal != order.OrderStatus_FILLED && stateVal != order.OrderStatus_CANCELED {
		t.Errorf("expected final state FILLED or CANCELED, got %s", stateVal.String())
	}

	if stateVal == order.OrderStatus_FILLED && cumQty != 100 {
		t.Errorf("expected FILLED order to have CumQty 100, got %d", cumQty)
	}

	if stateVal == order.OrderStatus_CANCELED && cumQty != 0 {
		t.Errorf("expected CANCELED order to have CumQty 0, got %d", cumQty)
	}
}

func TestIncrementalFillAndOverFillPanic(t *testing.T) {
	sm := state.NewStateMachine(nil)

	req := &order.OrderRequest{
		OrderId:       "order-fill",
		Symbol:        "MSFT",
		Price:         300.0,
		Quantity:      1000.0,
		CorrelationId: "corr-fill",
	}

	ord, _, err := sm.SubmitOrder(context.Background(), req)
	if err != nil {
		t.Fatalf("failed to submit order: %v", err)
	}

	// 1. First fill (300)
	err = sm.TransitionState(context.Background(), "order-fill", order.OrderStatus_PARTIALLY_FILLED, 300, "fill-1")
	if err != nil {
		t.Fatalf("failed fill-1: %v", err)
	}
	if ord.GetState() != order.OrderStatus_PARTIALLY_FILLED || ord.GetCumQty() != 300 {
		t.Errorf("unexpected order state after fill-1: state=%s, cumQty=%d", ord.GetState(), ord.GetCumQty())
	}

	// 2. Second fill (500)
	err = sm.TransitionState(context.Background(), "order-fill", order.OrderStatus_PARTIALLY_FILLED, 500, "fill-2")
	if err != nil {
		t.Fatalf("failed fill-2: %v", err)
	}
	if ord.GetState() != order.OrderStatus_PARTIALLY_FILLED || ord.GetCumQty() != 800 {
		t.Errorf("unexpected order state after fill-2: state=%s, cumQty=%d", ord.GetState(), ord.GetCumQty())
	}

	// 3. Third fill (200) -> automatically escalates to FILLED
	err = sm.TransitionState(context.Background(), "order-fill", order.OrderStatus_PARTIALLY_FILLED, 200, "fill-3")
	if err != nil {
		t.Fatalf("failed fill-3: %v", err)
	}
	if ord.GetState() != order.OrderStatus_FILLED || ord.GetCumQty() != 1000 {
		t.Errorf("unexpected order state after fill-3: state=%s, cumQty=%d", ord.GetState(), ord.GetCumQty())
	}

	// 4. Over-fill assertion: deltaQty exceeding TotalQty from PARTIALLY_FILLED must panic
	req2 := &order.OrderRequest{
		OrderId:       "order-overfill",
		Symbol:        "MSFT",
		Price:         300.0,
		Quantity:      1000.0,
		CorrelationId: "corr-overfill",
	}
	_, _, err = sm.SubmitOrder(context.Background(), req2)
	if err != nil {
		t.Fatalf("failed to submit order-overfill: %v", err)
	}

	err = sm.TransitionState(context.Background(), "order-overfill", order.OrderStatus_PARTIALLY_FILLED, 800, "fill-4")
	if err != nil {
		t.Fatalf("failed fill-4: %v", err)
	}

	defer func() {
		if r := recover(); r == nil {
			t.Errorf("expected panic on over-fill, but program did not panic")
		}
	}()

	_ = sm.TransitionState(context.Background(), "order-overfill", order.OrderStatus_PARTIALLY_FILLED, 300, "fill-over")
}

func TestWALReplayIntegrity(t *testing.T) {
	tempFile := "test_ems_replay.wal"
	defer os.Remove(tempFile)

	wal, err := state.NewFileWAL(tempFile)
	if err != nil {
		t.Fatalf("failed to create WAL: %v", err)
	}

	sm1 := state.NewStateMachine(wal)

	req1 := &order.OrderRequest{OrderId: "order-1", Symbol: "AAPL", Price: 100.0, Quantity: 10}
	_, _, _ = sm1.SubmitOrder(context.Background(), req1)

	req2 := &order.OrderRequest{OrderId: "order-2", Symbol: "MSFT", Price: 200.0, Quantity: 1000}
	_, _, _ = sm1.SubmitOrder(context.Background(), req2)
	_ = sm1.TransitionState(context.Background(), "order-2", order.OrderStatus_PARTIALLY_FILLED, 400, "corr-2")

	req3 := &order.OrderRequest{OrderId: "order-3", Symbol: "TSLA", Price: 50.0, Quantity: 500}
	_, _, _ = sm1.SubmitOrder(context.Background(), req3)
	_ = sm1.TransitionState(context.Background(), "order-3", order.OrderStatus_FILLED, 500, "corr-3")

	req4 := &order.OrderRequest{OrderId: "order-4", Symbol: "GOOG", Price: 150.0, Quantity: 100}
	_, _, _ = sm1.SubmitOrder(context.Background(), req4)
	_ = sm1.TransitionState(context.Background(), "order-4", order.OrderStatus_PENDING_CANCEL, 0, "corr-4")
	_ = sm1.TransitionState(context.Background(), "order-4", order.OrderStatus_CANCELED, 0, "corr-4")

	wal.Close()

	wal2, err := state.NewFileWAL(tempFile)
	if err != nil {
		t.Fatalf("failed to re-open WAL: %v", err)
	}
	defer wal2.Close()

	sm2 := state.NewStateMachine(wal2)
	err = sm2.RecoverFromWAL()
	if err != nil {
		t.Fatalf("failed to recover from WAL: %v", err)
	}

	o1, exists := sm2.GetOrder("order-1")
	if !exists || o1.GetState() != order.OrderStatus_SUBMITTED || o1.GetCumQty() != 0 {
		t.Errorf("order-1 recovery failed")
	}

	o2, exists := sm2.GetOrder("order-2")
	if !exists || o2.GetState() != order.OrderStatus_PARTIALLY_FILLED || o2.GetCumQty() != 400 {
		t.Errorf("order-2 recovery failed")
	}

	o3, exists := sm2.GetOrder("order-3")
	if !exists || o3.GetState() != order.OrderStatus_FILLED || o3.GetCumQty() != 500 {
		t.Errorf("order-3 recovery failed")
	}

	o4, exists := sm2.GetOrder("order-4")
	if !exists || o4.GetState() != order.OrderStatus_CANCELED || o4.GetCumQty() != 0 {
		t.Errorf("order-4 recovery failed")
	}
}

func TestDegradedModeReadOnly(t *testing.T) {
	brokenWal := &MockBrokenWAL{}
	sm := state.NewStateMachine(brokenWal)

	req := &order.OrderRequest{
		OrderId:  "order-new",
		Symbol:   "AAPL",
		Price:    100.0,
		Quantity: 10,
	}

	_, _, err := sm.SubmitOrder(context.Background(), req)
	if err == nil {
		t.Fatalf("expected submit order to fail due to broken WAL")
	}

	if !sm.IsDegraded() {
		t.Errorf("expected state machine to transition to degraded mode")
	}

	_, _, err = sm.SubmitOrder(context.Background(), req)
	if err == nil || err.Error() != "EMS_DEGRADED_READ_ONLY: server in degraded mode due to storage failure" {
		t.Errorf("expected degraded read-only error, got: %v", err)
	}
}

type MockTriggeredWAL struct {
	mu           sync.Mutex
	allowedCount int
	writeCount   int
}

func (m *MockTriggeredWAL) Append(event *state.OrderEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writeCount++
	if m.writeCount <= m.allowedCount {
		return nil
	}
	return errors.New("DISK_FULL")
}
func (m *MockTriggeredWAL) Recover() ([]*state.OrderEvent, error) {
	return nil, nil
}
func (m *MockTriggeredWAL) Close() error {
	return nil
}

func TestDegradedExecutionReportSuccess(t *testing.T) {
	triggeredWal := &MockTriggeredWAL{allowedCount: 2}
	sm := state.NewStateMachine(triggeredWal)

	req := &order.OrderRequest{
		OrderId:       "order-degraded-fill",
		Symbol:        "AAPL",
		Price:         100.0,
		Quantity:      100,
		CorrelationId: "corr-1",
	}

	ord, _, err := sm.SubmitOrder(context.Background(), req)
	if err != nil {
		t.Fatalf("failed to submit order: %v", err)
	}

	err = sm.TransitionState(context.Background(), "order-degraded-fill", order.OrderStatus_FILLED, 100, "fill-corr")
	if err != nil {
		t.Errorf("unexpected error on execution report in degraded mode: %v", err)
	}

	if !sm.IsDegraded() {
		t.Errorf("expected state machine to become degraded")
	}

	if ord.GetState() != order.OrderStatus_FILLED || ord.GetCumQty() != 100 {
		t.Errorf("expected memory state updated to FILLED, got: state=%s, CumQty=%d", ord.GetState(), ord.GetCumQty())
	}
}

func TestIdempotencyAndStateErrors(t *testing.T) {
	sm := state.NewStateMachine(nil)

	req := &order.OrderRequest{
		OrderId:  "order-idem",
		Symbol:   "AAPL",
		Price:    100.0,
		Quantity: 100,
	}

	_, idempotent1, err := sm.SubmitOrder(context.Background(), req)
	if err != nil || idempotent1 {
		t.Fatalf("failed initial submit: %v", err)
	}

	// Submit again -> must be idempotent
	_, idempotent2, err := sm.SubmitOrder(context.Background(), req)
	if err != nil || !idempotent2 {
		t.Errorf("expected second submit to be idempotent")
	}

	// Try transition of non-existent order
	err = sm.TransitionState(context.Background(), "non-existent", order.OrderStatus_FILLED, 100, "corr")
	if err == nil {
		t.Errorf("expected error transitioning non-existent order")
	}

	// Try invalid transition direct to CANCELED
	err = sm.TransitionState(context.Background(), "order-idem", order.OrderStatus_CANCELED, 0, "corr")
	if err == nil {
		t.Errorf("expected error on invalid transition from SUBMITTED directly to CANCELED")
	}

	// Get non-existent order
	_, exists := sm.GetOrder("non-existent")
	if exists {
		t.Errorf("expected GetOrder on non-existent to return false")
	}
}

func TestEMSServerGRPC(t *testing.T) {
	sm := state.NewStateMachine(nil)
	server := &EMSServer{SM: sm}

	req := &order.OrderRequest{
		OrderId:  "grpc-order-1",
		Symbol:   "GOOG",
		Price:    150.0,
		Quantity: 100,
	}

	// 1. Submit
	resp, err := server.SubmitOrder(context.Background(), req)
	if err != nil || resp.Status != order.OrderStatus_SUBMITTED {
		t.Fatalf("SubmitOrder failed: %v, resp: %v", err, resp)
	}

	// 2. Idempotency retry
	respIdem, err := server.SubmitOrder(context.Background(), req)
	if err != nil || respIdem.Reason != "IDEMPOTENT_RETRY" {
		t.Errorf("idempotency retry failed: %v", respIdem)
	}

	// 3. CancelOrder
	cancelReq := &order.CancelOrderRequest{
		OrderId: "grpc-order-1",
	}
	respCancel, err := server.CancelOrder(context.Background(), cancelReq)
	if err != nil || respCancel.Status != order.OrderStatus_CANCELED {
		t.Errorf("CancelOrder failed: %v, resp: %v", err, respCancel)
	}

	// 4. CancelOrder on already terminal
	respCancel2, err := server.CancelOrder(context.Background(), cancelReq)
	if err != nil || respCancel2.Reason != "REJECTED_ALREADY_TERMINAL" {
		t.Errorf("cancel on terminal failed: %v", respCancel2)
	}

	// 5. CancelOrder on non-existent
	cancelNonExistent := &order.CancelOrderRequest{OrderId: "non-existent"}
	respCancel3, err := server.CancelOrder(context.Background(), cancelNonExistent)
	if err != nil || respCancel3.Reason != "ORDER_NOT_FOUND" {
		t.Errorf("cancel on non-existent order failed: %v", respCancel3)
	}

	// 6. SubmitOrder in degraded mode
	sm.SetDegraded(true)
	reqDegraded := &order.OrderRequest{
		OrderId:  "grpc-order-degraded",
		Symbol:   "GOOG",
		Price:    150.0,
		Quantity: 100,
	}
	respDegraded, err := server.SubmitOrder(context.Background(), reqDegraded)
	if err != nil || respDegraded.Status != order.OrderStatus_REJECTED {
		t.Errorf("submit on degraded failed: %v", respDegraded)
	}
}

func TestWALFileOpenError(t *testing.T) {
	// Try creating a FileWAL with an invalid/unwritable directory
	_, err := state.NewFileWAL("/nonexistent_dir_1234/test.wal")
	if err == nil {
		t.Errorf("expected error creating FileWAL in nonexistent directory")
	}
}

func TestWALRecoveryErrors(t *testing.T) {
	tempFile := "test_ems_err.wal"
	defer os.Remove(tempFile)

	err := os.WriteFile(tempFile, []byte("{invalid-json}\n\n"), 0666)
	if err != nil {
		t.Fatalf("failed to write test wal: %v", err)
	}

	wal, err := state.NewFileWAL(tempFile)
	if err != nil {
		t.Fatalf("failed to open: %v", err)
	}
	defer wal.Close()

	_, err = wal.Recover()
	if err == nil {
		t.Errorf("expected recover to fail on invalid JSON")
	}
}

func TestEMSServer_ForcePause(t *testing.T) {
	sm := state.NewStateMachine(nil)
	server := &EMSServer{SM: sm}

	resp, err := server.ForcePause(context.Background(), &order.ForcePauseRequest{Reason: "Manual testing pause", CorrelationId: "pause-corr-1"})
	if err != nil {
		t.Fatalf("ForcePause returned error: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected ForcePause to succeed")
	}
	if !sm.IsDegraded() {
		t.Errorf("expected StateMachine to be degraded after ForcePause")
	}
}

func TestRunEMS(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	walFile := "test_run_ems.wal"
	defer os.Remove(walFile)

	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()

	err := runEMS(ctx, "0", walFile)
	if err != nil {
		t.Fatalf("runEMS failed: %v", err)
	}
}

