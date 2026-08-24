package main

// matcher.go — черга пошуку пар («рулетка»).
//
// Локальна черга шардована за хешем (мова+теги) — без глобального м'ютекса.
// Крос-інстанс: кожен вузол публікує своїх "самотніх" у Redis-канал
// viche:match:queue; будь-який вузол може знайти пару і оголосити її
// через viche:match:found. Пари роз'їжджаються по вузлах — медіа все
// одно P2P, сервер лише знайомить.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"hash/fnv"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const shardCount = 16

// Filters — параметри підбору (приходять у match.join).
type Filters struct {
	Gender string   `json:"gender"` // бажана стать партнера: any|m|f
	Self   string   `json:"self"`   // стать користувача: m|f
	Lang   string   `json:"lang"`   // uk|en|de|pl|es
	Tags   []string `json:"tags"`   // теги інтересів
}

type waiting struct {
	PeerID string  `json:"peer_id"`
	NodeID string  `json:"node_id"`
	F      Filters `json:"filters"`
	At     int64   `json:"at"`
}

type shard struct {
	mu   sync.Mutex
	list []*waiting
}

type Matcher struct {
	nodeID string
	rdb    *redis.Client
	shards [shardCount]*shard
}

func NewMatcher(nodeID string, rdb *redis.Client) *Matcher {
	m := &Matcher{nodeID: nodeID, rdb: rdb}
	for i := range m.shards {
		m.shards[i] = &shard{}
	}
	return m
}

func newID(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)[:n]
}

func rawJSON(s string) json.RawMessage { return json.RawMessage(s) }

func (m *Matcher) shardFor(f Filters) *shard {
	h := fnv.New32a()
	tags := append([]string{}, f.Tags...)
	sort.Strings(tags)
	h.Write([]byte(f.Lang))
	for _, t := range tags {
		h.Write([]byte{0})
		h.Write([]byte(t))
	}
	return m.shards[int(h.Sum32())%shardCount]
}

// compatible — взаємний збіг: стать (обом), мова, перетин тегів.
func compatible(a, b Filters) bool {
	if a.Gender != "any" && a.Gender != b.Self {
		return false
	}
	if b.Gender != "any" && b.Gender != a.Self {
		return false
	}
	if a.Lang != b.Lang && a.Lang != "any" && b.Lang != "any" {
		return false
	}
	if len(a.Tags) == 0 || len(b.Tags) == 0 {
		return true
	}
	set := make(map[string]struct{}, len(a.Tags))
	for _, t := range a.Tags {
		set[t] = struct{}{}
	}
	for _, t := range b.Tags {
		if _, ok := set[t]; ok {
			return true
		}
	}
	return false
}

// tryTakeLocal — шукає сумісного локального кандидата й виймає його з черги.
func (m *Matcher) tryTakeLocal(w *waiting) *waiting {
	for _, s := range m.shards {
		s.mu.Lock()
		for i, c := range s.list {
			if c.PeerID != w.PeerID && compatible(w.F, c.F) {
				s.list = append(s.list[:i], s.list[i+1:]...)
				s.mu.Unlock()
				return c
			}
		}
		s.mu.Unlock()
	}
	return nil
}

// Enqueue — локальний пошук; без пари — публікуємо в Redis, інші вузли спробують.
func (m *Matcher) Enqueue(ctx context.Context, w *waiting) *waiting {
	if p := m.tryTakeLocal(w); p != nil {
		return p
	}
	m.shardFor(w.F).mu.Lock()
	m.shardFor(w.F).list = append(m.shardFor(w.F).list, w)
	m.shardFor(w.F).mu.Unlock()

	b, _ := json.Marshal(w)
	m.rdb.Publish(ctx, "viche:match:queue", b)
	return nil
}

// PopAny — дістати будь-кого з черги (для room.add_random).
func (m *Matcher) PopAny() *waiting {
	for _, s := range m.shards {
		s.mu.Lock()
		if len(s.list) > 0 {
			w := s.list[0]
			s.list = s.list[1:]
			s.mu.Unlock()
			return w
		}
		s.mu.Unlock()
	}
	return nil
}

// Remove — прибрати піра з черги (дисконект, match.next, вхід у кімнату).
func (m *Matcher) Remove(peerID string) {
	for _, s := range m.shards {
		s.mu.Lock()
		for i, c := range s.list {
			if c.PeerID == peerID {
				s.list = append(s.list[:i], s.list[i+1:]...)
				break
			}
		}
		s.mu.Unlock()
	}
}

type pairEvent struct {
	A waiting `json:"a"`
	B waiting `json:"b"`
}

// ── Маршрутизація повідомлень (викликається з readPump) ──

func (h *Hub) route(ctx context.Context, p *PeerConn, env *Envelope) {
	switch env.Type {
	case "hello":
		// peer-реєстр у Redis: знаємо IP/вузол для скарг і крос-вузлової доставки.
		h.rdb.Set(ctx, "peer:"+p.ID, p.IP+"|"+h.NodeID, 24*time.Hour)
		h.Deliver(p.ID, Envelope{Type: "hello.ack", Payload: rawJSON(`{"peer_id":"` + p.ID + `"}`)})

	case "match.join":
		var f Filters
		if err := json.Unmarshal(env.Payload, &f); err != nil {
			return
		}
		p.mu.Lock()
		p.filters = &f
		p.mu.Unlock()
		w := &waiting{PeerID: p.ID, NodeID: h.NodeID, F: f, At: time.Now().Unix()}
		if partner := h.matcher.Enqueue(ctx, w); partner != nil {
			h.announcePair(ctx, w, partner)
		}

	case "match.next":
		p.setPair("")
		h.matcher.Remove(p.ID)
		// Одразу шукаємо наступного — клієнт надсилає match.join окремо.

	case "rtc.offer", "rtc.answer", "rtc.ice", "chat.msg":
		h.relay(ctx, p, env)

	case "report.user":
		var rep struct {
			Target string `json:"target"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(env.Payload, &rep); err != nil {
			return
		}
		h.handleReport(ctx, p, rep.Target, rep.Reason)

	case "room.create", "room.join", "room.leave", "room.add_random", "room.kick_replace":
		h.rooms.Handle(ctx, p, env)
	}
}

// relay — доставка сигналів/чату партнеру по парі або всім у кімнаті.
func (h *Hub) relay(ctx context.Context, p *PeerConn, env *Envelope) {
	// Чат проходить серверний мат-фільтр.
	if env.Type == "chat.msg" {
		var c struct {
			Text string `json:"text"`
			To   string `json:"to"`
		}
		if err := json.Unmarshal(env.Payload, &c); err != nil {
			return
		}
		clean, dirty := h.mod.FilterText(c.Text)
		if dirty {
			log.Printf("profanity filtered from %s", p.ID)
		}
		payload, _ := json.Marshal(map[string]string{"text": clean, "from": p.ID})
		env = &Envelope{Type: "chat.msg", Payload: payload}
	}

	if roomID := p.getRoom(); roomID != "" {
		h.rooms.Broadcast(ctx, roomID, *env, p.ID)
		return
	}
	if pairID := p.getPair(); pairID != "" {
		h.pairDeliver(ctx, p, pairID, *env)
	}
}

// pairDeliver — доставка другому учаснику пари (локально або через Pub/Sub).
func (h *Hub) pairDeliver(ctx context.Context, from *PeerConn, partnerID string, env Envelope) {
	if h.Deliver(partnerID, env) {
		return
	}
	// Партнер на іншому вузлі — шукаємо його в peer-реєстрі та шлемо через канал.
	meta, err := h.rdb.Get(ctx, "peer:"+partnerID).Result()
	if err != nil {
		return
	}
	msg, _ := json.Marshal(map[string]interface{}{"to": partnerID, "env": env, "via": meta})
	h.rdb.Publish(ctx, "viche:sig", msg)
}

// announcePair — пара знайдена: фіксуємо pairID, сповіщаємо обох.
func (h *Hub) announcePair(ctx context.Context, a, b *waiting) {
	pid := "pair-" + newID(8)
	if local, ok := h.localPeer(a.PeerID); ok {
		local.setPair(pid)
	}
	if local, ok := h.localPeer(b.PeerID); ok {
		local.setPair(pid)
	}
	ev, _ := json.Marshal(pairEvent{A: *a, B: *b})
	h.rdb.Publish(ctx, "viche:match:found", ev)
	log.Printf("pair %s: %s(%s) ↔ %s(%s)", pid, a.PeerID, a.NodeID, b.PeerID, b.NodeID)
}

func (h *Hub) localPeer(id string) (*PeerConn, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	p, ok := h.peers[id]
	return p, ok
}

// handleReport — скарга: дістаємо IP цілі з реєстру, далі moderation.go.
func (h *Hub) handleReport(ctx context.Context, from *PeerConn, targetID, reason string) {
	meta, err := h.rdb.Get(ctx, "peer:"+targetID).Result()
	if err != nil {
		return
	}
	ip := meta
	for i := 0; i < len(meta); i++ {
		if meta[i] == '|' {
			ip = meta[:i]
			break
		}
	}
	banned := h.mod.Report(ctx, ip, from.IP, reason)
	if banned {
		log.Printf("IP %s auto-banned after reports", ip)
		h.rdb.Publish(ctx, "viche:ban", ip)
	}
}

// onDisconnect — прибираємо піра з усіх структур.
func (h *Hub) onDisconnect(ctx context.Context, p *PeerConn) {
	h.matcher.Remove(p.ID)
	h.rooms.Leave(ctx, p)
	h.rdb.Del(ctx, "peer:"+p.ID)
}

// ── Redis Pub/Sub: крос-інстансна синхронізація ──

func (h *Hub) RunPubSub(ctx context.Context) {
	sub := h.rdb.PSubscribe(ctx, "viche:match:queue", "viche:match:found", "viche:sig", "viche:ban", "viche:room:*")
	defer sub.Close()
	ch := sub.Channel()

	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			h.onPubSub(ctx, msg.Channel, msg.Payload)
		}
	}
}

func (h *Hub) onPubSub(ctx context.Context, channel, payload string) {
	switch {
	case channel == "viche:match:queue":
		// Хтось на іншому вузлі чекає — пробуємо скласти пару з нашими.
		var w waiting
		if err := json.Unmarshal([]byte(payload), &w); err != nil || w.NodeID == h.NodeID {
			return
		}
		if partner := h.matcher.tryTakeLocal(&w); partner != nil {
			h.announcePair(ctx, &w, partner)
		}

	case channel == "viche:match:found":
		var ev pairEvent
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			return
		}
		for _, side := range []waiting{ev.A, ev.B} {
			other := ev.B
			if side.PeerID == ev.B.PeerID {
				other = ev.A
			}
			if side.NodeID == h.NodeID {
				pl, _ := json.Marshal(map[string]string{"peer_id": other.PeerID})
				h.Deliver(side.PeerID, Envelope{Type: "match.found", Payload: pl})
			}
		}

	case channel == "viche:sig":
		var sig struct {
			To  string   `json:"to"`
			Env Envelope `json:"env"`
		}
		if err := json.Unmarshal([]byte(payload), &sig); err != nil {
			return
		}
		h.Deliver(sig.To, sig.Env)

	case channel == "viche:ban":
		// Роз'єднуємо всіх локальних пірів із забаненою IP.
		h.mu.RLock()
		var victims []*PeerConn
		for _, p := range h.peers {
			if p.IP == payload {
				victims = append(victims, p)
			}
		}
		h.mu.RUnlock()
		for _, p := range victims {
			p.writeJSON(Envelope{Type: "error", Payload: rawJSON(`{"code":"banned"}`)})
			close(p.Send)
		}

	default: // viche:room:{id} — ефір у межах кімнати
		h.rooms.OnRoomEvent(ctx, channel, payload)
	}
}
