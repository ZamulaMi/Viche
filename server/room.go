package main

// room.go — приватні кімнати.
//
// Кімната живе на вузлі адміністратора; учасники з інших вузлів
// приєднуються через Redis (SADD room:{id}:peers), а медіа-сигнали
// розсилаються Pub/Sub-каналом viche:room:{id}.
//
// Гібридна фіча: room.add_random — бере першого-ліпшого з черги
// рулетки (Matcher.PopAny) і підключає його сюди. kick_replace —
// викидає гостя і одразу тягне нового.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"

	"github.com/redis/go-redis/v9"
)

type Room struct {
	ID    string
	Name  string
	Seats int
	Admin string // peerID творця

	mu    sync.RWMutex
	peers map[string]*PeerConn // локальні учасники
}

type RoomRegistry struct {
	rdb     *redis.Client
	matcher *Matcher

	hub   *Hub // для доступу до локальних з'єднань (інжектується у NewHub)
	hubMu sync.RWMutex

	mu    sync.RWMutex
	rooms map[string]*Room
}

// InjectHub — пов'язує реєстр кімнат із хабом з'єднань.
func (rr *RoomRegistry) InjectHub(h *Hub) {
	rr.hubMu.Lock()
	rr.hub = h
	rr.hubMu.Unlock()
}

func NewRoomRegistry(rdb *redis.Client, m *Matcher) *RoomRegistry {
	return &RoomRegistry{rdb: rdb, matcher: m, rooms: make(map[string]*Room, 256)}
}

func newRoomID() string {
	return "VCH-" + strings.ToUpper(newID(6))
}

// Handle — маршрутизація кімнатних команд (викликається з route()).
func (rr *RoomRegistry) Handle(ctx context.Context, p *PeerConn, env *Envelope) {
	switch env.Type {
	case "room.create":
		var req struct {
			Name  string `json:"name"`
			Seats int    `json:"seats"`
		}
		_ = json.Unmarshal(env.Payload, &req)
		if req.Seats < 2 || req.Seats > 8 {
			req.Seats = 4
		}
		room := &Room{
			ID: newRoomID(), Name: req.Name, Seats: req.Seats,
			Admin: p.ID, peers: map[string]*PeerConn{p.ID: p},
		}
		rr.mu.Lock()
		rr.rooms[room.ID] = room
		rr.mu.Unlock()
		rr.rdb.HSet(ctx, "room:"+room.ID, map[string]interface{}{
			"name": room.Name, "seats": room.Seats, "admin": p.ID,
		})
		rr.rdb.SAdd(ctx, "room:"+room.ID+":peers", p.ID)
		p.setRoom(room.ID)
		rr.matcher.Remove(p.ID) // адмін більше не в рулетці
		pl, _ := json.Marshal(map[string]string{"room_id": room.ID, "name": room.Name})
		p.writeJSON(Envelope{Type: "room.created", Payload: pl})
		log.Printf("room %s created by %s (%d seats)", room.ID, p.ID, room.Seats)

	case "room.join":
		var req struct{ ID string `json:"id"` }
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			return
		}
		rr.join(ctx, p, strings.ToUpper(req.ID))

	case "room.leave":
		rr.Leave(ctx, p)

	case "room.add_random":
		if room, ok := rr.local(p.getRoom()); ok && room.Admin == p.ID {
			rr.addRandom(ctx, room, p, false)
		}

	case "room.kick_replace":
		var req struct{ Target string `json:"target"` }
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			return
		}
		if room, ok := rr.local(p.getRoom()); ok && room.Admin == p.ID {
			rr.kick(ctx, room, req.Target)
			rr.addRandom(ctx, room, p, true) // заміна: одразу новий гість
		}
	}
}

// join — вхід у кімнату (локальну або на іншому вузлі).
func (rr *RoomRegistry) join(ctx context.Context, p *PeerConn, id string) {
	room, local := rr.local(id)
	exists, err := rr.rdb.Exists(ctx, "room:"+id).Result()
	if !local && (err != nil || exists == 0) {
		p.writeJSON(Envelope{Type: "error", Payload: rawJSON(`{"code":"room_not_found"}`)})
		return
	}
	if local {
		room.mu.RLock()
		full := len(room.peers) >= room.Seats
		room.mu.RUnlock()
		if full {
			p.writeJSON(Envelope{Type: "error", Payload: rawJSON(`{"code":"room_full"}`)})
			return
		}
		room.mu.Lock()
		room.peers[p.ID] = p
		room.mu.Unlock()
	}
	rr.rdb.SAdd(ctx, "room:"+id+":peers", p.ID)
	rr.matcher.Remove(p.ID)
	p.setRoom(id)

	pl, _ := json.Marshal(map[string]string{"peer_id": p.ID, "room_id": id})
	rr.Broadcast(ctx, id, Envelope{Type: "room.peer_joined", Payload: pl}, "")
}

// addRandom — гібридний режим: гість із загального пулу рулетки.
func (rr *RoomRegistry) addRandom(ctx context.Context, room *Room, admin *PeerConn, isReplace bool) {
	room.mu.RLock()
	full := len(room.peers) >= room.Seats
	room.mu.RUnlock()
	if full {
		admin.writeJSON(Envelope{Type: "error", Payload: rawJSON(`{"code":"room_full"}`)})
		return
	}
	w := rr.matcher.PopAny()
	if w == nil {
		admin.writeJSON(Envelope{Type: "room.queue_empty", Payload: rawJSON(`{}`)})
		return
	}
	// Гість може бути на іншому вузлі — кімнатний канал сам рознесе сигнали.
	rr.rdb.SAdd(ctx, "room:"+room.ID+":peers", w.PeerID)
	if local, ok := rr.hubPeer(w.PeerID); ok {
		local.setRoom(room.ID)
	}
	// Крос-вузловий гість дізнається про кімнату через Pub/Sub-команду.
	cmd, _ := json.Marshal(map[string]string{"room_id": room.ID, "peer_id": w.PeerID})
	rr.rdb.Publish(ctx, "viche:room:assign", cmd)

	evType := "room.random_joined"
	if isReplace {
		evType = "room.random_replaced"
	}
	pl, _ := json.Marshal(map[string]string{"peer_id": w.PeerID, "node": w.NodeID})
	rr.Broadcast(ctx, room.ID, Envelope{Type: evType, Payload: pl}, "")
	log.Printf("room %s: random guest %s attached (%s)", room.ID, w.PeerID, evType)
}

// kick — видалення учасника адміном.
func (rr *RoomRegistry) kick(ctx context.Context, room *Room, targetID string) {
	if targetID == room.Admin {
		return
	}
	room.mu.Lock()
	delete(room.peers, targetID)
	room.mu.Unlock()
	rr.rdb.SRem(ctx, "room:"+room.ID+":peers", targetID)
	if local, ok := rr.hubPeer(targetID); ok {
		local.setRoom("")
	}
	pl, _ := json.Marshal(map[string]string{"peer_id": targetID})
	rr.Broadcast(ctx, room.ID, Envelope{Type: "room.peer_left", Payload: pl}, "")
	// Самому вигнаному — окреме повідомлення (локально або через sig-канал).
	if local, ok := rr.hubPeer(targetID); ok {
		local.writeJSON(Envelope{Type: "room.kicked", Payload: rawJSON(`{}`)})
	}
}

// Leave — вихід (або дисконект) учасника.
func (rr *RoomRegistry) Leave(ctx context.Context, p *PeerConn) {
	id := p.getRoom()
	if id == "" {
		return
	}
	p.setRoom("")
	rr.rdb.SRem(ctx, "room:"+id+":peers", p.ID)
	if room, ok := rr.local(id); ok {
		room.mu.Lock()
		delete(room.peers, p.ID)
		left := len(room.peers)
		room.mu.Unlock()
		if left == 0 {
			rr.mu.Lock()
			delete(rr.rooms, id)
			rr.mu.Unlock()
			rr.rdb.Del(ctx, "room:"+id, "room:"+id+":peers")
			return
		}
	}
	pl, _ := json.Marshal(map[string]string{"peer_id": p.ID})
	rr.Broadcast(ctx, id, Envelope{Type: "room.peer_left", Payload: pl}, "")
}

// Broadcast — ефір у межах кімнати через Redis Pub/Sub (працює крос-вузлово).
func (rr *RoomRegistry) Broadcast(ctx context.Context, roomID string, env Envelope, except string) {
	msg, _ := json.Marshal(map[string]interface{}{"from": except, "env": env})
	rr.rdb.Publish(ctx, fmt.Sprintf("viche:room:%s", roomID), msg)
	// Локальна доставка одразу, не чекаючи Redis round-trip.
	if room, ok := rr.local(roomID); ok {
		room.mu.RLock()
		defer room.mu.RUnlock()
		for id, member := range room.peers {
			if id != except {
				member.writeJSON(env)
			}
		}
	}
}

// OnRoomEvent — прийшов ефір для кімнати (з іншого вузла).
func (rr *RoomRegistry) OnRoomEvent(ctx context.Context, channel, payload string) {
	roomID := strings.TrimPrefix(channel, "viche:room:")
	if roomID == "assign" {
		// Нам доручили підключити локального піра до кімнати на іншому вузлі.
		var a struct {
			RoomID string `json:"room_id"`
			PeerID string `json:"peer_id"`
		}
		if err := json.Unmarshal([]byte(payload), &a); err != nil {
			return
		}
		if local, ok := rr.hubPeer(a.PeerID); ok {
			local.setRoom(a.RoomID)
			pl, _ := json.Marshal(map[string]string{"room_id": a.RoomID})
			local.writeJSON(Envelope{Type: "room.random_attached", Payload: pl})
		}
		return
	}
	room, ok := rr.local(roomID)
	if !ok {
		return
	}
	var ev struct {
		From string   `json:"from"`
		Env  Envelope `json:"env"`
	}
	if err := json.Unmarshal([]byte(payload), &ev); err != nil {
		return
	}
	room.mu.RLock()
	defer room.mu.RUnlock()
	for id, member := range room.peers {
		if id != ev.From {
			member.writeJSON(ev.Env)
		}
	}
}

func (rr *RoomRegistry) local(id string) (*Room, bool) {
	rr.mu.RLock()
	defer rr.mu.RUnlock()
	r, ok := rr.rooms[id]
	return r, ok
}

// hubPeer — дістати локальне з'єднання піра.
// (hub зберігає peers; RoomRegistry звертається через глобальний хаб,
// який інжектується після створення — див. injectHub нижче.)
func (rr *RoomRegistry) hubPeer(id string) (*PeerConn, bool) {
	rr.hubMu.RLock()
	h := rr.hub
	rr.hubMu.RUnlock()
	if h == nil {
		return nil, false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	p, ok := h.peers[id]
	return p, ok
}
