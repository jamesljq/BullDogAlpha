package main

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"

	"bulldog_alpha/cmd/risk_node/interceptor"
	"bulldog_alpha/proto/order"
)

const LuaCheckScript = `
local is_blacklisted = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if is_blacklisted == 1 then
    return "REJECTED_BLACKLISTED"
end

local order_val = tonumber(ARGV[2])
local max_limit = tonumber(ARGV[3])
if not order_val or not max_limit then
    return "REJECTED_INVALID_ARGUMENTS"
end

if order_val > max_limit then
    return "REJECTED_EXCEEDS_MAX_CAP"
end

local avail_str = redis.call('GET', KEYS[2])
local avail = tonumber(avail_str or "0")

if avail < order_val then
    return "REJECTED_INSUFFICIENT_MARGIN"
end

redis.call('INCRBYFLOAT', KEYS[2], -order_val)
redis.call('INCRBYFLOAT', KEYS[3], order_val)

return "APPROVED"
`

func TestCircuitBreakerChaosAndRecovery(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to run miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{
		Addr: mr.Addr(),
	})
	defer rdb.Close()

	rn, err := interceptor.NewRiskNode(rdb, LuaCheckScript, 50000.0)
	if err != nil {
		t.Fatalf("failed to create RiskNode: %v", err)
	}
	rn.Timeout = 100 * time.Millisecond
	rn.CB = interceptor.NewCircuitBreaker(50 * time.Millisecond)

	rdb.Set(context.Background(), "account:margin:available", "10000.0", 0)
	rdb.Set(context.Background(), "account:margin:inflight", "0.0", 0)

	dummyHandler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return &order.OrderResponse{Status: order.OrderStatus_SUBMITTED}, nil
	}

	info := &grpc.UnaryServerInfo{}

	req := &order.OrderRequest{
		OrderId:       "order-1",
		Symbol:        "AAPL",
		Price:         100.0,
		Quantity:      10.0,
		CorrelationId: "corr-1",
	}

	resp, err := rn.RiskInterceptor(context.Background(), req, info, dummyHandler)
	if err != nil {
		t.Fatalf("unexpected interceptor error: %v", err)
	}
	orderResp := resp.(*order.OrderResponse)
	if orderResp.Status != order.OrderStatus_SUBMITTED {
		t.Errorf("expected SUBMITTED, got %v (reason: %s)", orderResp.Status, orderResp.Reason)
	}

	addr := mr.Addr()
	mr.Close()

	for i := 0; i < 3; i++ {
		resp, _ = rn.RiskInterceptor(context.Background(), req, info, dummyHandler)
		orderResp = resp.(*order.OrderResponse)
		if orderResp.Status != order.OrderStatus_REJECTED {
			t.Errorf("expected failure rejection, got %v", orderResp.Status)
		}
	}

	if rn.CB.GetState() != interceptor.StateOpen {
		t.Errorf("expected CB state to be OPEN, got %v", rn.CB.GetState())
	}

	start := time.Now()
	resp, _ = rn.RiskInterceptor(context.Background(), req, info, dummyHandler)
	elapsed := time.Since(start)
	if elapsed > 2*time.Millisecond {
		t.Errorf("OPEN state check took too long: %v", elapsed)
	}
	orderResp = resp.(*order.OrderResponse)
	if orderResp.Reason != "RISK_NODE_FAIL_CLOSED: circuit breaker is open" {
		t.Errorf("expected specific OPEN reason, got: %s", orderResp.Reason)
	}

	newMr := miniredis.NewMiniRedis()
	err = newMr.StartAddr(addr)
	if err != nil {
		t.Fatalf("failed to restart miniredis on same port: %v", err)
	}
	defer newMr.Close()

	newRdb := redis.NewClient(&redis.Options{Addr: newMr.Addr()})
	newRdb.Set(context.Background(), "account:margin:available", "10000.0", 0)
	newRdb.Set(context.Background(), "account:margin:inflight", "0.0", 0)
	newRdb.Close()

	time.Sleep(60 * time.Millisecond)

	resp, err = rn.RiskInterceptor(context.Background(), req, info, dummyHandler)
	if err != nil {
		t.Fatalf("unexpected error during recovery: %v", err)
	}
	orderResp = resp.(*order.OrderResponse)
	if orderResp.Status != order.OrderStatus_SUBMITTED {
		t.Errorf("expected probe to succeed and return SUBMITTED, got: %v (reason: %s)", orderResp.Status, orderResp.Reason)
	}

	if rn.CB.GetState() != interceptor.StateClosed {
		t.Errorf("expected CB to close, got %v", rn.CB.GetState())
	}
}

func TestMarginAllocationRace(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to run miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	rdb.Set(context.Background(), "account:margin:available", "10000.0", 0)
	rdb.Set(context.Background(), "account:margin:inflight", "0.0", 0)

	rn, err := interceptor.NewRiskNode(rdb, LuaCheckScript, 50000.0)
	if err != nil {
		t.Fatalf("failed to initialize RiskNode: %v", err)
	}
	rn.Timeout = 100 * time.Millisecond

	dummyHandler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return &order.OrderResponse{Status: order.OrderStatus_SUBMITTED}, nil
	}

	info := &grpc.UnaryServerInfo{}

	var wg sync.WaitGroup
	resultsChan := make(chan string, 20)

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			req := &order.OrderRequest{
				OrderId:       fmt.Sprintf("order-%d", id),
				Symbol:        "AAPL",
				Price:         10.0,
				Quantity:      60.0,
				CorrelationId: fmt.Sprintf("corr-%d", id),
			}
			resp, err := rn.RiskInterceptor(context.Background(), req, info, dummyHandler)
			if err != nil {
				resultsChan <- "ERROR"
				return
			}
			orderResp := resp.(*order.OrderResponse)
			if orderResp.Status == order.OrderStatus_SUBMITTED {
				resultsChan <- "APPROVED"
			} else {
				resultsChan <- orderResp.Reason
			}
		}(i)
	}

	wg.Wait()
	close(resultsChan)

	approvedCount := 0
	rejectedCount := 0

	for res := range resultsChan {
		if res == "APPROVED" {
			approvedCount++
		} else if res == "REJECTED_INSUFFICIENT_MARGIN" {
			rejectedCount++
		}
	}

	if approvedCount != 16 {
		t.Errorf("expected 16 approved, got %d", approvedCount)
	}
	if rejectedCount != 4 {
		t.Errorf("expected 4 rejected, got %d", rejectedCount)
	}

	avail, _ := rdb.Get(context.Background(), "account:margin:available").Float64()
	inflight, _ := rdb.Get(context.Background(), "account:margin:inflight").Float64()

	if avail != 400.0 {
		t.Errorf("expected available margin 400, got %f", avail)
	}
	if inflight != 9600.0 {
		t.Errorf("expected inflight margin 9600, got %f", inflight)
	}
}

func TestBlacklistCacheInvalidation(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to run miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	rdb.Set(context.Background(), "account:margin:available", "10000.0", 0)
	rdb.Set(context.Background(), "account:margin:inflight", "0.0", 0)

	rn, err := interceptor.NewRiskNode(rdb, LuaCheckScript, 50000.0)
	if err != nil {
		t.Fatalf("failed to initialize RiskNode: %v", err)
	}
	rn.Timeout = 100 * time.Millisecond

	dummyHandler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return &order.OrderResponse{Status: order.OrderStatus_SUBMITTED}, nil
	}
	info := &grpc.UnaryServerInfo{}

	req := &order.OrderRequest{
		OrderId:  "order-1",
		Symbol:   "AAPL",
		Price:    10.0,
		Quantity: 10.0,
	}
	resp, _ := rn.RiskInterceptor(context.Background(), req, info, dummyHandler)
	if resp.(*order.OrderResponse).Status != order.OrderStatus_SUBMITTED {
		t.Fatalf("expected AAPL approved, got %v", resp.(*order.OrderResponse).Status)
	}

	rdb.SAdd(context.Background(), "blacklist", "AAPL")
	rdb.Publish(context.Background(), "blacklist_updates", "ADD:AAPL")

	time.Sleep(15 * time.Millisecond)

	resp, _ = rn.RiskInterceptor(context.Background(), req, info, dummyHandler)
	if resp.(*order.OrderResponse).Reason != "REJECTED_BLACKLISTED" {
		t.Errorf("expected REJECTED_BLACKLISTED, got: %s", resp.(*order.OrderResponse).Reason)
	}

	rdb.SRem(context.Background(), "blacklist", "AAPL")
	rdb.Publish(context.Background(), "blacklist_updates", "REMOVE:AAPL")
	time.Sleep(15 * time.Millisecond)

	resp, _ = rn.RiskInterceptor(context.Background(), req, info, dummyHandler)
	if resp.(*order.OrderResponse).Status != order.OrderStatus_SUBMITTED {
		t.Errorf("expected AAPL to be clean again, got reason: %s", resp.(*order.OrderResponse).Reason)
	}

	reqTSLA := &order.OrderRequest{Symbol: "TSLA", Price: 10.0, Quantity: 10.0}
	resp, _ = rn.RiskInterceptor(context.Background(), reqTSLA, info, dummyHandler)
	if resp.(*order.OrderResponse).Status != order.OrderStatus_SUBMITTED {
		t.Fatalf("expected initial TSLA approved, got reason: %s", resp.(*order.OrderResponse).Reason)
	}

	rdb.SAdd(context.Background(), "blacklist", "TSLA")

	rn.Cache.Set("TSLA", false)
	rn.ForceStale("TSLA")

	resp, _ = rn.RiskInterceptor(context.Background(), reqTSLA, info, dummyHandler)
	if resp.(*order.OrderResponse).Reason != "REJECTED_BLACKLISTED" {
		t.Errorf("expected TTL read-through to catch TSLA blacklist, got: %s", resp.(*order.OrderResponse).Reason)
	}
}

func TestRiskInterceptorUncoveredBranches(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to run miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	rdb.SAdd(context.Background(), "blacklist", "MSFT")

	_, err = interceptor.NewRiskNode(rdb, "invalid lua code {", 50000.0)
	if err == nil {
		t.Errorf("expected error when loading invalid lua script")
	}

	rn, err := interceptor.NewRiskNode(rdb, LuaCheckScript, 50000.0)
	if err != nil {
		t.Fatalf("failed to create RiskNode: %v", err)
	}
	rn.Timeout = 100 * time.Millisecond

	dummyHandler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return &order.OrderResponse{Status: order.OrderStatus_SUBMITTED}, nil
	}
	info := &grpc.UnaryServerInfo{}
	cancelReq := &order.CancelOrderRequest{OrderId: "order-cancel"}
	resp, err := rn.RiskInterceptor(context.Background(), cancelReq, info, dummyHandler)
	if err != nil {
		t.Errorf("unexpected error on non-OrderRequest: %v", err)
	}
	if resp.(*order.OrderResponse).Status != order.OrderStatus_SUBMITTED {
		t.Errorf("expected non-OrderRequest to pass through")
	}

	rdb.Publish(context.Background(), "blacklist_updates", "INVALIDMESSAGE")
	time.Sleep(10 * time.Millisecond)

	mr.Close()
	reqTSLA := &order.OrderRequest{Symbol: "TSLA", Price: 10.0, Quantity: 10.0}
	resp, _ = rn.RiskInterceptor(context.Background(), reqTSLA, info, dummyHandler)
	if resp.(*order.OrderResponse).Status != order.OrderStatus_REJECTED {
		t.Errorf("expected rejection when Redis is down during read-through")
	}

	rn.CB = interceptor.NewCircuitBreaker(5 * time.Millisecond)
	rn.CB.RecordFailure()
	rn.CB.RecordFailure()
	rn.CB.RecordFailure()
	time.Sleep(10 * time.Millisecond)
	if !rn.CB.CanAttempt() {
		t.Errorf("expected CanAttempt to return true in HALF-OPEN state")
	}
	if !rn.CB.CanAttempt() {
		t.Errorf("expected CanAttempt to still return true in HALF-OPEN state")
	}
}

func TestRiskInterceptorInvalidLuaResponse(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("failed to run miniredis: %v", err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	rn, err := interceptor.NewRiskNode(rdb, "return 42", 50000.0)
	if err != nil {
		t.Fatalf("failed to create RiskNode: %v", err)
	}
	rn.Timeout = 100 * time.Millisecond

	dummyHandler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return &order.OrderResponse{Status: order.OrderStatus_SUBMITTED}, nil
	}
	info := &grpc.UnaryServerInfo{}
	req := &order.OrderRequest{Symbol: "AAPL", Price: 10.0, Quantity: 10.0}

	resp, _ := rn.RiskInterceptor(context.Background(), req, info, dummyHandler)
	orderResp := resp.(*order.OrderResponse)
	if orderResp.Reason != "RISK_NODE_FAIL_CLOSED: invalid lua response format" {
		t.Errorf("expected invalid lua response format error, got: %s", orderResp.Reason)
	}
}

