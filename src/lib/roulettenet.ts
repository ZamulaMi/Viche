/* ─────────────────────────────────────────────────────────────
   Viche · децентралізований глобальний пошук (рулетка)

   Архітектура швидкого надійного глобального пошуку:
   • Кожен користувач миттєво отримує персональний ID на сигнальному
     сервері (viche-v3-u-XXX), готовий приймати виклики без черги.
   • Шукачі автоматично оголошують себе в спільні слоти-маяки (beacons)
     та паралельно опитують інші маяки рою.
   • Як тільки 2 шукачі знаходять один одного — обмінюються рукостисканням
     knock/accept, звільняють маяки та встановлюють пряме DTLS/SRTP
     WebRTC-з'єднання і канал зв'язку.
   • Детермінований ініціатор (за лексикографічним порівнянням ID)
     із таймером взаємної страховки виключає стан гонитви чи зависання.
   ───────────────────────────────────────────────────────────── */
import Peer from "peerjs";
import type { DataConnection, MediaConnection } from "peerjs";
import { attachNetRecovery, defaultPeerOptions, iceConfig, icePathInfo, restartIceOn } from "./net";
import type { Gender, LangCode } from "./sim";

export type RouletteFilters = {
  gender: Gender;
  lang: LangCode | "any";
  tags: string[];
};

export type RState = "idle" | "searching" | "connecting" | "paired";

export type RouletteHooks = {
  onState: (s: RState) => void;
  /** номер активного слота/маяка */
  onSlot: (slot: number) => void;
  onPair: (stream: MediaStream, peerId: string) => void;
  onPeerLeft: () => void;
  onIce?: (info: string) => void;
};

type Wire =
  | { t: "knock"; from: string; f: RouletteFilters; u: string }
  | { t: "accept"; from: string; u: string }
  | { t: "busy" }
  | { t: "chello"; from: string }
  | { t: "chat"; text: string }
  | { t: "bye" };

const BEACON_PREFIX = "viche-v3-s-";
const N_SLOTS = 16;
const PROBE_INTERVAL = 800; // регулярне зондування слотів
const KNOCK_TIMEOUT = 3500; // достатній таймаут для глобальних / мобільних мереж

function browserUid(): string {
  try {
    let id = localStorage.getItem("viche:uid");
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem("viche:uid", id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function randHex(n = 6): string {
  const chars = "0123456789abcdef";
  let res = "";
  for (let i = 0; i < n; i++) {
    res += chars[Math.floor(Math.random() * chars.length)];
  }
  return res;
}

function compatible(a: RouletteFilters, b: RouletteFilters): boolean {
  if (a.gender !== "any" && b.gender !== "any" && a.gender !== b.gender) return false;
  if (a.lang !== "any" && b.lang !== "any" && a.lang !== b.lang) return false;
  if (a.tags.length > 0 && b.tags.length > 0 && !a.tags.some((x) => b.tags.includes(x))) return false;
  return true;
}

export class RouletteNet {
  private myPeer: Peer | null = null;
  private myPeerId = "";
  private beaconPeer: Peer | null = null;
  private mySlot = -1;
  private uid = browserUid();
  private myFilters: RouletteFilters = { gender: "any", lang: "any", tags: [] };

  private partnerId: string | null = null;
  private chatConn: DataConnection | null = null;
  private call: MediaConnection | null = null;
  private paired = false;
  private connected = false;

  private searching = false;
  private disposed = false;
  private probeTimer = 0;
  private probeIndex = 0;
  private beaconAcquiring = false;
  private connectWatchdog = 0;
  private fallbackInitiatorTimer = 0;
  private detachNet: (() => void) | null = null;
  private chatListeners = new Set<(t: string) => void>();

  private chatApi = {
    send: (text: string) => {
      if (this.chatConn && this.chatConn.open) {
        try {
          this.chatConn.send({ t: "chat", text } satisfies Wire);
        } catch {
          /* noop */
        }
      }
    },
    subscribe: (fn: (t: string) => void) => {
      this.chatListeners.add(fn);
      return () => {
        this.chatListeners.delete(fn);
      };
    },
  };

  constructor(private stream: MediaStream, private hooks: RouletteHooks) {
    this.detachNet = attachNetRecovery(() => [this.call]);
  }

  get chat() {
    return this.chatApi;
  }

  updateStream(newStream: MediaStream, newVideoTrack?: MediaStreamTrack) {
    this.stream = newStream;
    const videoTrack = newVideoTrack || newStream.getVideoTracks()[0];
    const audioTrack = newStream.getAudioTracks()[0];

    if (this.call) {
      try {
        (this.call as unknown as { localStream?: MediaStream }).localStream = newStream;
      } catch {
        /* noop */
      }

      if (this.call.peerConnection) {
        try {
          const senders = this.call.peerConnection.getSenders();
          senders.forEach((sender) => {
            if (sender.track?.kind === "video" || (!sender.track && videoTrack)) {
              if (videoTrack) {
                void sender.replaceTrack(videoTrack).catch(() => {});
              }
            } else if (sender.track?.kind === "audio") {
              if (audioTrack) {
                void sender.replaceTrack(audioTrack).catch(() => {});
              }
            }
          });
        } catch {
          /* noop */
        }
      }
    }
  }

  /* ── Публічне API пошуку ── */
  search(f: RouletteFilters) {
    if (this.disposed) return;
    this.teardownPair();
    this.myFilters = f;
    this.searching = true;
    this.hooks.onState("searching");
    this.initMyPeer();
  }

  next() {
    if (this.disposed) return;
    this.teardownPair();
    this.searching = true;
    this.hooks.onState("searching");
    this.startSearchSwarm();
  }

  stop() {
    this.searching = false;
    this.teardownPair();
    this.releaseBeacon();
    this.destroyMyPeer();
    this.hooks.onState("idle");
    this.hooks.onIce?.("");
    this.hooks.onSlot(-1);
  }

  dispose() {
    this.disposed = true;
    this.searching = false;
    this.stopProbing();
    this.teardownPair();
    this.releaseBeacon();
    this.destroyMyPeer();
    this.detachNet?.();
    this.detachNet = null;
    this.chatListeners.clear();
  }

  /* ── Ініціалізація основного вузла клієнта ── */
  private initMyPeer() {
    if (this.myPeer && !this.myPeer.destroyed && !this.myPeer.disconnected) {
      this.startSearchSwarm();
      return;
    }
    this.destroyMyPeer();

    const newId = `viche-v3-u-${this.uid.slice(0, 6)}-${randHex(6)}`;
    this.myPeerId = newId;
    const p = new Peer(newId, { ...defaultPeerOptions });
    this.myPeer = p;

    p.on("open", (id) => {
      if (this.disposed || !this.searching) {
        try {
          p.destroy();
        } catch {
          /* noop */
        }
        return;
      }
      this.myPeerId = id;
      this.startSearchSwarm();
    });

    p.on("connection", (conn) => {
      this.onIncomingPeerConnection(conn);
    });

    p.on("call", (call) => {
      this.onIncomingPeerCall(call);
    });

    p.on("error", (e) => {
      const err = e as { type?: string };
      if (this.disposed) return;
      if (err.type === "peer-unavailable") {
        // Звичайна ситуація при опитуванні відсутнього маяка — ігноруємо
        return;
      }
      if (this.isFatal(err.type)) {
        this.destroyMyPeer();
        if (this.searching && !this.paired) {
          window.setTimeout(() => {
            if (this.searching && !this.disposed) this.initMyPeer();
          }, 1200);
        }
      }
    });

    p.on("disconnected", () => {
      if (!this.disposed && this.searching && p === this.myPeer) {
        try {
          p.reconnect();
        } catch {
          /* noop */
        }
      }
    });
  }

  private startSearchSwarm() {
    if (this.disposed || !this.searching || this.paired) return;
    this.acquireBeaconSlot();
    this.startProbing();
  }

  /* ── Управління маяком (Beacon Slot) ── */
  private acquireBeaconSlot() {
    if (this.beaconPeer || this.beaconAcquiring || this.disposed || !this.searching || this.paired) {
      return;
    }
    this.beaconAcquiring = true;

    const startSlot = Math.floor(Math.random() * N_SLOTS);
    let current = startSlot;
    let attempts = 0;

    const tryNextBeacon = () => {
      if (this.disposed || !this.searching || this.paired || this.beaconPeer) {
        this.beaconAcquiring = false;
        return;
      }
      if (attempts >= N_SLOTS) {
        this.beaconAcquiring = false;
        // повторимо спробу зайняти маяк через невеликий інтервал
        window.setTimeout(() => {
          if (this.searching && !this.paired && !this.beaconPeer) {
            this.acquireBeaconSlot();
          }
        }, 3000);
        return;
      }

      attempts++;
      const slotNum = current % N_SLOTS;
      current++;
      const slotId = this.slotId(slotNum);

      const bp = new Peer(slotId, { ...defaultPeerOptions });
      let settled = false;

      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          bp.destroy();
        } catch {
          /* noop */
        }
        tryNextBeacon();
      }, 4000);

      bp.on("open", () => {
        if (settled) {
          try {
            bp.destroy();
          } catch {
            /* noop */
          }
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        this.beaconAcquiring = false;

        if (this.disposed || !this.searching || this.paired) {
          try {
            bp.destroy();
          } catch {
            /* noop */
          }
          return;
        }

        this.beaconPeer = bp;
        this.mySlot = slotNum;
        this.hooks.onSlot(slotNum);

        bp.on("connection", (conn) => {
          this.handleBeaconIncoming(conn);
        });

        bp.on("error", (e) => {
          const err = e as { type?: string };
          if (err.type === "peer-unavailable") return;
          this.releaseBeacon();
          if (this.searching && !this.paired) {
            window.setTimeout(() => this.acquireBeaconSlot(), 2000);
          }
        });
      });

      bp.on("error", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        try {
          bp.destroy();
        } catch {
          /* noop */
        }
        tryNextBeacon();
      });
    };

    tryNextBeacon();
  }

  private handleBeaconIncoming(conn: DataConnection) {
    conn.on("data", (raw) => {
      const msg = raw as Wire;
      if (!msg || msg.t !== "knock") return;

      // Свій же браузер або вже спарений або не підходять фільтри
      if (
        this.disposed ||
        !this.searching ||
        this.paired ||
        msg.u === this.uid ||
        !compatible(this.myFilters, msg.f)
      ) {
        try {
          conn.send({ t: "busy" } satisfies Wire);
        } catch {
          /* noop */
        }
        window.setTimeout(() => {
          try {
            conn.close();
          } catch {
            /* noop */
          }
        }, 200);
        return;
      }

      const partnerDirectId = msg.from;
      if (!partnerDirectId) return;

      // Приймаємо парування
      try {
        conn.send({
          t: "accept",
          from: this.myPeerId,
          u: this.uid,
        } satisfies Wire);
      } catch {
        /* noop */
      }

      window.setTimeout(() => {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      }, 300);

      this.startPairing(partnerDirectId);
    });
  }

  private releaseBeacon() {
    this.beaconAcquiring = false;
    if (this.beaconPeer) {
      try {
        this.beaconPeer.destroy();
      } catch {
        /* noop */
      }
      this.beaconPeer = null;
    }
    this.mySlot = -1;
  }

  /* ── Паралельне зондування маяків ── */
  private startProbing() {
    this.stopProbing();
    this.probeIndex = Math.floor(Math.random() * N_SLOTS);
    this.probeTimer = window.setInterval(() => {
      this.probeStep();
    }, PROBE_INTERVAL);
    this.probeStep();
  }

  private stopProbing() {
    if (this.probeTimer) {
      window.clearInterval(this.probeTimer);
      this.probeTimer = 0;
    }
  }

  private probeStep() {
    if (this.disposed || !this.searching || this.paired || !this.myPeer || this.myPeer.destroyed) {
      return;
    }

    // Виконуємо 2 зондування за цикл для прискореного пошуку
    for (let k = 0; k < 2; k++) {
      const idx = (this.probeIndex + k) % N_SLOTS;
      if (idx !== this.mySlot) {
        this.probeSlot(idx);
      }
    }
    this.probeIndex = (this.probeIndex + 2) % N_SLOTS;
  }

  private probeSlot(slotIdx: number) {
    if (this.disposed || !this.searching || this.paired || !this.myPeer) return;
    const targetId = this.slotId(slotIdx);

    const conn = this.myPeer.connect(targetId, { reliable: true });
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(to);
      try {
        conn.close();
      } catch {
        /* noop */
      }
    };

    const to = window.setTimeout(cleanup, KNOCK_TIMEOUT);

    conn.on("open", () => {
      if (settled || this.paired || !this.searching) {
        cleanup();
        return;
      }
      try {
        conn.send({
          t: "knock",
          from: this.myPeerId,
          u: this.uid,
          f: this.myFilters,
        } satisfies Wire);
      } catch {
        cleanup();
      }
    });

    conn.on("data", (raw) => {
      const msg = raw as Wire;
      if (settled) return;
      if (msg?.t === "accept") {
        if (this.paired || !this.searching || msg.u === this.uid) {
          cleanup();
          return;
        }
        const partnerDirectId = msg.from;
        if (partnerDirectId) {
          this.startPairing(partnerDirectId);
        }
        cleanup();
      } else if (msg?.t === "busy") {
        cleanup();
      }
    });

    conn.on("error", cleanup);
    conn.on("close", cleanup);
  }

  /* ── Парування та встановлення WebRTC медіа і чату ── */
  private startPairing(partnerDirectId: string) {
    if (this.paired || this.disposed || !this.searching) return;
    this.paired = true;
    this.connected = false;
    this.partnerId = partnerDirectId;

    this.stopProbing();
    this.releaseBeacon();
    this.hooks.onState("connecting");

    // Watchdog на випадок, якщо партнер раптово зник
    window.clearTimeout(this.connectWatchdog);
    this.connectWatchdog = window.setTimeout(() => {
      if (this.paired && !this.connected && !this.disposed) {
        this.partnerLeft();
      }
    }, 9000);

    const isInitiator = this.cmp(this.myPeerId, partnerDirectId) < 0;

    if (isInitiator) {
      // Ініціатор створює чат і викликає медіа
      this.initiateCallAndChat(partnerDirectId);
    } else {
      // Відповідач очікує вхідного виклику, а при затримці >3.5с ініціює страхувальний виклик
      window.clearTimeout(this.fallbackInitiatorTimer);
      this.fallbackInitiatorTimer = window.setTimeout(() => {
        if (this.paired && !this.connected && !this.call && !this.disposed) {
          this.initiateCallAndChat(partnerDirectId);
        }
      }, 3500);
    }
  }

  private initiateCallAndChat(partnerDirectId: string) {
    if (!this.myPeer || this.disposed || !this.paired) return;

    if (!this.chatConn) {
      const c = this.myPeer.connect(partnerDirectId, { reliable: true });
      this.chatConn = c;
      c.on("open", () => {
        try {
          c.send({ t: "chello", from: this.myPeerId } satisfies Wire);
        } catch {
          /* noop */
        }
      });
      this.wireChat(c);
    }

    if (!this.call) {
      const call = this.myPeer.call(partnerDirectId, this.stream);
      this.wireCall(call);
    }
  }

  private onIncomingPeerConnection(conn: DataConnection) {
    if (!this.paired || conn.peer !== this.partnerId) {
      // Не від нашого поточного партнера
      return;
    }
    if (!this.chatConn) {
      this.chatConn = conn;
      this.wireChat(conn);
    }
  }

  private onIncomingPeerCall(call: MediaConnection) {
    if (!this.paired || call.peer !== this.partnerId) {
      try {
        call.close();
      } catch {
        /* noop */
      }
      return;
    }
    window.clearTimeout(this.fallbackInitiatorTimer);
    call.answer(this.stream);
    this.wireCall(call);
  }

  private wireChat(c: DataConnection) {
    c.on("data", (raw) => {
      const m = raw as Wire;
      if (!m) return;
      if (m.t === "chat") {
        this.emitChat(m.text);
      } else if (m.t === "bye") {
        this.partnerLeft();
      }
    });

    c.on("close", () => {
      if (this.chatConn === c && this.paired) {
        this.partnerLeft();
      }
    });

    c.on("error", () => {
      /* noop */
    });
  }

  private wireCall(call: MediaConnection) {
    this.call = call;
    let streamEmitted = false;
    let restarted = false;

    const emitStream = (s: MediaStream) => {
      if (streamEmitted || this.disposed || !this.paired) return;
      streamEmitted = true;
      this.connected = true;
      window.clearTimeout(this.connectWatchdog);
      window.clearTimeout(this.fallbackInitiatorTimer);
      this.hooks.onState("paired");
      this.hooks.onPair(s, this.partnerId ?? "");
    };

    call.on("stream", (s) => {
      emitStream(s);
    });

    const pc = call.peerConnection;
    if (pc) {
      this.hooks.onIce?.("connecting");

      // Страховка через native ontrack
      pc.ontrack = (e) => {
        if (e.streams && e.streams[0]) {
          emitStream(e.streams[0]);
        } else if (e.track) {
          const fallbackStream = new MediaStream([e.track]);
          emitStream(fallbackStream);
        }
      };

      try {
        pc.addEventListener("connectionstatechange", () => {
          if (this.disposed) return;
          const st = pc.connectionState;
          if (st === "connected") {
            void icePathInfo(pc).then((tp) => this.hooks.onIce?.(tp));
          } else if (st === "failed") {
            if (!restarted) {
              restarted = true;
              restartIceOn(call);
            } else {
              this.partnerLeft();
            }
          } else {
            this.hooks.onIce?.(st);
          }
        });

        pc.addEventListener("iceconnectionstatechange", () => {
          if (this.disposed) return;
          if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            void icePathInfo(pc).then((tp) => this.hooks.onIce?.(tp));
          }
        });
      } catch {
        /* noop */
      }
    }

    call.on("close", () => {
      if (this.paired) this.partnerLeft();
    });

    call.on("error", () => {
      /* noop */
    });
  }

  private partnerLeft() {
    if (!this.paired || this.disposed) return;
    this.teardownPair();
    this.hooks.onIce?.("");
    this.hooks.onPeerLeft();

    if (this.searching) {
      this.hooks.onState("searching");
      this.startSearchSwarm();
    }
  }

  private teardownPair() {
    this.paired = false;
    this.connected = false;
    this.partnerId = null;
    window.clearTimeout(this.connectWatchdog);
    window.clearTimeout(this.fallbackInitiatorTimer);

    if (this.chatConn) {
      try {
        this.chatConn.send({ t: "bye" } satisfies Wire);
      } catch {
        /* noop */
      }
      try {
        this.chatConn.close();
      } catch {
        /* noop */
      }
      this.chatConn = null;
    }

    if (this.call) {
      try {
        this.call.close();
      } catch {
        /* noop */
      }
      this.call = null;
    }

    this.stopProbing();
  }

  private destroyMyPeer() {
    if (this.myPeer) {
      try {
        this.myPeer.destroy();
      } catch {
        /* noop */
      }
      this.myPeer = null;
    }
    this.myPeerId = "";
  }

  /* ── Допоміжні методи ── */
  private slotId(i: number) {
    return BEACON_PREFIX + String(i).padStart(2, "0");
  }

  private cmp(a: string, b: string) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private isFatal(t?: string) {
    return (
      t === "network" ||
      t === "socket-error" ||
      t === "socket-closed" ||
      t === "server-error" ||
      t === "disconnected"
    );
  }

  private emitChat(text: string) {
    this.chatListeners.forEach((fn) => fn(text));
  }
}
