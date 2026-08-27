import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RoomNet, type Member, type RoomStatus } from "../lib/roomnet";
import { RouletteNet } from "../lib/roulettenet";
import { RoomStreamCompositor, StreamRelay, type RoomSource } from "../lib/relay";
import {
  filterProfanity,
  makeRoomId,
  now,
  roomLink,
  roomIdStr,
  shortId,
  type RoomId,
} from "../lib/sim";
import type { FacingMode, LocalMedia } from "../lib/rtc";
import { enterFullscreen, exitFullscreen, isNativeFullscreen } from "../lib/fullscreen";
import { useI18n } from "../i18n";
import { useScramble } from "../lib/hooks";
import {
  IconCam,
  IconCamOff,
  IconCheck,
  IconClose,
  IconCopy,
  IconEnd,
  IconExitFull,
  IconFull,
  IconLink,
  IconMic,
  IconMicOff,
  IconPlus,
  IconRooms,
  IconSend,
  IconSwitchCamera,
  IconUserPlus,
} from "./icons";

/* Випадковий гість — РЕАЛЬНА людина, знайдена мисливцем у глобальному
   пулі рулетки (RouletteNet). Жодних ботів. */
type Hunter = { id: string; name: string; stream: MediaStream; net: RouletteNet; relay?: StreamRelay };
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

/* Зберігається ВИКЛЮЧНО остання кімната */
const loadRecent = (): StoredRoom[] => {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredRoom[];
    return Array.isArray(list) ? list.slice(0, 1) : [];
  } catch {
    return [];
  }
};

const saveRecent = (r: RoomId) => {
  try {
    const list: StoredRoom[] = [{ number: r.number, code: r.code, ts: Date.now() }];
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* noop */
  }
};

/* ── Плитка відео: 4:3 для горизонтального, 3:4 для вертикального, без обрізки (або fillHeight для повноекранного режиму 2 людей) ── */
function Tile({
  stream,
  name,
  badge,
  badgeTone = "mint",
  muted,
  micOn,
  camOn,
  live,
  isSelf,
  facingMode = "user",
  onSwitchCam,
  switchingCam,
  switchCamLabel,
  onKick,
  kickLabel,
  fillHeight,
}: {
  stream: MediaStream;
  name: string;
  badge?: string;
  badgeTone?: "mint" | "amber" | "faint";
  muted?: boolean;
  micOn?: boolean;
  camOn?: boolean;
  /** пульсуючий live-індикатор у бейджі (рельатрансляція) */
  live?: boolean;
  isSelf?: boolean;
  facingMode?: "user" | "environment";
  onSwitchCam?: () => void;
  switchingCam?: boolean;
  switchCamLabel?: string;
  onKick?: () => void;
  kickLabel?: string;
  fillHeight?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [trackMuted, setTrackMuted] = useState(false);
  const [videoTrackMuted, setVideoTrackMuted] = useState(false);

  useEffect(() => {
    const audio = stream?.getAudioTracks?.()[0];
    if (!audio) {
      setTrackMuted(false);
      return;
    }
    setTrackMuted(!audio.enabled || audio.muted);
    const onM = () => setTrackMuted(true);
    const onU = () => setTrackMuted(false);
    audio.addEventListener("mute", onM);
    audio.addEventListener("unmute", onU);
    audio.addEventListener("ended", onM);
    return () => {
      audio.removeEventListener("mute", onM);
      audio.removeEventListener("unmute", onU);
      audio.removeEventListener("ended", onM);
    };
  }, [stream]);

  useEffect(() => {
    const video = stream?.getVideoTracks?.()[0];
    if (!video) {
      setVideoTrackMuted(false);
      return;
    }
    setVideoTrackMuted(!video.enabled || video.muted);
    const onM = () => setVideoTrackMuted(true);
    const onU = () => setVideoTrackMuted(false);
    video.addEventListener("mute", onM);
    video.addEventListener("unmute", onU);
    video.addEventListener("ended", onM);
    return () => {
      video.removeEventListener("mute", onM);
      video.removeEventListener("unmute", onU);
      video.removeEventListener("ended", onM);
    };
  }, [stream]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (stream) {
      if (v.srcObject !== stream) {
        v.srcObject = stream;
      }
      const playPromise = v.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {});
      }
    } else {
      v.srcObject = null;
    }
  }, [stream]);
  const tone =
    badgeTone === "mint"
      ? "text-[var(--c-mint)] border-[color-mix(in_srgb,var(--c-mint)_45%,transparent)]"
      : badgeTone === "amber"
        ? "text-[var(--c-amber)] border-[color-mix(in_srgb,var(--c-amber)_45%,transparent)]"
        : "text-[var(--c-faint)] border-[var(--c-line2)]";

  const effectiveMicOn = typeof micOn === "boolean" ? micOn : !trackMuted;
  const effectiveCamOn = typeof camOn === "boolean" ? camOn : !videoTrackMuted;

  return (
    <div
      className={`group relative w-full ${
        fillHeight
          ? "h-full min-h-0 flex-1"
          : "aspect-[16/10] sm:aspect-[16/9] min-h-[160px]"
      } rounded-xl overflow-hidden border border-[var(--c-line)] bg-black`}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className={`absolute inset-0 w-full h-full object-contain ${
          isSelf && facingMode !== "environment" ? "-scale-x-100" : "scale-x-100"
        }`}
      />
      {!effectiveCamOn && (
        <div className="absolute inset-0 bg-[var(--c-bg)] grid place-items-center z-[5]">
          <IconCamOff className="w-7 h-7 sm:w-9 sm:h-9 text-[var(--c-faint)]" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-2.5 sm:px-3 py-1.5 sm:py-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent z-10 pointer-events-none">
        <span className="text-[12.5px] sm:text-[13px] font-700 text-white truncate max-w-[calc(100%-70px)]">{name}</span>
        <div className="flex items-center gap-1.5 flex-none">
          <span
            className={`inline-flex items-center justify-center p-1 rounded-md border backdrop-blur-sm ${
              effectiveMicOn
                ? "text-emerald-400 border-emerald-500/40 bg-emerald-950/60 shadow-[0_0_8px_rgba(52,211,153,0.3)]"
                : "text-rose-400 border-rose-500/40 bg-rose-950/60 shadow-[0_0_8px_rgba(244,63,94,0.3)]"
            }`}
            title={effectiveMicOn ? "Мікрофон увімкнено" : "Мікрофон вимкнено"}
          >
            {effectiveMicOn ? (
              <IconMic className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <IconMicOff className="w-3.5 h-3.5 text-rose-400" />
            )}
          </span>
          <span
            className={`inline-flex items-center justify-center p-1 rounded-md border backdrop-blur-sm ${
              effectiveCamOn
                ? "text-emerald-400 border-emerald-500/40 bg-emerald-950/60 shadow-[0_0_8px_rgba(52,211,153,0.3)]"
                : "text-rose-400 border-rose-500/40 bg-rose-950/60 shadow-[0_0_8px_rgba(244,63,94,0.3)]"
            }`}
            title={effectiveCamOn ? "Камера увімкнена" : "Камера вимкнена"}
          >
            {effectiveCamOn ? (
              <IconCam className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <IconCamOff className="w-3.5 h-3.5 text-rose-400" />
            )}
          </span>
        </div>
      </div>
      {badge && (
        <span className={`absolute top-2 left-2 font-mono text-[10px] px-2 py-0.5 rounded-md border bg-black/55 backdrop-blur-sm flex items-center gap-1.5 z-10 ${tone}`}>
          {live && <span className="w-1.5 h-1.5 rounded-full bg-current animate-[vblink_1.4s_ease-in-out_infinite]" />}
          {badge}
        </span>
      )}
      {onSwitchCam && (
        <button
          type="button"
          className="absolute top-2 right-2 z-20 p-1.5 rounded-lg bg-black/60 hover:bg-[var(--c-amber)] hover:text-black backdrop-blur-md border border-[var(--c-line2)] text-[var(--c-amber)] transition-all shadow-md active:scale-90"
          onClick={(e) => {
            e.stopPropagation();
            onSwitchCam();
          }}
          disabled={switchingCam}
          title={switchCamLabel || "Switch camera"}
          aria-label={switchCamLabel || "Switch camera"}
        >
          <IconSwitchCamera className={`w-4 h-4 ${switchingCam ? "animate-spin" : ""}`} />
        </button>
      )}
      {onKick && (
        <button
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity grid place-items-center w-8 h-8 rounded-lg bg-black/60 border border-[color-mix(in_srgb,var(--c-red)_55%,transparent)] text-[var(--c-red)] hover:bg-[color-mix(in_srgb,var(--c-red)_18%,black)] z-20"
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
  const [isFull, setIsFull] = useState(false);
  const [isPortrait, setIsPortrait] = useState(() => {
    if (typeof window === "undefined") return false;
    const isTall = window.innerHeight >= window.innerWidth || window.innerWidth < 640;
    const matchMediaPortrait = window.matchMedia?.("(orientation: portrait)")?.matches;
    return isTall || matchMediaPortrait === true;
  });

  useEffect(() => {
    const updateOrient = () => {
      const isTall = window.innerHeight >= window.innerWidth || window.innerWidth < 640;
      const matchMediaPortrait = window.matchMedia?.("(orientation: portrait)")?.matches;
      setIsPortrait(isTall || matchMediaPortrait === true);
    };
    updateOrient();
    window.addEventListener("resize", updateOrient);
    window.addEventListener("orientationchange", updateOrient);
    const mq = window.matchMedia?.("(orientation: portrait)");
    mq?.addEventListener?.("change", updateOrient);
    return () => {
      window.removeEventListener("resize", updateOrient);
      window.removeEventListener("orientationchange", updateOrient);
      mq?.removeEventListener?.("change", updateOrient);
    };
  }, []);

  const [micOn, setMicOn] = useState(true);
  const [peerMics, setPeerMics] = useState<Record<string, boolean>>({});
  const [camOn, setCamOn] = useState(true);
  const [peerCams, setPeerCams] = useState<Record<string, boolean>>({});
  const [facingMode, setFacingMode] = useState<FacingMode>(localMedia?.facingMode ?? "user");
  const [selfStream, setSelfStream] = useState<MediaStream | null>(localMedia?.stream ?? null);
  const [switchingCam, setSwitchingCam] = useState(false);
  const roomBoxRef = useRef<HTMLDivElement>(null);
  const compositorRef = useRef<RoomStreamCompositor | null>(null);
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

  const [guestOrient, setGuestOrient] = useState<"land" | "port" | null>(null);
  const guestOrientRef = useRef<"land" | "port" | null>(null);
  useEffect(() => {
    guestOrientRef.current = guestOrient;
  }, [guestOrient]);

  // Джерела відео та аудіо кімнати для компонування гостю з рулетки (1 або 2 людини)
  const currentSources = useMemo<RoomSource[]>(() => {
    const list: RoomSource[] = [];
    const myId = netRef.current?.myId || "";
    const myStream = selfStream || localMedia?.stream;
    if (myStream) {
      list.push({
        id: myId || "host",
        name: name.trim() || t("room.you"),
        stream: myStream,
        isSelf: true,
        facingMode,
      });
    }
    // Додаємо інших регулярних учасників кімнати (до 2 осіб у композиції)
    for (const m of roster) {
      if (m.id !== myId && streams[m.id]) {
        list.push({
          id: m.id,
          name: m.name,
          stream: streams[m.id],
          isSelf: false,
          facingMode: "user",
        });
      }
    }
    return list.slice(0, 2);
  }, [roster, streams, selfStream, localMedia, facingMode, name, t]);

  // Оновлюємо композитор у реальному часі при зміні учасників, потоків або орієнтації гостя рулетки
  useEffect(() => {
    const isPort = guestOrient ? guestOrient === "port" : isPortrait;
    if (compositorRef.current) {
      compositorRef.current.setPortrait(isPort);
      compositorRef.current.updateSources(currentSources, isPort);
    }
    const currentOrient = isPortrait ? "port" : "land";
    for (const h of huntersRef.current) {
      h.net?.sendOrientation(currentOrient);
    }
    pendingHunter.current?.sendOrientation(currentOrient);
  }, [currentSources, isPortrait, guestOrient]);

  const toggleMic = () => {
    setMicOn((v) => {
      const next = !v;
      const s = selfStream || localMedia?.stream;
      s?.getAudioTracks().forEach((tr) => (tr.enabled = next));
      netRef.current?.sendMic(next);
      return next;
    });
  };
  const toggleCam = () => {
    setCamOn((v) => {
      const next = !v;
      const s = selfStream || localMedia?.stream;
      s?.getVideoTracks().forEach((tr) => (tr.enabled = next));
      netRef.current?.sendCam(next);
      return next;
    });
  };

  const handleSwitchCam = async () => {
    if (!localMedia?.isReal || !localMedia?.switchCamera || switchingCam) return;
    setSwitchingCam(true);
    try {
      const res = await localMedia.switchCamera();
      setFacingMode(res.facingMode);
      setSelfStream(res.stream);
      onToast(res.facingMode === "environment" ? t("video.camBack") : t("video.camFront"), "ok");
      if (netRef.current) {
        netRef.current.updateStream(res.stream, res.videoTrack);
      }
    } catch {
      onToast(t("toast.noMultiCam"), "warn");
    } finally {
      setSwitchingCam(false);
    }
  };

  /* відстеження повноекранного режиму */
  useEffect(() => {
    const onFsChange = () => {
      setIsFull(isNativeFullscreen());
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFull) {
        void exitFullscreen();
        setIsFull(false);
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    document.addEventListener("mozfullscreenchange", onFsChange);
    document.addEventListener("MSFullscreenChange", onFsChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      document.removeEventListener("mozfullscreenchange", onFsChange);
      document.removeEventListener("MSFullscreenChange", onFsChange);
      window.removeEventListener("keydown", onKey);
    };
  }, [isFull]);

  const enterFs = async () => {
    setIsFull(true);
    await enterFullscreen(roomBoxRef.current);
  };

  const exitFs = async () => {
    setIsFull(false);
    await exitFullscreen();
  };

  const toggleFullscreen = () => {
    if (isFull) {
      void exitFs();
    } else {
      void enterFs();
    }
  };

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
    huntersRef.current.forEach((h) => {
      h.relay?.dispose();
      h.net.dispose();
    });
    compositorRef.current?.dispose();
    compositorRef.current = null;
    setHunters([]);
    setScreen("home");
    setRoom(null);
    setStatus(null);
    setIceInfo("");
    setRoster([]);
    prevRoster.current = [];
    setStreams({});
    setAuxStreams({});
    setPeerMics({});
    setPeerCams({});
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
        setStatus(asCreator ? "host" : "connecting");
        setMsgs([]);
        const effectiveName = name.trim() || "Гість_" + shortId(4);
        const hostId = "viche-v1-r-" + roomIdStr(r);
        const initialMember: Member = { id: asCreator ? hostId : "self", name: effectiveName };
        prevRoster.current = [initialMember];
        setRoster([initialMember]);
        setStreams({});
        setAuxStreams({});
        setPeerMics({});
        setPeerCams({});
        saveRecent(r);
        setRecents(loadRecent());
        const net = new RoomNet(
          r,
          name.trim() || "Гість_" + shortId(4),
          lm.stream,
          seats,
          {
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
            onPeerMic: (pid, on) => aliveRef.current && setPeerMics((m) => ({ ...m, [pid]: on })),
            onPeerCam: (pid, on) => aliveRef.current && setPeerCams((m) => ({ ...m, [pid]: on })),
            onPeerGone: (pid) =>
              aliveRef.current &&
              (setStreams((st) => {
                const cp = { ...st };
                delete cp[pid];
                return cp;
              }),
              setPeerMics((m) => {
                const cp = { ...m };
                delete cp[pid];
                return cp;
              }),
              setPeerCams((m) => {
                const cp = { ...m };
                delete cp[pid];
                return cp;
              })),
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
          },
          asCreator
        );
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
    // Випадкового користувача з рулетки можна підключити ТІЛЬКИ якщо кімната на 2 або 3 людей
    if (seats > 3) {
      onToast(t("room.noRandomForLargeRooms"), "warn");
      return;
    }
    if (roster.length + hunters.length >= seats) {
      onToast(`${t("room.seats")}: ${seats}`, "warn");
      return;
    }
    const lm = await ensureLocal();
    if (!aliveRef.current) return;
    setSearching(true);

    // Ініціалізуємо або оновлюємо композитор кімнати (потоки 1 або 2 людей)
    const effectiveIsPort = guestOrientRef.current ? guestOrientRef.current === "port" : isPortrait;
    if (!compositorRef.current) {
      compositorRef.current = new RoomStreamCompositor(currentSources, effectiveIsPort);
    } else {
      compositorRef.current.updateSources(currentSources, effectiveIsPort);
    }
    const outboundStream = compositorRef.current.compositeStream;

    const hunter = new RouletteNet(
      outboundStream,
      {
        onState: () => {},
        onSlot: () => {},
        onOrientChange: (guestOrientation) => {
          if (!aliveRef.current) return;
          guestOrientRef.current = guestOrientation;
          setGuestOrient(guestOrientation);
          const isPort = guestOrientation === "port";
          if (compositorRef.current) {
            compositorRef.current.setPortrait(isPort);
            compositorRef.current.updateSources(currentSources, isPort);
          }
        },
        onPair: (stream, peerId) => {
          if (!aliveRef.current) return;
          pendingHunter.current = null;
          const tail = peerId.replace(/[^0-9]/g, "") || peerId.slice(-3);
          const name = "Гість_" + tail;

          // Якщо орієнтація гостя вже відома або оновлена — підлаштовуємо композитор
          if (guestOrientRef.current && compositorRef.current) {
            const isPort = guestOrientRef.current === "port";
            compositorRef.current.setPortrait(isPort);
            compositorRef.current.updateSources(currentSources, isPort);
          }

          // Створюємо або оновлюємо чистий ретрансляційний потік
          const prevH = huntersRef.current.find((h) => h.id === peerId || h.net === hunter);
          let relayInstance: StreamRelay;
          if (prevH?.relay) {
            prevH.relay.updateSource(stream);
            relayInstance = prevH.relay;
          } else {
            relayInstance = new StreamRelay(stream);
          }

          // upsert: подія "stream" може повторитись (ICE restart) — не
          // додаємо дублікат, а оновлюємо потік того самого гостя
          setHunters((hs) => {
            const exists = hs.some((h) => h.net === hunter || h.id === peerId);
            if (exists) {
              return hs.map((h) => (h.net === hunter || h.id === peerId ? { ...h, stream, relay: relayInstance } : h));
            }
            return [...hs, { id: peerId, name, stream, net: hunter, relay: relayInstance }];
          });
          // головне: хост ретранслює стабільний локальний потік випадкового гостя ВСІМ учасникам
          netRef.current?.shareAuxStream(peerId, name, relayInstance.relayedStream);
          push("sys", `${name} ${t("room.guestJoined")} · ${t("room.randomBadge")}`);
          setSearching(false);
        },
        onPeerLeft: () => {
          if (!aliveRef.current) return;
          guestOrientRef.current = null;
          setGuestOrient(null);
          const gone = huntersRef.current.find((h) => h.net === hunter);
          if (gone) {
            gone.relay?.dispose();
            netRef.current?.stopShareAuxStream(gone.id);
          }
          setHunters((hs) => {
            const next = hs.filter((h) => h.net !== hunter);
            if (next.length === 0) {
              compositorRef.current?.dispose();
              compositorRef.current = null;
            }
            return next;
          });
          hunter.dispose();
          push("sys", t("room.guestLeft"));
        },
        onIce: () => {},
      },
      isPortrait ? "port" : "land"
    );
    pendingHunter.current = hunter;
    hunter.search({ gender: "any", lang: "any", tags: [] });
  };

  const kickHunter = (id: string) => {
    const h = huntersRef.current.find((x) => x.id === id);
    if (!h) return;
    h.relay?.dispose();
    h.net.dispose();
    netRef.current?.stopShareAuxStream(id); // прибираємо з екранів усіх учасників
    push("sys", `${h.name} ${t("room.guestLeft")}`);
    setHunters((hs) => {
      const next = hs.filter((x) => x.id !== id);
      if (next.length === 0) {
        compositorRef.current?.dispose();
        compositorRef.current = null;
      }
      return next;
    });
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
  const filled = roster.length + hunters.length + (isHost ? 0 : Object.keys(auxStreams).length);

  /* ── Екран кімнати ── */
  if (screen === "room" && room) {
    return (
      <div
        ref={roomBoxRef}
        className={
          isFull
            ? "fixed inset-0 z-[9999] w-screen h-[100dvh] bg-black overflow-y-auto p-3 sm:p-6 pt-[env(safe-area-inset-top,12px)] pb-[calc(env(safe-area-inset-bottom,12px)+24px)] flex flex-col select-none"
            : "fadeup"
        }
      >
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 sm:mb-5">
          <div className="min-w-0">
            <p className="panel-title text-[10px] sm:text-[11px]">{t("room.live")}</p>
            <h1 className="font-display font-900 text-lg sm:text-2xl tracking-tight flex items-center gap-2">
              №{room.number}
              <span className="text-[var(--c-amber)]">·</span>
              <span className="text-[var(--c-amber)]">{room.code}</span>
            </h1>
          </div>
          <span
            className={`chip !cursor-default !text-[10.5px] sm:!text-[11px] font-mono !py-1 ${
              status === "host" || status === "guest" ? "chip-on" : ""
            }`}
          >
            {status === "host" ? t("room.sHost") : status === "guest" ? t("room.sGuest") : t("room.sConnecting")}
          </span>
          <span className="chip !cursor-default !text-[10.5px] sm:!text-[11px] font-mono !py-1">
            {filled}/{seats} · {t("room.members").toLowerCase()}
          </span>
          {iceInfo && (
            <span
              className={`chip !cursor-default !text-[10.5px] sm:!text-[11px] font-mono !py-1 ${
                iceInfo.includes("relay") ? "chip-on" : ""
              }`}
              title="WebRTC ICE paths (mesh)"
            >
              {iceInfo.includes("relay") ? "turn · " : "ice · "}
              {iceInfo}
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5 sm:gap-2">
            <button
              className={`btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[40px] sm:min-w-[40px] !p-2 transition-all ${
                micOn
                  ? "!text-emerald-400 !border-emerald-500/40 bg-emerald-950/40 hover:bg-emerald-950/60 shadow-[0_0_10px_rgba(52,211,153,0.2)]"
                  : "!text-rose-400 !border-rose-500/50 bg-rose-950/40 hover:bg-rose-950/60 shadow-[0_0_10px_rgba(244,63,94,0.2)]"
              }`}
              onClick={toggleMic}
              title={t("video.mic")}
              aria-label={t("video.mic")}
            >
              {micOn ? <IconMic className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-emerald-400" /> : <IconMicOff className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-rose-400" />}
            </button>
            <button
              className={`btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[40px] sm:min-w-[40px] !p-2 transition-all ${
                camOn
                  ? "!text-emerald-400 !border-emerald-500/40 bg-emerald-950/40 hover:bg-emerald-950/60 shadow-[0_0_10px_rgba(52,211,153,0.2)]"
                  : "!text-rose-400 !border-rose-500/50 bg-rose-950/40 hover:bg-rose-950/60 shadow-[0_0_10px_rgba(244,63,94,0.2)]"
              }`}
              onClick={toggleCam}
              title={t("video.cam")}
              aria-label={t("video.cam")}
            >
              {camOn ? <IconCam className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-emerald-400" /> : <IconCamOff className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-rose-400" />}
            </button>
            <button
              className={`btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[40px] sm:min-w-[40px] !py-2 !px-2.5 sm:!px-3 ${
                isFull
                  ? "!text-[var(--c-amber)] !border-[color-mix(in_srgb,var(--c-amber)_50%,transparent)] bg-[color-mix(in_srgb,var(--c-amber)_15%,transparent)]"
                  : ""
              }`}
              onClick={toggleFullscreen}
              title={isFull ? t("video.exitFull") : t("video.full")}
              aria-label={isFull ? t("video.exitFull") : t("video.full")}
            >
              {isFull ? <IconExitFull className="w-4 h-4 sm:w-4.5 sm:h-4.5" /> : <IconFull className="w-4 h-4 sm:w-4.5 sm:h-4.5" />}
            </button>
            <button className="btn btn-red !py-2 !px-3 sm:!px-4 !text-xs sm:!text-sm min-h-[38px] sm:min-h-[40px]" onClick={leaveRoom}>
              <IconEnd className="w-4 h-4" />
              <span className="hidden sm:inline">{t("room.leave")}</span>
            </button>
          </div>
        </div>

        <div className={`grid ${isFull ? "lg:grid-cols-[minmax(0,1fr)_300px] flex-1 min-h-0" : "lg:grid-cols-[minmax(0,1fr)_330px]"} gap-4 items-start`}>
          {/* ── Сітка учасників (якщо 2 учасники: вертикально — зверху/знизу 50/50, горизонтально — справа/зліва 50/50 як у звичайному, так і у повноекранному режимі) ── */}
          <div className="min-w-0 flex-1 h-full flex flex-col">
            {(() => {
              const hostId = netRef.current?.hostId || ("viche-v1-r-" + roomIdStr(room));
              const myId = netRef.current?.myId;
              const effectiveRoster = roster.length > 0
                ? roster
                : [{ id: isHost ? hostId : "self", name: name.trim() || t("room.you") }];

              const totalTiles = effectiveRoster.length + hunters.length + Object.keys(auxStreams).length;
              const isTwoPeople = totalTiles === 2 || filled === 2;
              const fillTile = isTwoPeople && (isFull || isPortrait);

              const gridLayoutClass = (() => {
                if (isTwoPeople) {
                  if (isPortrait) {
                    // Вертикальна орієнтація: зверху та знизу, рівномірно заповнюючи висоту
                    return isFull
                      ? "grid-cols-1 grid-rows-2 h-[calc(100dvh-130px)] sm:h-[calc(100dvh-150px)] max-h-full w-full"
                      : "grid-cols-1 grid-rows-2 h-[calc(100dvh-220px)] min-h-[480px] max-h-[760px] sm:min-h-[540px] w-full";
                  } else {
                    // Горизонтальна орієнтація: зліва та справа
                    return isFull
                      ? "grid-cols-2 grid-rows-1 portrait:grid-cols-1 portrait:grid-rows-2 h-[calc(100dvh-130px)] sm:h-[calc(100dvh-150px)] max-h-full w-full"
                      : "grid-cols-2 sm:grid-cols-2 portrait:grid-cols-1 portrait:grid-rows-2";
                  }
                }
                if (isFull) {
                  return "grid-cols-1 sm:grid-cols-2";
                }
                if (filled <= 1) {
                  return "grid-cols-1 max-w-xl mx-auto w-full";
                }
                return "grid-cols-1 sm:grid-cols-2";
              })();

              return (
                <div className={`grid gap-2.5 sm:gap-3 ${gridLayoutClass}`}>
                  {/* реальні учасники (mesh P2P) */}
                  {effectiveRoster.map((m) => {
                    const self =
                      (myId ? myId === m.id : false) ||
                      m.id === "self" ||
                      (isHost && (m.id === hostId || m.id === netRef.current?.hostId)) ||
                      (effectiveRoster.length === 1 && !m.id.startsWith("guest_"));
                    const st = self ? (selfStream || localMedia?.stream) : streams[m.id];
                    const memberMic = self ? micOn : (peerMics[m.id] !== undefined ? peerMics[m.id] : undefined);
                    const memberCam = self ? camOn : (peerCams[m.id] !== undefined ? peerCams[m.id] : undefined);
                    const badgeText = self
                      ? (isHost ? `${t("room.you")} · ${t("room.admin")}` : t("room.you"))
                      : (m.id === hostId || m.id === netRef.current?.hostId ? t("room.admin") : "p2p");
                    const displayName = self
                      ? (m.name.includes(t("room.you")) ? m.name : `${m.name} · ${t("room.you")}`)
                      : m.name;

                    return st ? (
                      <Tile
                        key={m.id}
                        stream={st}
                        name={displayName}
                        badge={badgeText}
                        badgeTone={self ? "amber" : "mint"}
                        muted={self}
                        micOn={memberMic}
                        camOn={memberCam}
                        isSelf={self}
                        facingMode={self ? facingMode : "user"}
                        onSwitchCam={self && localMedia?.hasCam ? handleSwitchCam : undefined}
                        switchingCam={switchingCam}
                        switchCamLabel={t("video.switchCam")}
                        onKick={isHost && !self ? () => netRef.current?.kick(m.id) : undefined}
                        kickLabel={t("room.kick")}
                        fillHeight={fillTile}
                      />
                    ) : (
                      <div key={m.id} className="aspect-[4/3] rounded-xl border border-dashed border-[var(--c-line2)] grid place-items-center bg-[var(--c-bg2)]">
                        <p className="font-mono text-[11px] text-[var(--c-faint)] caret">{m.name} · p2p…</p>
                      </div>
                    );
                  })}
                  {/* випадкові гості — реальні люди з пулу рулетки */}
                  {hunters.map((g) => (
                    <div key={g.id} className={`relative ${fillTile ? "h-full min-h-0 flex-1" : ""}`}>
                      <Tile
                        stream={g.stream}
                        name={g.name}
                        badge={t("room.randomBadge")}
                        badgeTone="mint"
                        onKick={isHost ? () => kickHunter(g.id) : undefined}
                        kickLabel={t("room.kick")}
                        fillHeight={fillTile}
                      />
                      {isHost && (
                        <button
                          className="absolute -bottom-2.5 right-3 chip !text-[11px] !py-1 shadow-[var(--c-shadow)] z-20"
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
                      live
                      fillHeight={fillTile}
                    />
                  ))}
                </div>
              );
            })()}

            {isHost && (
              seats <= 3 ? (
                <button className="btn mt-4" onClick={() => void addRandom()} disabled={searching || filled >= seats}>
                  <IconPlus className="w-4 h-4" />
                  {searching ? t("room.searching") : t("room.addRandom")}
                </button>
              ) : (
                <div className="mt-4 p-2.5 sm:p-3 rounded-xl border border-[color-mix(in_srgb,var(--c-red)_35%,transparent)] bg-[color-mix(in_srgb,var(--c-red)_10%,transparent)] flex items-center gap-2">
                  <span className="font-mono text-[11px] text-[var(--c-red)] flex items-center gap-1.5 font-600">
                    <span className="text-[12px] leading-none">✕</span>
                    <span>{t("room.seatsLimitHint")}</span>
                  </span>
                </div>
              )
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
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[11px] text-[var(--c-faint)]">{t("room.seats")}</p>
            {seats <= 3 ? (
              <span className="font-mono text-[10px] text-[var(--c-mint)] flex items-center gap-1">
                <span>✓</span>
                <span>{t("room.seatsLimitHint")}</span>
              </span>
            ) : (
              <span className="font-mono text-[10px] text-[var(--c-red)] flex items-center gap-1 font-600">
                <span>✕</span>
                <span>{t("room.seatsLimitHint")}</span>
              </span>
            )}
          </div>
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
