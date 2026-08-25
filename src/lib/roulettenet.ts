/* ─────────────────────────────────────────────────────────────
   Viche · децентралізований глобальний пошук (рулетка)

   Чому це надійно (на відміну від старого «лобі-тримача»):
   • Кожен шукач ОТРИМУЄ слот-«домівку» (PeerJS-ID viche-v2-q-XXX) —
     його можуть знайти інші.
   • Одночасно кожен шукач НЕПЕРЕРВНО стукає до інших слотів.
     Тобто всі — і «домівки», і «мандрівники» водночас: жодної
     єдиної точки відмови, жодних черг, жодних ботів.
   • З'єднання = звичайний PeerJS-виклик (той самий транспорт, що
     працює в кімнатах) + окремий DataChannel для чату.
   • Детерміноване обрання ініціатора: парує той, чий ID менший —
     неможливо створити два паралельні дзвінки.
   ───────────────────────────────────────────────────────────── */
import Peer from "peerjs";
import type { DataConnection, MediaConnection } from "peerjs";
import { attachNetRecovery, iceConfig, icePathInfo, restartIceOn } from "./net";
import type { Gender, LangCode } from "./sim";

export type RouletteFilters = {
  gender: Gender;
  lang: LangCode | "any";
  tags: string[];
};

export type RState = "idle" | "searching" | "connecting" | "paired";

export type RouletteHooks = {
  onState: (s: RState) => void;
  /** який слот ми зараз тримаємо (для прозорості) */
  onSlot: (slot: number) => void;
  onPair: (stream: MediaStream, peerId: string) => void;
  onPeerLeft: () => void;
  onIce?: (info: string) => void;
};

type Wire =
  | { t: "knock"; f: RouletteFilters; u: string }
  | { t: "accept"; u: string }
  | { t: "busy" }
  | { t: "chello" }
  | { t: "chat"; text: string }
  | { t: "bye" };

const PREFIX = "viche-v2-q-";
const N_SLOTS = 24;
const PROBE_EVERY = 1200; // як часто стукаємо до нового слоту
const KNOCK_TIMEOUT = 3200; // скільки чекаємо на accept

/* Стабільний відбиток браузера: захищає від самоз'єднання, коли
   відкрито дві вкладки або сторінку перезавантажено під час пошуку. */
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

/* Симетрична перевірка сумісності фільтрів:
   достатньо однієї сторони, бо функція симетрична. */
function compatible(a: RouletteFilters, b: RouletteFilters): boolean {
  if (a.gender !== "any" && b.gender !== "any" && a.gender !== b.gender) return false;
  if (a.lang !== "any" && b.lang !== "any" && a.lang !== b.lang) return false;
  if (a.tags.length > 0 && b.tags.length > 0 && !a.tags.some((x) => b.tags.includes(x))) return false;
  return true;
}

export class RouletteNet {
  private peer: Peer | null = null;
  private mySlot = -1;
  private uid = browserUid();
  private myFilters: RouletteFilters = { gender: "any", lang: "any", tags: [] };

  private partner: string | null = null;
  private chatConn: DataConnection | null = null;
  private call: MediaConnection | null = null;
  private paired = false;
  private connected = false;

  private searching = false;
  private disposed = false;
  private probeTimer = 0;
  private probeIdx = 0;
  private connectWatchdog = 0;
  private detachNet: (() => void) | null = null;
  private chatListeners = new Set<(t: string) => void>();

  private chatApi = {
    send: (text: string) => {
      if (this.chatConn?.open) {
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

  /* ── публічне API ── */
  search(f: RouletteFilters) {
    if (this.disposed) return;
    this.teardownPair();
    this.myFilters = f;
    this.searching = true;
    this.hooks.onState("searching");
    if (!this.peer) this.acquire(this.rand(N_SLOTS));
    this.startProbing();
  }

  next() {
    if (this.disposed) return;
    this.teardownPair();
    this.searching = true;
    this.hooks.onState("searching");
    if (!this.peer) this.acquire(this.rand(N_SLOTS));
    this.startProbing();
  }

  stop() {
    this.searching = false;
    this.teardownPair();
    this.destroyPeer();
    this.hooks.onState("idle");
    this.hooks.onIce?.("");
  }

  dispose() {
    this.disposed = true;
    this.searching = false;
    window.clearTimeout(this.connectWatchdog);
    this.teardownPair();
    this.destroyPeer();
    this.detachNet?.();
    this.detachNet = null;
  }

  /* ── отримання «домівки»: перебираємо слоти, поки не займемо вільний ── */
  private acquire(start: number) {
    if (this.peer || this.disposed || !this.searching) return;
    let i = start;
    const attempt = () => {
      if (this.peer || this.disposed || !this.searching) return;
      const slot = i % N_SLOTS;
      const id = this.slotId(slot);
      const p = new Peer(id, { debug: 0, config: iceConfig });
      let settled = false;
      const to = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          p.destroy();
        } catch {
          /* noop */
        }
        i++;
        attempt();
      }, 3000);
      p.on("open", () => {
        if (settled) {
          try {
            p.destroy();
          } catch {
            /* noop */
          }
          return;
        }
        settled = true;
        window.clearTimeout(to);
        if (this.disposed || !this.searching || this.peer) {
          try {
            p.destroy();
          } catch {
            /* noop */
          }
          return;
        }
        this.adoptPeer(p, slot);
      });
      p.on("error", (e) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(to);
        const t = (e as { type?: string }).type;
        try {
          p.destroy();
        } catch {
          /* noop */
        }
        if (this.disposed || !this.searching) return;
        if (this.isFatal(t)) {
          // брокер недоступний — спробуємо ще раз трохи згодом
          window.setTimeout(() => attempt(), 2500);
        } else {
          // слот зайнятий або інша помилка — наступний
          i++;
          attempt();
        }
      });
    };
    attempt();
  }

  private adoptPeer(p: Peer, slot: number) {
    this.peer = p;
    this.mySlot = slot;
    this.hooks.onSlot(slot);
    // вхідні стуки (ми — «домівка»)
    p.on("connection", (conn) => this.onIncoming(conn));
    // вхідний медіа-виклик — відповідаємо лише своєму партнеру
    p.on("call", (call) => {
      if (this.paired && call.peer === this.partner) this.acceptCall(call);
      else {
        try {
          call.close();
        } catch {
          /* noop */
        }
      }
    });
    p.on("error", (e) => {
      const t = (e as { type?: string }).type;
      if (this.disposed) return;
      if (this.isFatal(t)) {
        // втратили брокер — перепідключаємось
        this.destroyPeer();
        if (this.searching && !this.paired) {
          window.setTimeout(() => {
            if (this.searching && !this.disposed) this.acquire(this.rand(N_SLOTS));
          }, 1500);
        }
      }
    });
  }

  /* ── обробка вхідних повідомлень (домівка) ── */
  private onIncoming(conn: DataConnection) {
    conn.on("data", (raw) => {
      const m = raw as Wire;
      if (!m?.t) return;
      if (m.t === "knock") {
        // свій браузер (друга вкладка / перезавантаження) → busy, не паруємось
        if (this.paired || m.u === this.uid || !compatible(this.myFilters, m.f)) {
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
          }, 300);
        } else {
          this.finishPair(conn.peer);
          try {
            conn.send({ t: "accept", u: this.uid } satisfies Wire);
          } catch {
            /* noop */
          }
          window.setTimeout(() => {
            try {
              conn.close();
            } catch {
              /* noop */
            }
          }, 500);
        }
      } else if (m.t === "chello") {
        // виділений чат-канал від партнера (ініціює той, чий ID менший)
        if (conn.peer === this.partner && this.paired && !this.chatConn) {
          this.chatConn = conn;
          this.wireChat(conn);
        } else {
          try {
            conn.close();
          } catch {
            /* noop */
          }
        }
      } else if (m.t === "chat") {
        if (conn === this.chatConn) this.emitChat(m.text);
      } else if (m.t === "bye") {
        if (conn.peer === this.partner) this.partnerLeft();
      }
    });
    conn.on("error", () => {
      /* noop */
    });
  }

  /* ── «мандрівник»: безперервно стукаємо до інших слотів ── */
  private startProbing() {
    this.stopProbing();
    this.probeIdx = this.rand(N_SLOTS);
    this.probeTimer = window.setInterval(() => this.probe(), PROBE_EVERY);
    this.probe();
  }

  private stopProbing() {
    if (this.probeTimer) {
      window.clearInterval(this.probeTimer);
      this.probeTimer = 0;
    }
  }

  private probe() {
    if (!this.searching || this.paired || this.disposed || !this.peer) return;
    const idx = this.probeIdx % N_SLOTS;
    this.probeIdx++;
    const target = this.slotId(idx);
    if (idx === this.mySlot || target === this.peer.id) return; // не стукаємо до себе
    const conn = this.peer.connect(target, { reliable: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(to);
      try {
        conn.close();
      } catch {
        /* noop */
      }
    };
    const to = window.setTimeout(finish, KNOCK_TIMEOUT);
    conn.on("open", () => {
      if (done || this.paired) {
        finish();
        return;
      }
      try {
        conn.send({ t: "knock", f: this.myFilters, u: this.uid } satisfies Wire);
      } catch {
        finish();
      }
    });
    conn.on("data", (raw) => {
      const m = raw as Wire;
      if (done) return;
      if (m?.t === "accept") {
        // відгукнувся наш власний браузер (примарний слот) → відхиляємо
        if (this.paired || m.u === this.uid) {
          finish();
          return;
        }
        this.finishPair(target);
        finish(); // стук-канал більше не потрібен
      } else if (m?.t === "busy") {
        finish();
      }
    });
    conn.on("error", finish);
  }

  /* ── парування (спільне для обох ролей) ── */
  private finishPair(partnerId: string) {
    if (this.paired || this.disposed) return;
    this.paired = true;
    this.connected = false;
    this.partner = partnerId;
    this.stopProbing();
    this.hooks.onState("connecting");

    // watchdog: якщо інша сторона обрала іншого партнера й відхилила нас,
    // з'єднання не завершиться — повертаємось до пошуку замість зависання
    window.clearTimeout(this.connectWatchdog);
    this.connectWatchdog = window.setTimeout(() => {
      if (this.paired && !this.connected && !this.disposed) this.partnerLeft();
    }, 8000);

    const iInitiate = this.cmp(this.peer!.id, partnerId) < 0;
    if (iInitiate) {
      // виділений чат-канал
      const c = this.peer!.connect(partnerId, { reliable: true });
      this.chatConn = c;
      c.on("open", () => {
        try {
          c.send({ t: "chello" } satisfies Wire);
        } catch {
          /* noop */
        }
      });
      this.wireChat(c);
      // медіа-виклик
      this.wireCall(this.peer!.call(partnerId, this.stream));
    }
    // інакше чекаємо вхідні chello та call
  }

  private wireChat(c: DataConnection) {
    c.on("data", (raw) => {
      const m = raw as Wire;
      if (m?.t === "chat") this.emitChat(m.text);
      else if (m?.t === "bye") this.partnerLeft();
    });
    c.on("close", () => {
      if (this.chatConn === c && this.paired) this.partnerLeft();
    });
    c.on("error", () => {
      /* noop */
    });
  }

  private wireCall(call: MediaConnection) {
    this.call = call;
    let restarted = false;
    call.on("stream", (s) => {
      if (this.disposed) return;
      this.connected = true;
      window.clearTimeout(this.connectWatchdog);
      this.hooks.onState("paired");
      this.hooks.onPair(s, this.partner ?? "");
    });
    call.on("close", () => {
      if (this.paired) this.partnerLeft();
    });
    call.on("error", () => {
      /* noop */
    });
    const pc = call.peerConnection;
    if (pc) {
      this.hooks.onIce?.("connecting");
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
      } catch {
        /* noop */
      }
    }
  }

  private acceptCall(call: MediaConnection) {
    call.answer(this.stream);
    this.wireCall(call);
  }

  private partnerLeft() {
    if (!this.paired || this.disposed) return;
    this.teardownPair();
    this.hooks.onIce?.("");
    this.hooks.onPeerLeft();
    // одразу шукаємо наступного — БЕЗ жодних ботів
    if (this.searching) {
      this.hooks.onState("searching");
      if (!this.peer) this.acquire(this.rand(N_SLOTS));
      this.startProbing();
    }
  }

  private teardownPair() {
    this.paired = false;
    this.connected = false;
    this.partner = null;
    window.clearTimeout(this.connectWatchdog);
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

  private destroyPeer() {
    this.stopProbing();
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        /* noop */
      }
      this.peer = null;
    }
    this.mySlot = -1;
  }

  /* ── допоміжне ── */
  private slotId(i: number) {
    return PREFIX + String(i).padStart(3, "0");
  }
  private rand(n: number) {
    return Math.floor(Math.random() * n);
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
