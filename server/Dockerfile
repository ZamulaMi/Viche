# Viche · signaling server — multi-stage, без CGO, non-root
FROM golang:1.22-alpine AS build
WORKDIR /src

COPY go.mod ./
# go.sum додається після `go mod tidy`; для офлайн-збірки закомітьте vendor/
RUN go mod download || true

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/viche-server .

# --- runtime: мінімальний образ ---
FROM alpine:3.20
RUN adduser -D -u 10001 viche && apk add --no-cache ca-certificates
USER viche
WORKDIR /app
COPY --from=build /out/viche-server /app/viche-server

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/app/viche-server"]
