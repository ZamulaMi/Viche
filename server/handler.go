package main

// handler.go — WS handshake + маршрутизація сигналів.
// Повідомлення: один JSON-конверт {type, payload}. Сервер stateless:
// знає лише про з'єднання, які підключені до ЦІЄЇ репліки; решта —
// через Redis Pub/Sub (matcher.go, room.go).

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// Envelope — єдиний формат повідомлень клієнт↔сервер.
type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// PeerConn — живе з'єднання користувача на цьому вузлі.
type PeerConn struct {
	ID      string
	NodeID  string
	IP      string
	Conn    *websocket.Conn
	Send    chan []byte
	roomID  string
	pairID  string
	filters *Filters
	mu      sync.Mutex // захищає pairID/roomID/filters
}

func (p *PeerConn) setPair(id string)   { p.mu.Lock(); p.pairID = id; p.mu.Unlock() }
func (p *PeerConn) setRoom(id string)   { p.mu.Lock(); p.roomID = id; p.mu.Unlock() }
func (p *PeerConn) getPair() string     { p.mu.Lock(); defer p.mu.Unlock(); return p.pairID }
func (p *PeerConn) getRoom() string     { p.mu.Lock(); defer p.mu.Unlock(); return p.roomID }

// Hub — реєстр локальних з'єднань + трансляція подій.
type Hub struct {
	NodeID  string
	rdb     *redis.Client
	mod     *Moderation
	matcher *Matcher
	rooms   *RoomRegistry

	mu    sync.RWMutex
	peers map[string]*PeerConn // peerID → conn (лише локальні)

	upgrader websocket.Upgrader
}

func NewHub(nodeID string, rdb *redis.Client, mod *Moderation) *Hub {
	matcher := NewMatcher(nodeID, rdb)
	h := &Hub{
		NodeID:  nodeID,
		rdb:     rdb,
		mod:     mod,
		matcher: matcher,
		rooms:   NewRoomRegistry(rdb, matcher),
		peers:   make(map[string]*PeerConn, 1024),
		upgrader: websocket.Upgrader{
			ReadBufferSize:   1024,
			WriteBufferSize:  4096,
			HandshakeTimeout: 5 * time.Second,
			CheckOrigin: func(r *http.Request) bool {
				// У продакшн: перелік дозволених origin з конфігу.
				return true
			},
		},
	}
	h.rooms.InjectHub(h)
	return h
}

// realIP — дістаємо клієнтську адресу з урахуванням проксі (для банів).
func realIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	if rip := r.Header.Get("X-Real-Ip"); rip != "" {
		return rip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// HandleWS — точка входу: капча → бан-чек → апгрейд → pumps.
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ip := realIP(r)

	// 1. Обов'язкова капча перед першим WS-з'єднанням (захист від ботів).
	token := r.URL.Query().Get("token")
	if !h.mod.VerifyCaptcha(ctx, token) {
		http.Error(w, "captcha required", http.StatusForbidden)
		return
	}

	// 2. Перевірка бану IP (Redis: ban:{ip}).
	if h.mod.IsBanned(ctx, ip) {
		http.Error(w, "banned", http.StatusForbidden)
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade %s: %v", ip, err)
		return
	}

	peer := &PeerConn{
		ID:     newID(12),
		NodeID: h.NodeID,
		IP:     ip,
		Conn:   conn,
		Send:   make(chan []byte, 64),
	}

	h.mu.Lock()
	h.peers[peer.ID] = peer
	h.mu.Unlock()

	go peer.writePump()
	peer.readPump(h) // блокується до закриття з'єднання
}

// readPump — читає повідомлення, застосовує rate limit, маршрутизує.
func (p *PeerConn) readPump(h *Hub) {
	defer func() {
		h.unregister(p)
		_ = p.Conn.Close()
	}()

	p.Conn.SetReadLimit(8192) // сигнальні повідомлення маленькі
	_ = p.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	p.Conn.SetPongHandler(func(string) error {
		return p.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	})

	for {
		_, raw, err := p.Conn.ReadMessage()
		if err != nil {
			return
		}
		_ = p.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		// Rate limit: 10 msg/сек на IP (Redis INCR + EXPIRE).
		if !h.mod.Allow(context.Background(), p.IP) {
			_ = p.writeJSON(Envelope{Type: "error", Payload: rawJSON(`{"code":"rate_limited"}`)})
			continue
		}

		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}
		h.route(context.Background(), p, &env)
	}
}

// writePump — єдиний goroutine, що пише у сокет + keepalive ping.
func (p *PeerConn) writePump() {
	ticker := time.NewTicker(25 * time.Second)
	defer func() {
		ticker.Stop()
		_ = p.Conn.Close()
	}()
	for {
		select {
		case msg, ok := <-p.Send:
			if !ok {
				_ = p.Conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			_ = p.Conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := p.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = p.Conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := p.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (p *PeerConn) writeJSON(v interface{}) []byte {
	b, _ := json.Marshal(v)
	select {
	case p.Send <- b:
	default: // повільний клієнт — скидаємо, не блокуємо hub
	}
	return b
}

// Deliver — безпечна доставка повідомлення локальному піру.
func (h *Hub) Deliver(peerID string, env Envelope) bool {
	h.mu.RLock()
	p, ok := h.peers[peerID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	p.writeJSON(env)
	return true
}

// unregister — чистимо черги/пари/кімнати при дисконекті.
func (h *Hub) unregister(p *PeerConn) {
	h.mu.Lock()
	delete(h.peers, p.ID)
	h.mu.Unlock()
	h.onDisconnect(context.Background(), p)
}

func (h *Hub) Close() {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, p := range h.peers {
		close(p.Send)
	}
}
