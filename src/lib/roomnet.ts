/* ─────────────────────────────────────────────────────────────
   Viche · мережеві приватні кімнати

   Кімната = PeerJS-ідентифікатор `viche-v1-r-{номер}-{код}`.
   - творець займає цей ID → він хост (тримає ростер);
   - інші за лінком/номером+кодом під'єднуються до хоста;
   - медіа — mesh: кожна пара учасників з'єднана напряму
     (P2P WebRTC, DTLS/SRTP), ініціатор пари — менший ID;
   - чат — DataConnection між усіма парами;
   - хост може кікати учасників;
   - зміна Wi-Fi ↔ мобільна мережа → ICE restart (див. net.ts).
   ───────────────────────────────────────────────────────────── */
import Peer from "peerjs";
import type { DataConnection, MediaConnection } from "peerjs";
import { attachNetRecovery, iceConfig, icePathInfo, restartIceOn } from "./net";
import { roomIdStr, type RoomId } from "./sim";

export type Member = { id: string; name: string };
export type RoomStatus =
  | "connecting"
  | "host"
  | "guest"
  | "not-found"
  | "exists"
  | "full"
  | "closed";

type RMsg =
  | { type: "join"; name: string }
  | { type: "roster"; members: Member[] }
  | { type: "chat"; from: string; name: string; text: string }
  | { type: "kick" }
  | { type: "poke" } // «ти мав мені подзвонити» — прискорює mesh
  | { type: "aux-gone"; id: string } // випадковий гість видалений
  | { type: "full" };

export type RoomHooks = {
  onStatus: (s: RoomStatus) => void;
  onRoster: (members: Member[]) => void;
  onPeerStream: (peerId: string, stream: MediaStream) => void;
  onPeerGone: (peerId: string) => void;
  onChat: (fromId: string, name: string, text: string) => void;
  onKicked: () => void;
  /** зведення ICE-шляхів mesh-з'єднань: "relay ×2 · lan" тощо */
  onIceInfo?: (info: string) => void;
  /** випадковий гість, чий потік ретранслює хост (бачать усі учасники) */
  onAuxStream?: (auxId: string, name: string, stream: MediaStream) => void;
  onAuxGone?: (auxId: string) => void;
};

const PREFIX = "viche-v1-r-";

export class RoomNet {
  readonly room: RoomId;
  readonly hostId: string;
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  private calls = new Map<string, MediaConnection>();
  private roster: Member[] = [];
  private disposed = false;
  private joinTimer = 0;
  private detachNet: (() => void) | null = null;

  constructor(
    room: RoomId,
    private name: string,
    private stream: MediaStream,
    private seats: number,
    private hooks: RoomHooks
  ) {
    this.room = room;
    this.hostId = PREFIX + roomIdStr(room);
    this.detachNet = attachNetRecovery(() => [...this.calls.values()]);
    this.tryHost();
  }

  get isHost() {
    return !!this.peer && this.peer.id === this.hostId;
  }
  get myId() {
    return this.peer?.id ?? "";
  }
  get members() {
    return this.roster;
  }

  /* ── спроба стати хостом; якщо ID зайнятий — приєднуємось гостем ── */
  private tryHost() {
    const p = new Peer(this.hostId, { debug: 0, config: iceConfig });
    p.on("open", () => {
      if (this.disposed) return p.destroy();
      this.peer = p;
      this.hooks.onStatus("host");
      p.on("connection", (conn) => {
        this.wireData(conn);
        conn.on("data", (raw) => {
          const m = raw as RMsg;
          if (m?.type === "join") this.onJoin(conn, m);
        });
      });
      p.on("call", (call) => this.acceptCall(call));
      this.roster = [{ id: this.hostId, name: this.name }];
      this.hooks.onRoster(this.roster);
    });
    p.on("error", (e) => {
      const t = (e as { type?: string }).type;
      p.destroy();
      if (this.disposed) return;
      if (t === "unavailable-id") {
        // хост уже є (або хтось зайняв номер) → гість / перестворення
        this.hooks.onStatus(this.roster.length ? "guest" : "exists");
        if (!this.roster.length) this.joinAsGuest();
      } else if (t === "network" || t === "socket-error" || t === "socket-closed" || t === "server-error") {
        this.hooks.onStatus("closed");
      }
    });
  }

  private onJoin(conn: DataConnection, m: Extract<RMsg, { type: "join" }>) {
    const id = conn.peer;
    if (this.roster.some((x) => x.id === id)) return;
    if (this.roster.length >= this.seats) {
      try {
        conn.send({ type: "full" } satisfies RMsg);
      } catch {
        /* noop */
      }
      window.setTimeout(() => {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      }, 400);
      return;
    }
    this.roster = [...this.roster, { id, name: String(m.name || "Гість").slice(0, 24) }];
    this.broadcastRoster();
    this.meshSync();
  }

  /* ── гість: підключення до хоста ── */
  private joinAsGuest() {
    if (this.disposed) return;
    const p = new Peer({ debug: 0, config: iceConfig });
    p.on("open", () => {
      if (this.disposed) return p.destroy();
      this.peer = p;
      this.hooks.onStatus("connecting");
      p.on("connection", (conn) => this.wireData(conn));
      p.on("call", (call) => this.acceptCall(call));
      p.on("error", (e) => {
        const t = (e as { type?: string }).type;
        if (t === "peer-unavailable" && this.roster.length === 0 && !this.disposed) {
          this.hooks.onStatus("not-found");
        }
      });
      const conn = p.connect(this.hostId, { reliable: true });
      this.wireData(conn);
      conn.on("open", () => {
        try {
          conn.send({ type: "join", name: this.name } satisfies RMsg);
        } catch {
          /* noop */
        }
      });
      window.clearTimeout(this.joinTimer);
      this.joinTimer = window.setTimeout(() => {
        if (this.roster.length === 0 && !this.disposed) this.hooks.onStatus("not-found");
      }, 9000);
    });
    p.on("error", (e) => {
      const t = (e as { type?: string }).type;
      if (this.disposed) return;
      if (t === "peer-unavailable" && this.roster.length === 0) this.hooks.onStatus("not-found");
      else if (t === "network" || t === "socket-error" || t === "socket-closed") this.hooks.onStatus("closed");
    });
  }

  /* ── data-канали: ростер, чат, кік ── */
  private wireData(conn: DataConnection) {
    const pid = conn.peer;
    this.conns.set(pid, conn);
    conn.on("data", (raw) => {
      const m = raw as RMsg;
      if (!m?.type) return;
      if (m.type === "roster") {
        window.clearTimeout(this.joinTimer);
        this.roster = m.members;
        this.hooks.onRoster(m.members);
        if (!this.isHost) this.hooks.onStatus("guest");
        this.meshSync();
      } else if (m.type === "chat") {
        this.hooks.onChat(m.from, m.name, m.text);
      } else if (m.type === "kick") {
        this.hooks.onKicked();
        this.leave();
      } else if (m.type === "full") {
        this.hooks.onStatus("full");
      }
    });
    conn.on("close", () => {
      if (this.conns.get(pid) === conn) this.conns.delete(pid);
      if (this.disposed) return;
      if (this.isHost && this.roster.some((x) => x.id === pid)) {
        this.roster = this.roster.filter((x) => x.id !== pid);
        this.broadcastRoster();
      }
      this.hooks.onPeerGone(pid);
      if (!this.isHost && pid === this.hostId) this.hooks.onStatus("closed");
    });
    conn.on("error", () => {
      /* noop */
    });
  }

  private broadcastRoster() {
    const msg = { type: "roster", members: this.roster } satisfies RMsg;
    this.conns.forEach((c) => {
      if (c.open) {
        try {
          c.send(msg);
        } catch {
          /* noop */
        }
      }
    });
    this.hooks.onRoster(this.roster);
  }

  /* ── mesh: ініціатор пари — менший ID (детерміновано, без дублів) ── */
  private meshSync() {
    const p = this.peer;
    if (!p || p.destroyed) return;
    for (const m of this.roster) {
      if (m.id === p.id || m.id < p.id) continue;
      if (!this.conns.has(m.id)) {
        this.wireData(p.connect(m.id, { reliable: true }));
      }
      if (!this.calls.has(m.id)) {
        const call = p.call(m.id, this.stream);
        if (call) this.wireCall(m.id, call);
      }
    }
  }

  private acceptCall(call: MediaConnection) {
    call.answer(this.stream);
    this.wireCall(call.peer, call);
  }

  private ice = new Map<string, string>();

  private emitIce() {
    if (!this.hooks.onIceInfo) return;
    const agg = new Map<string, number>();
    this.ice.forEach((v) => agg.set(v, (agg.get(v) ?? 0) + 1));
    const parts = [...agg.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
    this.hooks.onIceInfo(parts.join(" · "));
  }

  private wireCall(pid: string, call: MediaConnection) {
    this.calls.set(pid, call);
    this.ice.set(pid, "connecting");
    this.emitIce();
    call.on("stream", (s) => this.hooks.onPeerStream(pid, s));
    call.on("close", () => {
      clearWd();
      if (this.calls.get(pid) === call) {
        this.calls.delete(pid);
        this.ice.delete(pid);
        this.emitIce();
        if (!this.disposed) this.hooks.onPeerGone(pid);
      }
    });
    call.on("error", () => {
      /* noop */
    });
    /* watchdog: 15 c → restartIce, 30 c → скидаємо пару
       (глобальні учасники за суворим NAT без робочого TURN) */
    let restarted = false;
    let t15 = 0;
    let t30 = 0;
    const clearWd = () => {
      window.clearTimeout(t15);
      window.clearTimeout(t30);
    };
    const pc = call.peerConnection;
    if (pc) {
      try {
        pc.addEventListener("connectionstatechange", () => {
          if (this.calls.get(pid) !== call || this.disposed) return;
          const st = pc.connectionState;
          if (st === "connected") {
            clearWd();
            void icePathInfo(pc).then((tp) => {
              this.ice.set(pid, tp);
              this.emitIce();
            });
          } else {
            this.ice.set(pid, st === "connecting" ? "connecting" : st);
            this.emitIce();
          }
          if (st === "failed") {
            if (!restarted) {
              restarted = true;
              restartIceOn(call);
            } else {
              try {
                call.close();
              } catch {
                /* noop */
              }
            }
          }
        });
      } catch {
        /* noop */
      }
      t15 = window.setTimeout(() => {
        if (this.calls.get(pid) === call && pc.connectionState !== "connected") restartIceOn(call);
      }, 15000);
      t30 = window.setTimeout(() => {
        if (this.calls.get(pid) !== call || pc.connectionState === "connected") return;
        clearWd();
        try {
          call.close();
        } catch {
          /* noop */
        }
      }, 30000);
    }
  }

  /* ── публічне API ── */
  sendChat(text: string) {
    const msg = { type: "chat", from: this.myId, name: this.name, text } satisfies RMsg;
    this.conns.forEach((c) => {
      if (c.open) {
        try {
          c.send(msg);
        } catch {
          /* noop */
        }
      }
    });
  }

  kick(id: string) {
    if (!this.isHost) return;
    const c = this.conns.get(id);
    if (c?.open) {
      try {
        c.send({ type: "kick" } satisfies RMsg);
      } catch {
        /* noop */
      }
    }
    this.roster = this.roster.filter((m) => m.id !== id);
    this.broadcastRoster();
    window.setTimeout(() => {
      try {
        c?.close();
      } catch {
        /* noop */
      }
    }, 400);
  }

  leave() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.joinTimer);
    this.detachNet?.();
    this.calls.forEach((c) => {
      try {
        c.close();
      } catch {
        /* noop */
      }
    });
    this.conns.forEach((c) => {
      try {
        c.close();
      } catch {
        /* noop */
      }
    });
    try {
      this.peer?.destroy();
    } catch {
      /* noop */
    }
    this.peer = null;
  }
}
