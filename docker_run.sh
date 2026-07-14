#!/bin/bash
set -e

# Change directory to the script directory
cd "$(dirname "$0")"

# 1. Detect host architecture for Linux target platform
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    PLATFORM="linux_arm64"
else
    PLATFORM="linux_amd64"
fi

echo "SYSTEM: Detected host architecture: $ARCH. Target platform: $PLATFORM."

# 2. Build Linux binaries using Bazel
echo "SYSTEM: Building Go microservices with Bazel..."
bazel build --platforms="@rules_go//go/toolchain:$PLATFORM" //cmd/ems //cmd/risk_node //cmd/mdg //cmd/bff

# 3. Create local bin directory
mkdir -p bin

# 4. Copy cross-compiled Linux binaries
echo "SYSTEM: Staging binaries in bin/ folder..."
cp -f bazel-bin/cmd/ems/ems_/ems bin/ems
cp -f bazel-bin/cmd/risk_node/risk_node_/risk_node bin/risk_node
cp -f bazel-bin/cmd/mdg/mdg_/mdg bin/mdg
cp -f bazel-bin/cmd/bff/bff_/bff bin/bff

# 5. Start docker compose
echo "SYSTEM: Spinning up Docker Compose cluster..."
docker compose up --build
