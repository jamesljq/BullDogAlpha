# Bulldog Alpha Console Dashboard

A sleek, modern dark-themed React dashboard control plane for managing Bulldog Alpha trading subsystems.

## Features

1. **Microservices Health Topology**: Real-time gRPC service statuses and ping latency.
2. **Global Circuit Breaker Command Cluster**: Active buttons to PAUSE TRADING or PANIC LIQUIDATE using OOB commands over WebSocket.
3. **Safe Resume Handshake Wizard**: Orchestrates the 3-stage validation process before restoring trading.
4. **Dynamic Configuration Limits**: Live sliders to modify Max Position and Max Leverage limits, hot-loaded via Redis.

## Running Locally

To start the console locally:
```bash
npm install
npm run start
```
To run component tests:
```bash
npm test
```
