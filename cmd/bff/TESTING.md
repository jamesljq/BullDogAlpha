# Go BFF Server & Console Dashboard Testing Documentation

This document describes the automated and manual testing strategies for the Go BFF (Backend-for-Frontend) gateway and the console dashboard.

## Automated Tests

We have a comprehensive test suite in `cmd/bff/main_test.go` covering the following scenarios:

1. **High-Frequency WebSocket Connection Leak Protection**:
   - Spawns a high volume of concurrent WebSocket connections and disconnects them.
   - Asserts that connections are cleaned up and no orphaned goroutines or channels are leaked.

2. **Cascade Degradation on Service Outage**:
   - Mocks microservices and simulates one of them failing.
   - Verifies that the state aggregator updates the system health to `DEGRADED` and broadcasts it to all active clients.
   - Verifies that placing new orders is blocked while degraded.

3. **High-Priority OOB (Out-Of-Band) Circuit Breaker Triggers**:
   - Simulates receiving OOB action payloads (`pause`, `panic`) from clients.
   - Asserts that the circuit breaker state is immediately updated in Redis and broadcasted to clients.
   - Verifies that the EMS (Execution Management System) Control Server's `ForcePause` gRPC RPC is invoked with the termination reason.

4. **Three-Stage Safe Resume Handshake**:
   - Simulates the transition from `PAUSED` back to `RUNNING`.
   - Tests the POST request to `/api/circuit`.
   - Asserts that the 3-stage validation logic executes successfully.

5. **Dynamic Config Redis Broadcasting**:
   - Publishes configuration updates (e.g. `max_position`, `max_leverage`) via POST to `/api/config`.
   - Asserts that updates are saved to Redis and published to the `config_updates` pub/sub channel.

### Running Tests and Coverage

To run all BFF server tests:
```bash
bazel test //cmd/bff/...
```

To run BFF server tests with coverage analysis:
```bash
bazel coverage //cmd/bff:bff_test --instrumentation_filter="^//cmd/bff[/:]"
```

## Hermetic Web UI Validation

We use a hermetic Bazel test target to check the React files inside the sandbox environment:
```bash
bazel test //web/...
```

## Manual Verification

1. Start Redis and the gRPC microservices:
   ```bash
   redis-server
   bazel run //cmd/ems
   bazel run //cmd/risk_node
   bazel run //cmd/mdg
   ```
2. Start the BFF server gateway:
   ```bash
   bazel run //cmd/bff -- --port=8080 --redis-addr=localhost:6379
   ```
3. Run the React console app locally:
   ```bash
   cd web
   npm install
   npm run start
   ```
4. Verify the dashboard opens on `http://localhost:3000` (or the default React dev server port) and displays real-time health data, and that clicking the "Panic Liquidate" button updates the system status instantly.
