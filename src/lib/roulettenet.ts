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
import { attachNetRecovery, defaultPeerOptions, iceConfig, icePathInfo, optimizeSenderBitrate, restartIceOn } from "./net";
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
  onOrientChange?: (orient: "land" | "port") => void;
};

type Wire =
  | { t: "knock"; from: string; f: RouletteFilters; u: string; orient?: "land" | "port" }
  | { t: "accept"; from: string; u: string; orient?: "land" | "port" }
  | { t: "busy" }
  | { t: "chello"; from: string; orient?: "land" | "port" }
  | { t: "orient"; orient: "land" | "port" }
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
  private myOrient: "land" | "port" = "land";

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
  private recoveryTimer = 0;
  private recoveryInterval = 0;
  private recoveryAttempts = 0;
  private recovering = false;
  private explicitBye = false;
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

  constructor(
    private stream: MediaStream,
    private hooks: RouletteHooks,
    initialOrient: "land" | "port" = "land"
  ) {
    this.myOrient = initialOrient;
    this.detachNet = attachNetRecovery(
      () => [this.call],
      () => this.handleNetworkChange()
    );
  }

  public sendOrientation(orient: "land" | "port") {
    this.myOrient = orient;
    if (this.chatConn && this.chatConn.open) {
      try {
        this.chatConn.send({ t: "orient", orient } satisfies Wire);
      } catch {
        /* noop */
      }
    }
  }

  private handleNetworkChange() {
    if (this.disposed) return;
    // Якщо вузол втратив зв'язок із сигнальним сервером через зміну IP
    if (this.myPeer && this.myPeer.disconnected && !this.myPeer.destroyed) {
      try {
        this.myPeer.reconnect();
      } catch {
        /* noop */
      }
    }
    // Якщо активна пара — ініціюємо м'яке відновлення зв'язку
    if (this.paired) {
      this.triggerActiveCallRecovery();
    } else if (this.searching) {
      this.initMyPeer();
    }
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
        if (this.paired) {
          try {
            p.reconnect();
          } catch {
            /* noop */
          }
          return;
        }
        this.destroyMyPeer();
        if (this.searching && !this.paired) {
          window.setTimeout(() => {
            if (this.searching && !this.disposed) this.initMyPeer();
          }, 1200);
        }
      }
    });

    p.on("disconnected", () => {
      if (!this.disposed && p === this.myPeer) {
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

      if (msg.orient) {
        this.hooks.onOrientChange?.(msg.orient);
      }

      // Приймаємо парування
      try {
        conn.send({
          t: "accept",
          from: this.myPeerId,
          u: this.uid,
          orient: this.myOrient,
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
          orient: this.myOrient,
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
        if (msg.orient) {
          this.hooks.onOrientChange?.(msg.orient);
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
    this.explicitBye = false;
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

    if (!this.chatConn || !this.chatConn.open) {
      try {
        const c = this.myPeer.connect(partnerDirectId, { reliable: true });
        this.chatConn = c;
        c.on("open", () => {
          try {
            c.send({ t: "chello", from: this.myPeerId, orient: this.myOrient } satisfies Wire);
            c.send({ t: "orient", orient: this.myOrient } satisfies Wire);
          } catch {
            /* noop */
          }
        });
        this.wireChat(c);
      } catch {
        /* noop */
      }
    }

    if (!this.call) {
      try {
        const call = this.myPeer.call(partnerDirectId, this.stream);
        if (call) this.wireCall(call);
      } catch {
        /* noop */
      }
    }
  }

  private onIncomingPeerConnection(conn: DataConnection) {
    if (!this.paired || conn.peer !== this.partnerId) {
      return;
    }
    if (this.chatConn && this.chatConn !== conn) {
      try {
        this.chatConn.close();
      } catch {
        /* noop */
      }
    }
    this.chatConn = conn;
    this.wireChat(conn);
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
    try {
      if (this.call && this.call !== call) {
        try {
          this.call.close();
        } catch {
          /* noop */
        }
      }
      call.answer(this.stream);
      this.wireCall(call);
    } catch {
      /* noop */
    }
  }

  private wireChat(c: DataConnection) {
    c.on("data", (raw) => {
      const m = raw as Wire;
      if (!m) return;
      if (m.t === "chat") {
        this.emitChat(m.text);
      } else if (m.t === "orient" && m.orient) {
        this.hooks.onOrientChange?.(m.orient);
      } else if (m.t === "chello") {
        if (m.orient) {
          this.hooks.onOrientChange?.(m.orient);
        }
        try {
          c.send({ t: "orient", orient: this.myOrient } satisfies Wire);
        } catch {
          /* noop */
        }
      } else if (m.t === "bye") {
        this.explicitBye = true;
        this.partnerLeft();
      }
    });

    c.on("close", () => {
      if (this.chatConn === c && this.paired) {
        if (this.explicitBye) {
          this.partnerLeft();
        } else {
          // Можливий розрив TCP при зміні мережі (Wi-Fi ↔ LTE) — запускаємо відновлення
          this.triggerActiveCallRecovery();
        }
      }
    });

    c.on("error", () => {
      /* noop */
    });
  }

  private wireCall(call: MediaConnection) {
    this.call = call;
    let streamEmitted = false;

    const emitStream = (s: MediaStream) => {
      if (streamEmitted || this.disposed || !this.paired) return;
      streamEmitted = true;
      this.connected = true;
      this.cancelRecovery();
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
      optimizeSenderBitrate(pc);

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
          if (this.disposed || !this.paired) return;
          const st = pc.connectionState;
          if (st === "connected") {
            this.cancelRecovery();
            optimizeSenderBitrate(pc);
            void icePathInfo(pc).then((tp) => this.hooks.onIce?.(tp));
          } else if (st === "failed") {
            this.triggerActiveCallRecovery();
          } else if (st === "disconnected") {
            // Короткочасна затримка перед реконектом при переході на новий інтерфейс
            window.setTimeout(() => {
              if (this.paired && !this.disposed && (pc.connectionState === "disconnected" || pc.connectionState === "failed")) {
                this.triggerActiveCallRecovery();
              }
            }, 1200);
          } else {
            this.hooks.onIce?.(st);
          }
        });

        pc.addEventListener("iceconnectionstatechange", () => {
          if (this.disposed || !this.paired) return;
          const iceSt = pc.iceConnectionState;
          if (iceSt === "connected" || iceSt === "completed") {
            this.cancelRecovery();
            void icePathInfo(pc).then((tp) => this.hooks.onIce?.(tp));
          } else if (iceSt === "failed") {
            this.triggerActiveCallRecovery();
          }
        });
      } catch {
        /* noop */
      }
    }

    call.on("close", () => {
      if (this.paired) {
        if (this.explicitBye) {
          this.partnerLeft();
        } else {
          this.triggerActiveCallRecovery();
        }
      }
    });

    call.on("error", () => {
      /* noop */
    });
  }

  /* ── Автоматичне відновлення зв'язку при перемиканні мережі (Wi-Fi ↔ 4G/5G) ── */
  private triggerActiveCallRecovery() {
    if (!this.paired || this.disposed || this.explicitBye || this.recovering) return;

    this.recovering = true;
    this.hooks.onIce?.("reconnecting");
    this.recoveryAttempts = 0;

    const ensureSignaling = () => {
      if (this.disposed || !this.paired) return;
      if (!this.myPeer || this.myPeer.destroyed) {
        if (this.myPeerId) {
          const p = new Peer(this.myPeerId, { ...defaultPeerOptions });
          this.myPeer = p;
          p.on("connection", (conn) => this.onIncomingPeerConnection(conn));
          p.on("call", (c) => this.onIncomingPeerCall(c));
          p.on("error", () => {
            /* noop */
          });
        }
      } else if (this.myPeer.disconnected) {
        try {
          this.myPeer.reconnect();
        } catch {
          /* noop */
        }
      }
    };

    ensureSignaling();

    // Закриваємо старі завислі канали на застарілій IP-адресі
    if (this.call) {
      try {
        this.call.close();
      } catch {
        /* noop */
      }
      this.call = null;
    }
    if (this.chatConn) {
      try {
        this.chatConn.close();
      } catch {
        /* noop */
      }
      this.chatConn = null;
    }

    const partner = this.partnerId;
    if (!partner) return;

    const isInitiator = this.cmp(this.myPeerId, partner) < 0;

    const attemptReconnect = () => {
      if (this.disposed || !this.paired || !this.recovering || !this.partnerId) return;
      ensureSignaling();
      this.recoveryAttempts++;

      if (isInitiator || this.recoveryAttempts >= 2) {
        try {
          if (this.myPeer && !this.myPeer.destroyed && (!this.chatConn || !this.chatConn.open)) {
            const c = this.myPeer.connect(this.partnerId, { reliable: true });
            if (c) {
              this.chatConn = c;
              this.wireChat(c);
            }
          }
          if (this.myPeer && !this.myPeer.destroyed && !this.call) {
            const call = this.myPeer.call(this.partnerId, this.stream);
            if (call) {
              this.wireCall(call);
            }
          }
        } catch {
          /* noop */
        }
      }
    };

    // Перша спроба через 350мс після підключення сокету
    window.setTimeout(attemptReconnect, 350);

    // Періодичні спроби відновлення кожні 1.6 с
    window.clearInterval(this.recoveryInterval);
    this.recoveryInterval = window.setInterval(() => {
      if (!this.recovering || !this.paired || this.disposed) {
        window.clearInterval(this.recoveryInterval);
        return;
      }
      attemptReconnect();
    }, 1600);

    // Загальний таймер відновлення зв'язку (12 с)
    window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = window.setTimeout(() => {
      window.clearInterval(this.recoveryInterval);
      if (this.paired && this.recovering && !this.disposed) {
        this.partnerLeft();
      }
    }, 12000);
  }

  private cancelRecovery() {
    this.recovering = false;
    this.recoveryAttempts = 0;
    window.clearTimeout(this.recoveryTimer);
    window.clearInterval(this.recoveryInterval);
  }

  private partnerLeft() {
    if (!this.paired || this.disposed) return;
    this.cancelRecovery();
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
    this.recovering = false;
    this.recoveryAttempts = 0;
    this.explicitBye = false;
    this.partnerId = null;
    window.clearTimeout(this.connectWatchdog);
    window.clearTimeout(this.fallbackInitiatorTimer);
    window.clearTimeout(this.recoveryTimer);
    window.clearInterval(this.recoveryInterval);

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
