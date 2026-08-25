import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RoomNet, type Member, type RoomStatus } from "../lib/roomnet";
import { RouletteNet } from "../lib/roulettenet";
import {
  filterProfanity,
  makeRoomId,
  now,
  roomLink,
  roomIdStr,
  shortId,
  type RoomId,
} from "../lib/sim";
import type { LocalMedia } from "../lib/rtc";
import { useI18n } from "../i18n";
import { useScramble } from "../lib/hooks";
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconEnd,
  IconLink,
  IconMicOff,
  IconPlus,
  IconRooms,
  IconSend,
  IconUserPlus,
} from "./icons";

/* Випадковий гість — РЕАЛЬНА людина, знайдена мисливцем у глобальному
   пулі рулетки (RouletteNet). Жодних ботів. */
type Hunter = { id: string; name: string; stream: MediaStream; net: RouletteNet };
type ChatMsg = {
  id: number;
  kind: "sys" | "msg";
  name?: string;
  text: string;
  time: string;
  you?: boolean;
};
type StoredRoom = { number: string; code: string; ts: number };

type Props = {
  localMedia: LocalMedia | null;
  ensureLocal: () => Promise<LocalMedia>;
  releaseMedia: () => void;
  onToast: (msg: string, kind?: "ok" | "warn") => void;
  initialJoin: RoomId | null;
};

let mid = 0;
const RECENT_KEY = "viche:rooms";
const NAME_KEY = "viche:name";

const loadRecent = (): StoredRoom[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") as StoredRoom[];
  } catch {
    return [];
  }
};
const saveRecent = (r: RoomId) => {
  try {
    const list = [{ number: r.number, code: r.code, ts: Date.now() }, ...loadRecent().filter((x) => x.number !== r.number)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* noop */
  }
};

/* ── Плитка відео: 4:3 для горизонтального, 3:4 для вертикального, без обрізки ── */
function Tile({
  stream,
  name,
  badge,
  badgeTone = "mint",
  muted,
  onKick,
  kickLabel,
}: {
  stream: MediaStream;
  name: string;
  badge?: string;
  badgeTone?: "mint" | "amber" | "faint";
  muted?: boolean;
  onKick?: () => void;
  kickLabel?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [port, setPort] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    v.onloadedmetadata = () => {
      setPort(v.videoWidth > 0 && v.videoHeight > 0 && v.videoWidth < v.videoHeight);
      v.play().catch(() => {});
    };
    v.play().catch(() => {});
  }, [stream]);
  const tone =
    badgeTone === "mint"
      ? "text-[var(--c-mint)] border-[color-mix(in_srgb,var(--c-mint)_45%,transparent)]"
      : badgeTone === "amber"
        ? "text-[var(--c-amber)] border-[color-mix(in_srgb,var(--c-amber)_45%,transparent)]"
        : "text-[var(--c-faint)] border-[var(--c-line2)]";
  return (
    <div className={`group relative w-full ${port ? "aspect-[3/4] max-w-[300px] mx-auto" : "aspect-[4/3]"} rounded-xl overflow-hidden border border-[var(--c-line)] bg-black`}>
      <video ref={ref} autoPlay playsInline muted={muted} className="absolute inset-0 w-full h-full object-contain" />
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 px-3 py-2 bg-gradient-to-t from-black/75 to-transparent">
        <span className="text-[13px] font-700 text-white truncate">{name}</span>
        {muted && <IconMicOff className="w-3.5 h-3.5 text-white/70 flex-none" />}
      </div>
      {badge && (
        <span className={`absolute top-2 left-2 font-mono text-[10px] px-2 py-0.5 rounded-md border bg-black/55 backdrop-blur-sm ${tone}`}>
          {badge}
        </span>
      )}
      {onKick && (
        <button
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity grid place-items-center w-8 h-8 rounded-lg bg-black/60 border border-[color-mix(in_srgb,var(--c-red)_55%,transparent)] text-[var(--c-red)] hover:bg-[color-mix(in_srgb,var(--c-red)_18%,black)]"
          onClick={onKick}
          title={kickLabel}
          aria-label={kickLabel}
        >
          <IconClose className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export default function Rooms({ localMedia, ensureLocal, releaseMedia, onToast, initialJoin }: Props) {
  const { t } = useI18n();
  const titleWord = useScramble(t("room.title"), 120);

  const [screen, setScreen] = useState<"home" | "room">("home");
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) || "";
    } catch {
      return "";
    }
  });
  const [seats, setSeats] = useState(4);
  const [joinNum, setJoinNum] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);

  const [room, setRoom] = useState<RoomId | null>(null);
  const [status, setStatus] = useState<RoomStatus | null>(null);
  const [iceInfo, setIceInfo] = useState("");
  const [roster, setRoster] = useState<Member[]>([]);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [hunters, setHunters] = useState<Hunter[]>([]);
  const huntersRef = useRef<Hunter[]>([]);
  useEffect(() => {
    huntersRef.current = hunters;
  }, [hunters]);
  /* aux-потоки: відео «випадкових гостей», ретрансльоване хостом —
     їх бачать усі учасники кімнати (не лише адміністратор) */
  const [auxStreams, setAuxStreams] = useState<Record<string, { name: string; stream: MediaStream }>>({});
  const [searching, setSearching] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [recents, setRecents] = useState<StoredRoom[]>(loadRecent);

  const netRef = useRef<RoomNet | null>(null);
  const creatorRef = useRef(false);
  const aliveRef = useRef(true);
  const prevRoster = useRef<Member[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const joinedOnce = useRef(false);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const push = useCallback((kind: ChatMsg["kind"], text: string, extra?: Partial<ChatMsg>) => {
    setMsgs((m) => [...m.slice(-80), { id: ++mid, kind, text, time: now(), ...extra }]);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      netRef.current?.leave();
      netRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  /* системні повідомлення про вхід/вихід за різницею ростеру */
  useEffect(() => {
    const prev = prevRoster.current;
    if (prev.length && screen === "room") {
      const added = roster.filter((m) => !prev.some((p) => p.id === m.id));
      const gone = prev.filter((p) => !roster.some((m) => m.id === p.id));
      added.forEach((m) => push("sys", `${m.name} ${tRef.current("room.guestJoined")}`));
      gone.forEach((m) => push("sys", `${m.name} ${tRef.current("room.guestLeft")}`));
    }
    prevRoster.current = roster;
  }, [roster, screen, push]);

  const leaveRoom = useCallback(() => {
    netRef.current?.leave();
    netRef.current = null;
    huntersRef.current.forEach((h) => h.net.dispose());
    setHunters([]);
    setScreen("home");
    setRoom(null);
    setStatus(null);
    setIceInfo("");
    setRoster([]);
    prevRoster.current = [];
    setStreams({});
    setAuxStreams({});
    setMsgs([]);
    setSearching(false);
    // після виходу з кімнати камера/мікрофон вимикаються повністю
    releaseMedia();
  }, [releaseMedia]);

  const openRoom = useCallback(
    async (r: RoomId, asCreator: boolean) => {
      setBusy(true);
      try {
        const lm = await ensureLocal();
        if (!aliveRef.current) return;
        creatorRef.current = asCreator;
        setRoom(r);
        setScreen("room");
        setMsgs([]);
        prevRoster.current = [];
        setRoster([]);
        setStreams({});
        setAuxStreams({});
        saveRecent(r);
        setRecents(loadRecent());
        const net = new RoomNet(r, name.trim() || "Гість_" + shortId(4), lm.stream, seats, {
          onStatus: (s) => {
            if (!aliveRef.current) return;
            setStatus(s);
            if (s === "host") {
              push("sys", tRef.current("room.sHost"));
            } else if (s === "guest") {
              push("sys", tRef.current("room.sGuest"));
            } else if (s === "exists" && creatorRef.current) {
              onToast(tRef.current("room.errExists"), "warn");
              netRef.current?.leave();
              void openRoom(makeRoomId(), true);
            } else if (s === "not-found") {
              onToast(tRef.current("room.errNotFound"), "warn");
              leaveRoom();
            } else if (s === "full") {
              onToast(tRef.current("room.errFull"), "warn");
              leaveRoom();
            } else if (s === "closed" && prevRoster.current.length > 0) {
              onToast(tRef.current("room.errClosed"), "warn");
              leaveRoom();
            }
          },
          onRoster: (members) => aliveRef.current && setRoster(members),
          onPeerStream: (pid, s) => aliveRef.current && setStreams((st) => ({ ...st, [pid]: s })),
          onPeerGone: (pid) =>
            aliveRef.current &&
            setStreams((st) => {
              const cp = { ...st };
              delete cp[pid];
              return cp;
            }),
          onChat: (_from, fromName, text) => {
            if (!aliveRef.current) return;
            const { text: clean, flagged } = filterProfanity(text);
            push("msg", clean, { name: fromName });
            if (flagged) push("sys", tRef.current("chat.warn"));
          },
          onKicked: () => {
            if (!aliveRef.current) return;
            onToast(tRef.current("room.kicked"), "warn");
            leaveRoom();
          },
          onIceInfo: (info) => aliveRef.current && setIceInfo(info),
          onAuxStream: (auxId, auxName, stream) =>
            aliveRef.current && setAuxStreams((a) => ({ ...a, [auxId]: { name: auxName, stream } })),
          onAuxGone: (auxId) =>
            aliveRef.current &&
            setAuxStreams((a) => {
              const cp = { ...a };
              delete cp[auxId];
              return cp;
            }),
        });
        netRef.current = net;
      } finally {
        setBusy(false);
      }
    },
    [ensureLocal, leaveRoom, name, onToast, push, seats]
  );

  /* вхід за лінком (?room=…&code=…) */
  useEffect(() => {
    if (initialJoin && !joinedOnce.current) {
      joinedOnce.current = true;
      void openRoom(initialJoin, false);
    }
  }, [initialJoin, openRoom]);

  const createRoom = () => {
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* noop */
    }
    void openRoom(makeRoomId(), true);
  };

  const joinRoom = () => {
    // підтримка вставленого «123456-ABCD» цілком у будь-яке поле:
    // перші 6 цифр — номер, наступні 4 знаки — код
    const raw = (joinNum + joinCode).toUpperCase().replace(/[^0-9A-Z]/g, "");
    const number = raw.slice(0, 6);
    const code = raw.slice(6, 10);
    if (!/^\d{6}$/.test(number) || code.length !== 4) {
      onToast(t("room.invalid"), "warn");
      return;
    }
    void openRoom({ number, code }, false);
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(t("toast.copied"), "ok");
    } catch {
      onToast(t("toast.copied"), "warn");
    }
  };

  const shareLink = async () => {
    if (!room) return;
    const url = roomLink(room);
    const nav = navigator as Navigator & { share?: (d: { url: string }) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ url });
        return;
      } catch {
        /* скасовано */
      }
    }
    await copyText(url);
  };

  /* Add Random — гібридна фішка: мисливець шукає у глобальному пулі
     рулетки РЕАЛЬНУ людину і підключає її справжній потік до кімнати.
     Жодних ботів: якщо нікого немає — просто шукає далі. */
  const pendingHunter = useRef<RouletteNet | null>(null);

  const cancelHunt = () => {
    pendingHunter.current?.dispose();
    pendingHunter.current = null;
    setSearching(false);
  };

  const addRandom = async () => {
    if (!netRef.current || !room) return;
    if (searching) {
      cancelHunt();
      return;
    }
    if (roster.length + hunters.length >= seats) {
      onToast(`${t("room.seats")}: ${seats}`, "warn");
      return;
    }
    const lm = await ensureLocal();
    if (!aliveRef.current) return;
    setSearching(true);
    const hunter = new RouletteNet(lm.stream, {
      onState: () => {},
      onSlot: () => {},
      onPair: (stream, peerId) => {
        if (!aliveRef.current) return;
        pendingHunter.current = null;
        const tail = peerId.replace(/[^0-9]/g, "") || peerId.slice(-3);
        const name = "Гість_" + tail;
        // upsert: подія "stream" може повторитись (ICE restart) — не
        // додаємо дублікат, а оновлюємо потік того самого гостя
        setHunters((hs) => {
          const exists = hs.some((h) => h.net === hunter || h.id === peerId);
          if (exists) {
            return hs.map((h) => (h.net === hunter || h.id === peerId ? { ...h, stream } : h));
          }
          return [...hs, { id: peerId, name, stream, net: hunter }];
        });
        // головне: хост ретранслює відео випадкового гостя ВСІМ учасникам
        netRef.current?.shareAuxStream(peerId, name, stream);
        push("sys", `${name} ${t("room.guestJoined")} · ${t("room.randomBadge")}`);
        setSearching(false);
      },
      onPeerLeft: () => {
        if (!aliveRef.current) return;
        const gone = huntersRef.current.find((h) => h.net === hunter);
        if (gone) netRef.current?.stopShareAuxStream(gone.id);
        setHunters((hs) => hs.filter((h) => h.net !== hunter));
        hunter.dispose();
        push("sys", t("room.guestLeft"));
      },
      onIce: () => {},
    });
    pendingHunter.current = hunter;
    hunter.search({ gender: "any", lang: "any", tags: [] });
  };

  const kickHunter = (id: string) => {
    const h = huntersRef.current.find((x) => x.id === id);
    if (!h) return;
    h.net.dispose();
    netRef.current?.stopShareAuxStream(id); // прибираємо з екранів усіх учасників
    push("sys", `${h.name} ${t("room.guestLeft")}`);
    setHunters((hs) => hs.filter((x) => x.id !== id));
  };

  const replaceHunter = async (id: string) => {
    kickHunter(id);
    await addRandom();
  };

  const send = () => {
    const raw = draft.trim();
    if (!raw || !netRef.current) return;
    const { text, flagged } = filterProfanity(raw);
    push("msg", text, { you: true, name: t("room.you") });
    setDraft("");
    if (flagged) push("sys", t("chat.warn"));
    netRef.current.sendChat(text);
  };

  const isHost = !!room && status === "host";
  const link = room ? roomLink(room) : "";
  const filled = roster.length + hunters.length;

  /* ── Екран кімнати ── */
  if (screen === "room" && room) {
    return (
      <div className="fadeup">
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <div className="min-w-0">
            <p className="panel-title">{t("room.live")}</p>
            <h1 className="font-display font-900 text-xl sm:text-2xl tracking-tight flex items-center gap-2.5">
              №{room.number}
              <span className="text-[var(--c-amber)]">·</span>
              <span className="text-[var(--c-amber)]">{room.code}</span>
            </h1>
          </div>
          <span
            className={`chip !cursor-default !text-[11px] font-mono ${
              status === "host" || status === "guest" ? "chip-on" : ""
            }`}
          >
            {status === "host" ? t("room.sHost") : status === "guest" ? t("room.sGuest") : t("room.sConnecting")}
          </span>
          <span className="chip !cursor-default !text-[11px] font-mono">
            {filled}/{seats} · {t("room.members").toLowerCase()}
          </span>
          {iceInfo && (
            <span
              className={`chip !cursor-default !text-[11px] font-mono ${
                iceInfo.includes("relay") ? "chip-on" : ""
              }`}
              title="WebRTC ICE paths (mesh)"
            >
              {iceInfo.includes("relay") ? "turn · " : "ice · "}
              {iceInfo}
            </span>
          )}
          <button className="btn btn-red ml-auto" onClick={leaveRoom}>
            <IconEnd className="w-4 h-4" />
            {t("room.leave")}
          </button>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_330px] gap-4 items-start">
          {/* ── Сітка учасників ── */}
          <div className="min-w-0">
            <div className="grid sm:grid-cols-2 gap-3">
              {/* реальні учасники (mesh P2P) */}
              {roster.map((m) => {
                const self = netRef.current?.myId === m.id;
                const st = self ? localMedia?.stream : streams[m.id];
                return st ? (
                  <Tile
                    key={m.id}
                    stream={st}
                    name={self ? `${m.name} · ${t("room.you")}` : m.name}
                    badge={self ? t("room.you") : m.id === netRef.current?.hostId ? t("room.admin") : "p2p"}
                    badgeTone={self ? "amber" : "mint"}
                    muted={self}
                    onKick={isHost && !self ? () => netRef.current?.kick(m.id) : undefined}
                    kickLabel={t("room.kick")}
                  />
                ) : (
                  <div key={m.id} className="aspect-[4/3] rounded-xl border border-dashed border-[var(--c-line2)] grid place-items-center bg-[var(--c-bg2)]">
                    <p className="font-mono text-[11px] text-[var(--c-faint)] caret">{m.name} · p2p…</p>
                  </div>
                );
              })}
              {/* випадкові гості — реальні люди з пулу рулетки */}
              {hunters.map((g) => (
                <div key={g.id} className="relative">
                  <Tile
                    stream={g.stream}
                    name={g.name}
                    badge={t("room.randomBadge")}
                    badgeTone="mint"
                    onKick={isHost ? () => kickHunter(g.id) : undefined}
                    kickLabel={t("room.kick")}
                  />
                  {isHost && (
                    <button
                      className="absolute -bottom-2.5 right-3 chip !text-[11px] !py-1 shadow-[var(--c-shadow)]"
                      onClick={() => void replaceHunter(g.id)}
                    >
                      <IconUserPlus className="w-3.5 h-3.5" />
                      {t("room.replace")}
                    </button>
                  )}
                </div>
              ))}
              {/* випадкові гості, ретрансльовані хостом — їх бачать усі
                  учасники (не лише адміністратор); у хоста цей список
                  порожній, бо він бачить їх через `hunters` */}
              {Object.entries(auxStreams).map(([auxId, a]) => (
                <Tile
                  key={"aux-" + auxId}
                  stream={a.stream}
                  name={a.name}
                  badge={t("room.randomBadge")}
                  badgeTone="mint"
                />
              ))}
              {/* вільні місця */}
              {Array.from({ length: Math.max(0, seats - filled) }).map((_, i) => (
                <div key={"e" + i} className="aspect-[4/3] rounded-xl border border-dashed border-[var(--c-line)] grid place-items-center bg-[color-mix(in_srgb,var(--c-bg2)_60%,transparent)]">
                  <p className="font-mono text-[11px] text-[var(--c-faint)]">{t("room.emptySeat")}</p>
                </div>
              ))}
            </div>

            {isHost && (
              <button className="btn mt-4" onClick={() => void addRandom()} disabled={searching || filled >= seats}>
                <IconPlus className="w-4 h-4" />
                {searching ? t("room.searching") : t("room.addRandom")}
              </button>
            )}
          </div>

          {/* ── Бічна колонка ── */}
          <aside className="space-y-4 min-w-0">
            <div className="card p-4">
              <p className="panel-title mb-3">{t("room.invite")}</p>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <button className="rounded-lg border border-[var(--c-line)] bg-[var(--c-bg2)] px-3 py-2.5 text-left hover:border-[var(--c-line2)] transition-colors group" onClick={() => void copyText(room.number)}>
                  <p className="text-[10px] text-[var(--c-faint)]">{t("room.number")}</p>
                  <p className="font-mono font-700 text-[15px] text-[var(--c-text)] group-hover:text-[var(--c-mint)] transition-colors">{room.number}</p>
                </button>
                <button className="rounded-lg border border-[var(--c-line)] bg-[var(--c-bg2)] px-3 py-2.5 text-left hover:border-[var(--c-line2)] transition-colors group" onClick={() => void copyText(room.code)}>
                  <p className="text-[10px] text-[var(--c-faint)]">{t("room.code")}</p>
                  <p className="font-mono font-700 text-[15px] text-[var(--c-amber)] group-hover:text-[var(--c-mint)] transition-colors">{room.code}</p>
                </button>
              </div>
              <p className="text-[10px] text-[var(--c-faint)] mb-1.5">{t("room.link")}</p>
              <div className="flex gap-1.5">
                <input className="input !py-2 !text-[11.5px] font-mono" readOnly value={link} onFocus={(e) => e.target.select()} />
                <button className="btn btn-icon !rounded-lg" onClick={() => void copyText(link)} title={t("room.copyLink")}>
                  <IconCopy className="w-4 h-4" />
                </button>
                <button className="btn btn-icon !rounded-lg" onClick={() => void shareLink()} title={t("room.share")}>
                  <IconLink className="w-4 h-4" />
                </button>
              </div>
              <p className="mt-3 text-[11px] text-[var(--c-dim)] leading-relaxed">{t("room.sub")}</p>
            </div>

            <div className="card overflow-hidden flex flex-col h-[380px]">
              <div className="px-4 py-2.5 border-b border-[var(--c-line)] flex items-center justify-between">
                <p className="panel-title">{t("chat.title")}</p>
                <span className="font-mono text-[10px] text-[var(--c-mint)]">{roster.length} p2p</span>
              </div>
              <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2.5 space-y-2">
                {msgs.map((m) => (
                  <div key={m.id} className={`logline text-[13px] leading-snug ${m.you ? "text-right" : ""}`}>
                    {m.kind === "sys" ? (
                      <p className="font-mono text-[11px] text-[var(--c-faint)]">— {m.text} —</p>
                    ) : (
                      <span
                        className={`inline-block max-w-full text-left px-2.5 py-1.5 rounded-lg break-words ${
                          m.you ? "bg-[color-mix(in_srgb,var(--c-amber)_18%,transparent)]" : "bg-[var(--c-raise)]"
                        }`}
                      >
                        <span className="block font-mono text-[9.5px] text-[var(--c-faint)] mb-0.5">
                          {m.you ? t("room.you") : m.name} · {m.time}
                        </span>
                        {m.text}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="p-2 border-t border-[var(--c-line)] flex gap-1.5">
                <input
                  className="input !py-2 !text-[13px]"
                  placeholder={t("chat.ph")}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                />
                <button className="btn btn-amber btn-icon !rounded-lg" onClick={send} aria-label={t("chat.ph")}>
                  <IconSend className="w-4 h-4" />
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  /* ── Домашній екран кімнат ── */
  return (
    <div>
      <div className="max-w-3xl mb-8">
        <p className="panel-title mb-2">viche · rooms</p>
        <h1 className="font-display font-900 text-2xl sm:text-4xl tracking-tight">{titleWord}</h1>
        <p className="mt-3 text-[15px] text-[var(--c-dim)] leading-relaxed">{t("room.sub")}</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4 items-start">
        <div className="card p-5">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="grid place-items-center w-9 h-9 rounded-lg bg-[color-mix(in_srgb,var(--c-amber)_14%,transparent)] text-[var(--c-amber)]">
              <IconRooms className="w-5 h-5" />
            </span>
            <h2 className="font-display font-700 text-lg">{t("room.create")}</h2>
          </div>
          <label className="block text-[11px] text-[var(--c-faint)] mb-1.5">{t("room.name")}</label>
          <input className="input mb-4" placeholder={t("room.namePh")} value={name} onChange={(e) => setName(e.target.value.slice(0, 24))} />
          <p className="text-[11px] text-[var(--c-faint)] mb-1.5">{t("room.seats")}</p>
          <div className="flex gap-2 mb-5">
            {[2, 3, 4, 6, 8].map((s) => (
              <button key={s} className={`chip !px-4 font-mono ${seats === s ? "chip-on" : ""}`} onClick={() => setSeats(s)}>
                {s}
              </button>
            ))}
          </div>
          <button className="btn btn-amber w-full !py-3" onClick={createRoom} disabled={busy}>
            <IconPlus className="w-4 h-4" />
            {t("room.createBtn")}
          </button>
          <p className="mt-3 font-mono text-[10.5px] text-[var(--c-faint)] flex items-center gap-1.5">
            <IconCheck className="w-3.5 h-3.5 text-[var(--c-mint)]" />
            {t("room.sHost")} · mesh p2p
          </p>
        </div>

        <div className="space-y-4">
          <div className="card p-5">
            <div className="flex items-center gap-2.5 mb-4">
              <span className="grid place-items-center w-9 h-9 rounded-lg bg-[color-mix(in_srgb,var(--c-mint)_14%,transparent)] text-[var(--c-mint)]">
                <IconUserPlus className="w-5 h-5" />
              </span>
              <h2 className="font-display font-700 text-lg">{t("room.join")}</h2>
            </div>
            <div className="grid grid-cols-[1fr_92px] gap-2 mb-4">
              <div>
                <label className="block text-[11px] text-[var(--c-faint)] mb-1.5">{t("room.number")}</label>
                <input
                  className="input font-mono"
                  inputMode="numeric"
                  placeholder={t("room.numberPh")}
                  value={joinNum}
                  onChange={(e) => setJoinNum(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--c-faint)] mb-1.5">{t("room.code")}</label>
                <input
                  className="input font-mono uppercase"
                  placeholder={t("room.codePh")}
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4))}
                  onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                />
              </div>
            </div>
            <button className="btn w-full !py-3" onClick={joinRoom} disabled={busy}>
              {t("room.joinBtn")}
            </button>
          </div>

          <div className="card p-5">
            <p className="panel-title mb-3">{t("room.recent")}</p>
            {recents.length === 0 && <p className="text-[13px] text-[var(--c-faint)]">{t("room.noRecent")}</p>}
            <div className="space-y-2">
              {recents.map((r) => (
                <button
                  key={r.number + r.code}
                  className="w-full flex items-center gap-3 rounded-lg border border-[var(--c-line)] bg-[var(--c-bg2)] px-3.5 py-2.5 hover:border-[var(--c-line2)] hover:translate-x-1 transition-all text-left"
                  onClick={() => {
                    setJoinNum(r.number);
                    setJoinCode(r.code);
                    void openRoom({ number: r.number, code: r.code }, false);
                  }}
                >
                  <span className="font-mono font-700 text-[14px]">№{r.number}</span>
                  <span className="font-mono text-[13px] text-[var(--c-amber)]">{r.code}</span>
                  <span className="ml-auto font-mono text-[10px] text-[var(--c-faint)]">
                    {new Date(r.ts).toLocaleDateString("uk-UA")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
