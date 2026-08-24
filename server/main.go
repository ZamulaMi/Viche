// Viche · signaling server (Go, stateless)
//
// Архітектура:
//   - WS-хендлер (handler.go) — лише транзит сигналів, стану не зберігає.
//   - Matcher (matcher.go)   — черги пошуку пар, шардовані за хешем тегів;
//     між інстансами синхронізується через Redis Pub/Sub.
//   - Rooms (room.go)        — приватні кімнати + add_random + kick&replace.
//   - Moderation (moderation.go) — скарги → автобан IP (Redis TTL), мат-фільтр,
//     капча-токени, rate limiting.
//
// Медіа (WebRTC, DTLS/SRTP) йде напряму P2P — сервер його не бачить.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// Config — усі параметри беруться з оточення (12-factor).
type Config struct {
	Addr            string        // :8080
	DSN             string        // PostgreSQL
	RedisAddr       string        // redis:6379
	NodeID          string        // ідентифікатор репліки (для Pub/Sub)
	CaptchaSecret   string        // HMAC-секрет капча-токенів
	ReportThreshold int           // скарг за 24 год до бану
	BanTTL          time.Duration // тривалість автобану
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() Config {
	return Config{
		Addr:            envOr("VICHE_ADDR", ":8080"),
		DSN:             envOr("VICHE_DSN", "postgres://viche:viche@localhost:5432/viche?sslmode=disable"),
		RedisAddr:       envOr("VICHE_REDIS", "localhost:6379"),
		NodeID:          envOr("VICHE_NODE_ID", "node-1"),
		CaptchaSecret:   envOr("VICHE_CAPTCHA_SECRET", "change-me"),
		ReportThreshold: 3,
		BanTTL:          24 * time.Hour,
	}
}

func main() {
	cfg := loadConfig()
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("viche-server %s starting (pid %d)", cfg.NodeID, os.Getpid())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// ── PostgreSQL: користувачі, скарги, налаштування кімнат ──
	db, err := pgxpool.New(ctx, cfg.DSN)
	if err != nil {
		log.Fatalf("pgxpool: %v", err)
	}
	defer db.Close()
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	if err := db.Ping(pingCtx); err != nil {
		// Не вмираємо: сервер може стартувати раніше за БД у compose.
		log.Printf("warn: postgres not ready yet: %v", err)
	}
	cancel()

	// ── Redis: черги, Pub/Sub, rate limit, бани ──
	rdb := redis.NewClient(&redis.Options{
		Addr:         cfg.RedisAddr,
		PoolSize:     32,
		MinIdleConns: 4,
		DialTimeout:  3 * time.Second,
	})
	defer rdb.Close()

	mod := NewModeration(rdb, db, cfg.CaptchaSecret, cfg.ReportThreshold, cfg.BanTTL)
	hub := NewHub(cfg.NodeID, rdb, mod)

	// Pub/Sub: синхронізація матчера та кімнат між репліками.
	go hub.RunPubSub(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","node":"` + cfg.NodeID + `"}`))
	})
	mux.HandleFunc("GET /ws", hub.HandleWS)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("ws endpoint: ws://0.0.0.0%s/ws", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down…")

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancelShutdown()
	_ = srv.Shutdown(shutdownCtx)
	hub.Close()
	log.Println("bye")
}
