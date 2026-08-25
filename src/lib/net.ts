/* ─────────────────────────────────────────────────────────────
   Viche · мережевий матчмейкінг (рулетка)

   Реальний пошук співрозмовників без власного бекенда:
   - сигналінг — публічний PeerJS-брокер (0.peerjs.com, WSS);
   - медіа — P2P WebRTC (DTLS/SRTP), брокер відео не бачить;
   - рандеву: перший клієнт, що зайняв ID `viche-v1-lb`, стає
     «лобі» (тримає чергу), решта під'єднуються до нього; якщо
     лобі зникає — будь-який клієнт підвищується (promotion);
   - якщо брокер недоступний — м'який фолбек на офлайн-демо
     (симуляція + loopback WebRTC), UX не ламається.

   У продакшн цей модуль перемикається на власний Go-сигналінг
   (server/handler.go + matcher.go) — інтерфейс ідентичний.
   ───────────────────────────────────────────────────────────── */
import Peer from "peerjs";
import type { DataConnection, MediaConnection } from "peerjs";
import { makePeer, simulateMatch, shortId, type Filters, type Peer as SimPeer } from "./sim";
import { loopbackConnect, makeCanvasStream, type CanvasCtl } from "./rtc";

const LOBBY_ID = "viche-v1-lb";
const FALLBACK_WAIT_MS = 25000; // довге очікування в черзі → демо-пара
const LOBBY_CONN_TIMEOUT = 5000;

export type NetMode = "connecting" | "online" | "demo";

export type MatchResult = {
  stream: MediaStream;
  peer: SimPeer;
  close: () => void;
  demo: boolean;
  /** реальний текстовий чат (DataConnection) — лише для мережевої пари */
  chat?: { send: (text: string) => void; subscribe: (fn: (text: string) => void) => () => void };
  /** керування canvas-аватаром — лише для демо-пари */
  setSpeaking?: (b: boolean) => void;
};

export type MatchHooks = {
  onMode: (m: NetMode) => void;
  onQueued: () => void;      // реально поставлені в чергу
  onPair: (r: MatchResult) => void;
  onPeerLeft: () => void;    // партнер закрив дзвінок
  onNotice: (key: string) => void; // короткі службові повідомлення
};

type Waiter = { kind: "self" } | { kind: "guest"; conn: DataConnection; id: string };
type Msg = { type: "hello" } | { type: "wait" } | { type: "pair"; with: string; initiator: boolean };

/* STUN — визначає публічні адреси; TURN (Metered Open Relay) —
   обов'язковий для глобальної мережі, коли обидва боки за суворим NAT
   (саме тому "в локальній — працює, в глобальній — ні" без нього).   */
export const iceConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:openrelay.metered.ca:80" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:80?transport=tcp",
        "turn:openrelay.metered.ca:443",
        "turns:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceCandidatePoolSize: 2,
};

/* Повторне встановлення медіа після зміни мережі (Wi-Fi ↔ мобільні дані):
   ICE restart на живих RTCPeerConnection — сигнали йдуть тим самим
   (автовідновлюваним PeerJS) WebSocket-каналом.                        */
export function restartIceOn(call: MediaConnection | null | undefined) {
  try {
    const pc = call?.peerConnection;
    if (pc && pc.signalingState !== "closed") pc.restartIce();
  } catch {
    /* noop */
  }
}

export function attachNetRecovery(getCalls: () => Array<MediaConnection | null | undefined>) {
  const bump = () => getCalls().forEach(restartIceOn);
  window.addEventListener("online", bump);
  const nav = navigator as Navigator & { connection?: { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void } };
  const connChange = () => window.setTimeout(bump, 400);
  nav.connection?.addEventListener?.("change", connChange);
  return () => {
    window.removeEventListener("online", bump);
    nav.connection?.removeEventListener?.("change", connChange);
  };
}

export class MatchClient {
  private peer: Peer | null = null;
  private mode: NetMode = "connecting";
  private isLobby = false;
  private tryingLobby = false;
  private disposed = false;
  private searching = false;

  // лобі (якщо ми тримач)
  private waiter: Waiter | null = null;

  // гість
  private lobbyConn: DataConnection | null = null;
  private lobbyConnTimer = 0;

  // активний дзвінок
  private call: MediaConnection | null = null;
  private callCloser: (() => void) | null = null;
  private expectFrom: string | null = null;
  private paired = false;

  // чат із поточним партнером (DataConnection)
  private partnerId: string | null = null;
  private dataConn: DataConnection | null = null;
  private chatListeners = new Set<(t: string) => void>();

  // демо
  private demoCtl: CanvasCtl | null = null;
  private demoCloser: (() => void) | null = null;
  private demoTimers: number[] = [];

  private detachNet: (() => void) | null = null;

  constructor(private stream: MediaStream, private hooks: MatchHooks) {
    // Wi-Fi ↔ мобільні дані: ICE restart на живих дзвінках
    this.detachNet = attachNetRecovery(() => [this.call]);
    this.promoteOrJoin();
  }

  /* ── топологія: стати лобі або приєднатися до лобі ── */
  private promoteOrJoin() {
    if (this.disposed || this.tryingLobby) return;
    this.tryingLobby = true;
    const p = new Peer(LOBBY_ID, { debug: 0, config: iceConfig });
    p.on("open", () => {
      if (this.disposed) return p.destroy();
      this.tryingLobby = false;
      this.swapPeer(p);
      this.isLobby = true;
      this.setMode("online");
      // якщо вже шукали — стаємо в свою ж чергу
      if (this.searching && !this.waiter) {
        this.waiter = { kind: "self" };
        this.hooks.onQueued();
      }
      this.setupLobbyHandlers();
    });
    p.on("error", (e) => {
      const type = (e as { type?: string }).type;
      if (type === "unavailable-id") {
        // лобі вже хтось тримає → ми гість
        p.destroy();
        this.tryingLobby = false;
        if (this.disposed) return;
        if (this.peer && !this.peer.destroyed) {
          // вже маємо робочий peer (невдале підвищення) → просто в чергу
          if (this.searching && !this.paired) this.helloLobby();
        } else {
          this.joinAsGuest();
        }
      } else if (this.isFatalNet(type)) {
        p.destroy();
        this.tryingLobby = false;
        this.setMode("demo");
      }
    });
  }

  private joinAsGuest() {
    if (this.disposed || this.peer) return;
    const p = new Peer({ debug: 0, config: iceConfig });
    p.on("open", () => {
      if (this.disposed || this.isLobby) return p.destroy();
      this.swapPeer(p);
      this.isLobby = false;
      this.setMode("online");
      if (this.searching) this.helloLobby();
    });
    p.on("error", (e) => {
      const type = (e as { type?: string }).type;
      if (type === "peer-unavailable") {
        // лобі зникло → спробувати підвищитися (якщо не в дзвінку)
        if (!this.paired) {
          this.lobbyConn = null;
          this.promoteOrJoin();
        }
      } else if (this.isFatalNet(type)) {
        this.setMode("demo");
      }
    });
    p.on("disconnected", () => {
      if (!this.disposed && this.peer === p && !p.destroyed) {
        try {
          p.reconnect();
        } catch {
          this.setMode("demo");
        }
      }
    });
  }

  private isFatalNet(type?: string) {
    return type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed";
  }

  private swapPeer(p: Peer) {
    const old = this.peer;
    if (old && old !== p) {
      try {
        old.destroy();
      } catch {
        /* noop */
      }
    }
    this.peer = p;
    p.on("call", (call) => {
      if (this.expectFrom && call.peer === this.expectFrom) {
        this.acceptCall(call);
      } else {
        try {
          call.close();
        } catch {
          /* noop */
        }
      }
    });
    p.on("connection", (conn) => {
      // data-канал від поточного партнера; лобі-тримач не закриває
      // чергові з'єднання гостей — їх обробляє setupLobbyHandlers
      if (this.partnerId && conn.peer === this.partnerId) {
        this.wireData(conn);
      } else if (!this.isLobby) {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      }
    });
  }

  private wireData(conn: DataConnection) {
    if (this.dataConn && this.dataConn !== conn) {
      try {
        this.dataConn.close();
      } catch {
        /* noop */
      }
    }
    this.dataConn = conn;
    conn.on("data", (raw) => {
      const m = raw as { type?: string; text?: string };
      if (m?.type === "msg" && typeof m.text === "string") {
        this.chatListeners.forEach((fn) => fn(m.text as string));
      }
    });
  }

  private setMode(m: NetMode) {
    if (this.mode === m || this.disposed) return;
    this.mode = m;
    this.hooks.onMode(m);
    if (m === "demo" && this.searching && !this.paired) {
      // шукали, але мережі немає → демо-пара, щоб UX не зависав
      this.runDemoPair(true);
    }
  }

  /* ── логіка лобі-тримача ── */
  private setupLobbyHandlers() {
    const p = this.peer;
    if (!p) return;
    p.on("connection", (conn) => {
      conn.on("data", (raw) => {
        const msg = raw as Msg;
        if (msg?.type === "hello") this.onGuestHello(conn);
      });
      conn.on("close", () => {
        // гість вийшов з черги / роз'єднався
        if (this.waiter?.kind === "guest" && this.waiter.conn === conn) this.waiter = null;
      });
    });
  }

  private onGuestHello(conn: DataConnection) {
    const guest: Waiter = { kind: "guest", conn, id: conn.peer };
    if (!this.waiter) {
      this.waiter = guest;
      conn.send({ type: "wait" } satisfies Msg);
      return;
    }
    const waiting = this.waiter;
    this.waiter = null;
    if (waiting.kind === "self") {
      // лобі сам чекав → дзвонимо гостю
      this.startCall(conn.peer, true);
      conn.send({ type: "pair", with: this.peer!.id, initiator: false } satisfies Msg);
    } else if (waiting.conn.open) {
      waiting.conn.send({ type: "pair", with: conn.peer, initiator: false } satisfies Msg);
      conn.send({ type: "pair", with: waiting.id, initiator: true } satisfies Msg);
    } else {
      // попередній гість зник до пари → новий стає в чергу
      this.waiter = guest;
      conn.send({ type: "wait" } satisfies Msg);
    }
  }

  /* ── гість: черга ── */
  private helloLobby() {
    const p = this.peer;
    if (!p || this.disposed) return;
    if (this.lobbyConn?.open) {
      this.lobbyConn.send({ type: "hello" } satisfies Msg);
      return;
    }
    const conn = p.connect(LOBBY_ID, { reliable: true });
    this.lobbyConn = conn;
    window.clearTimeout(this.lobbyConnTimer);
    this.lobbyConnTimer = window.setTimeout(() => {
      if (!conn.open && this.searching && !this.paired && this.mode === "online") {
        this.hooks.onNotice("toast.demoFallback");
        this.runDemoPair(true);
      }
    }, LOBBY_CONN_TIMEOUT);
    conn.on("open", () => {
      window.clearTimeout(this.lobbyConnTimer);
      conn.send({ type: "hello" } satisfies Msg);
    });
    conn.on("data", (raw) => this.onLobbyMsg(raw as Msg));
    conn.on("close", () => {
      window.clearTimeout(this.lobbyConnTimer);
      if (this.lobbyConn === conn) this.lobbyConn = null;
      // лобі померло → підвищення (якщо зараз не в дзвінку)
      if (!this.disposed && !this.paired) {
        const old = this.peer;
        this.peer = null;
        try {
          old?.destroy();
        } catch {
          /* noop */
        }
        this.promoteOrJoin();
      }
    });
  }

  private onLobbyMsg(msg: Msg) {
    if (msg.type === "wait") {
      this.hooks.onQueued();
    } else if (msg.type === "pair") {
      // після «Завершити» лобі може надіслати пару із запізненням — ігноруємо
      if (!this.searching || this.paired) return;
      this.expectFrom = msg.with;
      if (msg.initiator) this.startCall(msg.with, true);
      // не-ініціатор просто чекає вхідний дзвінок (expectFrom)
    }
  }

  /* ── медіа-дзвінок ── */
  private startCall(remoteId: string, initiator: boolean) {
    const p = this.peer;
    if (!p) return;
    const call = p.call(remoteId, this.stream);
    if (!call) {
      this.hooks.onNotice("toast.demoFallback");
      this.runDemoPair(true);
      return;
    }
    this.wireCall(call, initiator);
  }

  private acceptCall(call: MediaConnection) {
    call.answer(this.stream);
    this.wireCall(call, false);
  }

  private wireCall(call: MediaConnection, initiator: boolean) {
    this.call = call;
    this.expectFrom = null;
    // партнер відомий одначе — це закриває гонку для вхідного DataConnection
    this.partnerId = call.peer;
    // watchdog: зміна мережі рве ICE — пробуємо restartIce, вдруге — peer left
    let restarted = false;
    try {
      call.peerConnection?.addEventListener?.("connectionstatechange", () => {
        const st = call.peerConnection?.connectionState;
        if (st !== "failed" || this.call !== call) return;
        if (!restarted) {
          restarted = true;
          restartIceOn(call);
        } else if (this.paired) {
          this.call = null;
          this.paired = false;
          this.hooks.onPeerLeft();
        }
      });
    } catch {
      /* noop */
    }
    call.on("stream", (s) => {
      if (this.call !== call) return;
      this.paired = true;
      this.searching = false;
      this.callCloser = () => {
        try {
          call.close();
        } catch {
          /* noop */
        }
        if (this.call === call) {
          this.call = null;
          this.paired = false;
        }
      };
      // текстовий чат: ініціатор відкриває DataConnection
      if (initiator && this.peer && !this.dataConn) {
        this.wireData(this.peer.connect(call.peer, { reliable: true }));
      }
      const tail = (call.peer || "").slice(-4).toUpperCase() || shortId(4);
      const peer: SimPeer = {
        ...makePeer({ tags: [], langs: [] }),
        id: tail,
        name: "Учасник_" + tail,
        real: true,
      };
      const chat = {
        send: (text: string) => {
          if (this.dataConn?.open) this.dataConn.send({ type: "msg", text });
        },
        subscribe: (fn: (t: string) => void) => {
          this.chatListeners.add(fn);
          return () => {
            this.chatListeners.delete(fn);
          };
        },
      };
      this.hooks.onPair({ stream: s, peer, close: this.callCloser, demo: false, chat });
    });
    call.on("close", () => {
      if (this.call === call && this.paired) {
        this.call = null;
        this.paired = false;
        this.hooks.onPeerLeft();
      } else if (this.searching) {
        // дзвінок відпав до медіа → шукаємо знову
        this.hooks.onNotice("toast.peerLeft");
        this.search(this.lastFilters);
      }
    });
    call.on("error", () => {
      if (this.searching && !this.paired) this.search(this.lastFilters);
    });
  }

  private lastFilters: Filters = { gender: "any", lang: "uk", tags: [] };

  /* ── публічне API ── */
  search(f: Filters) {
    if (this.disposed) return;
    this.lastFilters = f;
    this.clearDemo();
    // «Next»: завершуємо поточну пару перед новим пошуком
    if (this.call && this.paired) {
      this.callCloser?.();
      this.call = null;
      this.paired = false;
      if (this.dataConn) {
        try {
          this.dataConn.close();
        } catch {
          /* noop */
        }
        this.dataConn = null;
      }
      this.partnerId = null;
    }
    this.searching = true;
    if (this.mode === "demo") {
      this.runDemoPair(false);
      return;
    }
    if (this.isLobby) {
      if (!this.waiter) {
        this.waiter = { kind: "self" };
        this.hooks.onQueued();
      }
      return;
    }
    if (this.peer && !this.peer.destroyed) {
      this.helloLobby();
    } else {
      this.peer = null;
      this.promoteOrJoin();
    }
  }

  /** Довго чекаємо в реальній черзі → під'єднати демо-співрозмовника */
  demoPairOnce() {
    if (this.disposed || !this.searching || this.paired || this.mode === "demo") return;
    this.hooks.onNotice("toast.waitLong");
    this.runDemoPair(true);
  }

  stop() {
    this.searching = false;
    this.clearDemo();
    if (this.waiter?.kind === "self") this.waiter = null;
    if (this.call && this.paired) {
      this.callCloser?.();
      this.paired = false;
    }
    if (this.dataConn) {
      try {
        this.dataConn.close();
      } catch {
        /* noop */
      }
      this.dataConn = null;
    }
    // вихід із черги: інакше лобі може з'єднати нас після «Завершити»
    if (this.lobbyConn && !this.isLobby) {
      try {
        this.lobbyConn.close();
      } catch {
        /* noop */
      }
      this.lobbyConn = null;
    }
    this.partnerId = null;
    this.expectFrom = null;
  }

  dispose() {
    this.disposed = true;
    this.detachNet?.();
    this.detachNet = null;
    this.stop();
    window.clearTimeout(this.lobbyConnTimer);
    this.demoTimers.forEach((x) => window.clearTimeout(x));
    try {
      this.lobbyConn?.close();
    } catch {
      /* noop */
    }
    try {
      this.peer?.destroy();
    } catch {
      /* noop */
    }
    this.peer = null;
  }

  /* ── офлайн-демо (симуляція + loopback WebRTC) ── */
  private async runDemoPair(notice: boolean) {
    if (this.disposed || this.paired) return;
    const f = this.lastFilters;
    void notice;
    const p = await simulateMatch(f, true);
    if (this.disposed || this.paired || !this.searching) return;
    const ctl = makeCanvasStream(p.name.split("_")[1] ?? "GG", p.hue);
    this.demoCtl = ctl;
    let close: () => void;
    let stream: MediaStream;
    try {
      const lc = await loopbackConnect(ctl.stream);
      if (this.disposed || !this.searching || this.paired) {
        lc.close();
        ctl.close();
        return;
      }
      stream = lc.stream;
      close = () => {
        lc.close();
        ctl.close();
      };
    } catch {
      if (this.disposed || !this.searching) return;
      stream = ctl.stream;
      close = () => ctl.close();
    }
    this.demoCloser = close;
    this.searching = false;
    this.paired = true; // блокуємо подвійні пари
    this.hooks.onPair({
      stream,
      peer: p,
      close: () => {
        this.paired = false;
        close();
      },
      demo: true,
      setSpeaking: (b) => ctl.setSpeaking(b),
    });
  }

  private clearDemo() {
    this.demoTimers.forEach((x) => window.clearTimeout(x));
    this.demoTimers = [];
    this.demoCloser?.();
    this.demoCloser = null;
    this.demoCtl = null;
  }
}

export { FALLBACK_WAIT_MS };
