package interceptor

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"

	"bulldog_alpha/proto/order"
)

type CBState int32

const (
	StateClosed   CBState = 0
	StateOpen     CBState = 1
	StateHalfOpen CBState = 2
)

var (
	PromCBTripped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "risk_circuit_breaker_tripped_total",
		Help: "Total number of times the circuit breaker has tripped.",
	})
	PromCBState = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "risk_circuit_breaker_state",
		Help: "Current state of the circuit breaker (0=Closed, 1=Open, 2=HalfOpen).",
	})
	PromRiskChecks = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "risk_checks_total",
		Help: "Total number of risk checks evaluated.",
	}, []string{"symbol", "result"})
)

type CircuitBreaker struct {
	mu           sync.RWMutex
	state        CBState
	failures     int32
	cooldown     time.Duration
	lastStateChg time.Time
}

func NewCircuitBreaker(cooldown time.Duration) *CircuitBreaker {
	PromCBState.Set(float64(StateClosed))
	return &CircuitBreaker{
		state:        StateClosed,
		cooldown:     cooldown,
		lastStateChg: time.Now(),
	}
}

func (cb *CircuitBreaker) GetState() CBState {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.state
}

func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	if cb.state == StateHalfOpen {
		cb.state = StateClosed
		PromCBState.Set(float64(StateClosed))
	}
	cb.failures = 0
}

func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.failures++
	if cb.failures >= 3 && cb.state != StateOpen {
		cb.state = StateOpen
		cb.lastStateChg = time.Now()
		PromCBTripped.Inc()
		PromCBState.Set(float64(StateOpen))
	}
}

func (cb *CircuitBreaker) CanAttempt() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	if cb.state == StateClosed {
		return true
	}
	if cb.state == StateOpen {
		if time.Since(cb.lastStateChg) > cb.cooldown {
			cb.state = StateHalfOpen
			PromCBState.Set(float64(StateHalfOpen))
			return true
		}
		return false
	}
	return true
}

type CacheEntry struct {
	IsBlacklisted bool
	LastChecked   time.Time
}

type BlacklistCache struct {
	mu    sync.RWMutex
	items map[string]CacheEntry
	ttl   time.Duration
}

func NewBlacklistCache(ttl time.Duration) *BlacklistCache {
	return &BlacklistCache{
		items: make(map[string]CacheEntry),
		ttl:   ttl,
	}
}

func (bc *BlacklistCache) Get(symbol string) (bool, bool) {
	bc.mu.RLock()
	defer bc.mu.RUnlock()
	entry, exists := bc.items[symbol]
	if !exists {
		return false, false
	}
	if time.Since(entry.LastChecked) > bc.ttl {
		return false, false
	}
	return entry.IsBlacklisted, true
}

func (bc *BlacklistCache) Set(symbol string, isBlacklisted bool) {
	bc.mu.Lock()
	defer bc.mu.Unlock()
	bc.items[symbol] = CacheEntry{
		IsBlacklisted: isBlacklisted,
		LastChecked:   time.Now(),
	}
}

type RiskNode struct {
	RedisClient *redis.Client
	LuaSHA      string
	LuaScript   string
	CB          *CircuitBreaker
	Cache       *BlacklistCache
	MaxCap      float64
	Timeout     time.Duration
}

func NewRiskNode(rdb *redis.Client, luaScript string, maxCap float64) (*RiskNode, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	sha, err := rdb.ScriptLoad(ctx, luaScript).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to load lua script: %w", err)
	}

	rn := &RiskNode{
		RedisClient: rdb,
		LuaSHA:      sha,
		LuaScript:   luaScript,
		CB:          NewCircuitBreaker(5 * time.Second),
		Cache:       NewBlacklistCache(5 * time.Second),
		MaxCap:      maxCap,
		Timeout:     5 * time.Millisecond,
	}

	rn.SyncBlacklist()
	go rn.ListenBlacklistUpdates()

	return rn, nil
}

func (rn *RiskNode) SyncBlacklist() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	members, err := rn.RedisClient.SMembers(ctx, "blacklist").Result()
	if err != nil {
		return
	}
	for _, sym := range members {
		rn.Cache.Set(sym, true)
	}
}

func (rn *RiskNode) ListenBlacklistUpdates() {
	ctx := context.Background()
	pubsub := rn.RedisClient.Subscribe(ctx, "blacklist_updates")
	defer pubsub.Close()

	ch := pubsub.Channel()
	for msg := range ch {
		var op, symbol string
		parts := splitMsg(msg.Payload)
		if len(parts) == 2 {
			op, symbol = parts[0], parts[1]
		}
		
		if op == "ADD" {
			rn.Cache.Set(symbol, true)
		} else if op == "REMOVE" {
			rn.Cache.Set(symbol, false)
		}
	}
}

func splitMsg(s string) []string {
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			return []string{s[:i], s[i+1:]}
		}
	}
	return nil
}

func (rn *RiskNode) RiskInterceptor(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
	orderReq, ok := req.(*order.OrderRequest)
	if !ok {
		return handler(ctx, req)
	}

	if !rn.CB.CanAttempt() {
		PromRiskChecks.WithLabelValues(orderReq.Symbol, "REJECTED_FAIL_CLOSED").Inc()
		return &order.OrderResponse{
			OrderId:       orderReq.OrderId,
			Status:        order.OrderStatus_REJECTED,
			Reason:        "RISK_NODE_FAIL_CLOSED: circuit breaker is open",
			CorrelationId: orderReq.CorrelationId,
		}, nil
	}

	checkCtx, cancel := context.WithTimeout(ctx, rn.Timeout)
	defer cancel()

	isBlacklisted, hit := rn.Cache.Get(orderReq.Symbol)
	if !hit {
		var err error
		isBlacklisted, err = rn.queryRedisBlacklist(checkCtx, orderReq.Symbol)
		if err != nil {
			rn.CB.RecordFailure()
			PromRiskChecks.WithLabelValues(orderReq.Symbol, "REJECTED_FAIL_CLOSED").Inc()
			return &order.OrderResponse{
				OrderId:       orderReq.OrderId,
				Status:        order.OrderStatus_REJECTED,
				Reason:        "RISK_NODE_FAIL_CLOSED: " + err.Error(),
				CorrelationId: orderReq.CorrelationId,
			}, nil
		}
		rn.Cache.Set(orderReq.Symbol, isBlacklisted)
	}

	if isBlacklisted {
		rn.CB.RecordSuccess()
		PromRiskChecks.WithLabelValues(orderReq.Symbol, "REJECTED_BLACKLISTED").Inc()
		return &order.OrderResponse{
			OrderId:       orderReq.OrderId,
			Status:        order.OrderStatus_REJECTED,
			Reason:        "REJECTED_BLACKLISTED",
			CorrelationId: orderReq.CorrelationId,
		}, nil
	}

	orderVal := orderReq.Price * orderReq.Quantity
	keys := []string{"blacklist", "account:margin:available", "account:margin:inflight"}
	args := []interface{}{orderReq.Symbol, orderVal, rn.MaxCap}

	res, err := rn.RedisClient.EvalSha(checkCtx, rn.LuaSHA, keys, args...).Result()
	if err != nil && err.Error() == "NOSCRIPT No matching script. Please use EVAL." {
		res, err = rn.RedisClient.Eval(checkCtx, rn.LuaScript, keys, args...).Result()
	}
	if err != nil {
		rn.CB.RecordFailure()
		PromRiskChecks.WithLabelValues(orderReq.Symbol, "REJECTED_FAIL_CLOSED").Inc()
		return &order.OrderResponse{
			OrderId:       orderReq.OrderId,
			Status:        order.OrderStatus_REJECTED,
			Reason:        "RISK_NODE_FAIL_CLOSED: " + err.Error(),
			CorrelationId: orderReq.CorrelationId,
		}, nil
	}

	resStr, ok := res.(string)
	if !ok {
		rn.CB.RecordFailure()
		PromRiskChecks.WithLabelValues(orderReq.Symbol, "REJECTED_FAIL_CLOSED").Inc()
		return &order.OrderResponse{
			OrderId:       orderReq.OrderId,
			Status:        order.OrderStatus_REJECTED,
			Reason:        "RISK_NODE_FAIL_CLOSED: invalid lua response format",
			CorrelationId: orderReq.CorrelationId,
		}, nil
	}

	rn.CB.RecordSuccess()

	if resStr != "APPROVED" {
		PromRiskChecks.WithLabelValues(orderReq.Symbol, resStr).Inc()
		return &order.OrderResponse{
			OrderId:       orderReq.OrderId,
			Status:        order.OrderStatus_REJECTED,
			Reason:        resStr,
			CorrelationId: orderReq.CorrelationId,
		}, nil
	}

	resp, err := handler(ctx, req)
	if err == nil {
		PromRiskChecks.WithLabelValues(orderReq.Symbol, "APPROVED").Inc()
	}
	return resp, err
}

func (rn *RiskNode) queryRedisBlacklist(ctx context.Context, symbol string) (bool, error) {
	return rn.RedisClient.SIsMember(ctx, "blacklist", symbol).Result()
}

func (rn *RiskNode) ForceStale(symbol string) {
	rn.Cache.mu.Lock()
	defer rn.Cache.mu.Unlock()
	if entry, ok := rn.Cache.items[symbol]; ok {
		rn.Cache.items[symbol] = CacheEntry{
			IsBlacklisted: entry.IsBlacklisted,
			LastChecked:   time.Now().Add(-10 * time.Second),
		}
	}
}

