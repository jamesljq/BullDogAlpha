# Order Execution Management System (EMS) State Machine Specification & TESTING Guide

This document details the state transition matrix, idempotency rules, and disaster recovery behaviors of the Order Execution Management System (EMS) microservice.

---

## 1. State Transition Matrix Blueprint

The EMS enforces a strict state transition matrix to prevent logical inconsistencies (e.g. an order being canceled after it has been filled).

### 1.1 Transition Mapping Table

| From \ To | `PENDING` | `SUBMITTED` | `PARTIALLY_FILLED` | `PENDING_CANCEL` | `FILLED` | `CANCELED` | `REJECTED` |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **`PENDING`** | *Invalid* | **Valid** | *Invalid* | *Invalid* | *Invalid* | *Invalid* | **Valid** |
| **`SUBMITTED`** | *Invalid* | *Invalid* | **Valid** | **Valid** | **Valid** | *Invalid* | **Valid** |
| **`PARTIALLY_FILLED`**| *Invalid* | *Invalid* | **Valid** | **Valid** | **Valid** | *Invalid* | *Invalid* |
| **`PENDING_CANCEL`** | *Invalid* | *Invalid* | *Invalid* | *Invalid* | **Valid** (Late Fill)| **Valid** | *Invalid* |
| **`FILLED`** | *Invalid* | *Invalid* | *Invalid* | *Invalid* | *Invalid* | *Invalid* | *Invalid* |
| **`CANCELED`** | *Invalid* | *Invalid* | *Invalid* | *Invalid* | *Invalid* | *Invalid* | *Invalid* |
| **`REJECTED`** | *Invalid* | *Invalid* | *Invalid* | *Invalid* | *Invalid* | *Invalid* | *Invalid* |

*Note: `FILLED`, `CANCELED`, and `REJECTED` are terminal states. No further transitions are permitted from these states.*

---

## 2. Idempotency Resolution Guide

To prevent duplicate order creation or processing when the strategy client retries submissions due to network jitter, the EMS implements a memory-efficient idempotency registry:

1. **ClientOrderID Mapping Index**: The EMS maintains a thread-safe global registry mapping `ClientOrderID` (submitted as `req.OrderId` in `OrderRequest`) to the active order instance `*OrderRuntime` in memory.
2. **Atomic Verification Flow**:
   - When a new `SubmitOrder` request arrives, EMS performs a lock-free O(1) lookup on the `ClientOrderID` registry.
   - If the ID is already registered, EMS bypasses new order initialization and transaction logging.
   - It directly retrieves the current state of the existing order from memory under order lock, and returns the response with `Idempotent = true` and `Reason = "IDEMPOTENT_RETRY"`.
   - If the ID is not registered, the order runtime is atomially initialized, registered, and appended to the Write-Ahead Log.

---

## 3. Disaster Recovery & Degraded Mode Runbook

When the underlying storage layer becomes unavailable (e.g. disk space is exhausted, causing WAL append operations to fail), the EMS enters **Degraded Read-Only Mode** to safeguard capital.

### 3.1 Degraded State Machine Logic
- **Transition triggers**: Any write error returned by `WAL.Append(event)` instantly flips the `degraded` atomic flag to `1` (true).
- **Behavior in Degraded Mode**:
  - **New Order Rejections (Fail-Closed)**: Any incoming `SubmitOrder` request is immediately intercepted at the API level and rejected with `OrderStatus_REJECTED` and `Reason = "EMS_DEGRADED_READ_ONLY"`. No new risk exposure is accepted.
  - **In-flight Updates Execution**: Critical state updates for existing orders (such as `PARTIALLY_FILLED`, `FILLED`, and `CANCELED`) are allowed to bypass strict write-ahead blocking. The memory state is updated to align the engine's internal positions with actual exchange executions, preventing blind spots.

### 3.2 Recovery Runbook
1. **Identify the write failure**: Inspect the JSON logs for the field `"degraded_mode"` or `"wal_write_failed"`.
2. **Mitigate disk/storage issue**: Clear log backlogs or expand the persistent storage volume.
3. **Trigger Replay Reconstruction**:
   - Restart the EMS service container.
   - Upon startup, the EMS reads the Write-Ahead Log sequentially via `RecoverFromWAL()`.
   - It reconstructs the in-memory order cache `sync.Map` to its exact pre-crash state.
   - Once WAL replay succeeds without errors, the server resumes normal operations and accepts new order requests.
