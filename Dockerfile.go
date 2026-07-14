FROM alpine:latest

ARG SERVICE_NAME
ENV SERVICE_NAME_ENV=${SERVICE_NAME}

WORKDIR /app

# Copy the pre-built Linux binary (cross-compiled on host via Bazel)
COPY bin/${SERVICE_NAME} /app/service

# Expose ports for EMS (50052), RiskNode (50051), MDG (50053), BFF (8080)
EXPOSE 8080 50051 50052 50053

ENTRYPOINT ["/app/service"]
