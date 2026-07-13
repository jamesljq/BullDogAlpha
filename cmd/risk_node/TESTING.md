# Risk Node - Testing & Verification Specification

This document details the testing layout, verification cases, risk decision matrix, and recovery procedures for the Core Risk Node microservice (`cmd/risk_node`).

---

## 1. Risk Decision Matrix

| **Scenario ID** | **Trigger Event** | **Redis State Snapshot** | **Expected gRPC Payload** | **Circuit Breaker State** |
|------|------|------|------|------|
| `RISK_001` | Order value exceeds single order cap | `Max_Cap: 50000, Req: 60000` | `Status: REJECTED, Reason: REJECTED_EXCEEDS_MAX_CAP` | `CLOSED` (Normal) |
| `RISK_002` | Redis connection lost / partition | `Socket closed / No route` | `Status: REJECTED, Reason: RISK_NODE_FAIL_CLOSED` | `TRIPPED` (Fail-Closed) |
| `RISK_003` | Redis execution latency > 5ms | `Redis master high CPU` | `Status: REJECTED, Reason: RISK_NODE_FAIL_CLOSED` | `TRIPPED` (Fail-Closed) |
| `RISK_004` | Insufficient Available Margin | `Avail: 1000, Req: 2000` | `Status: REJECTED, Reason: REJECTED_INSUFFICIENT_MARGIN` | `CLOSED` (Normal) |
| `RISK_005` | Symbol is blacklisted | `SISMEMBER blacklist symbol == 1` | `Status: REJECTED, Reason: REJECTED_BLACKLISTED` | `CLOSED` (Normal) |

---

## 2. Lua Script Exception & Boundary Handlers

The atomic risk evaluation script (`cmd/risk_node/lua/risk_check.lua`) manages numeric parameters as standard floating-point representation while maintaining strict boundaries:
- **Empty / Nil Values**: If any expected numeric argument is nil, the script aborts immediately and returns `"REJECTED_INVALID_ARGUMENTS"`.
- **Negative / Zero Prices**: Caught by gRPC Protobuf Buf validation rules (`buf.validate.field`) prior to reaching the interceptor, but defensively rejected by the script if bypassed.
- **Atomic Rollback**: Re-allocation of margin only executes using `INCRBYFLOAT` after all validation checks (blacklist, max cap, available balance) succeed, ensuring no partial state corrupts the ledger.

---

## 3. Circuit Breaker & Recovery Runbook

### State Transitions

```
    +----------------------------------+
    |                                  |
    v                                  |
CLOSED ------[Failure / Timeout]-----> OPEN
  ^                                    |
  |                                    | (Cooldown Expiration)
  |                                    v
  +----------[Probe Success]------- HALF-OPEN
```

### Tripped (Fail-Closed) State Mitigation
When the Circuit Breaker trips to `OPEN`:
1. **Immediate Fail-Closed**: All incoming gRPC client orders are intercepted locally within the Risk Node, bypassed without hitting Redis, and rejected with status `REJECTED` and reason `RISK_NODE_FAIL_CLOSED: circuit breaker is open` in $\le 1\text{ms}$.
2. **Prometheus Alerting**: The metric `risk_circuit_breaker_tripped_total` increments, and `risk_circuit_breaker_state` changes to `1` (OPEN).

### Automatic Recovery Runbook
1. **Cooldown State**: The system remains in the `OPEN` state for `5 seconds` (cooldown duration).
2. **Probing (Half-Open)**: After the cooldown period expires, the next order request will transition the Circuit Breaker to `HALF-OPEN` and forward the request to Redis.
3. **Restoration**:
   - **If Redis is responsive**: The Lua script executes successfully. The Circuit Breaker transitions to `CLOSED`, resetting the consecutive failure counter.
   - **If Redis is still down**: The probe request fails or times out. The Circuit Breaker immediately transitions back to `OPEN`, starting a new `5 seconds` cooldown period.
