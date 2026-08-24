import { useCallback, useEffect, useRef, useState } from "react";
import { makePeer, roomId as genRoomId, simulateMatch, type Peer } from "../lib/sim";
import { makeCanvasStream, type CanvasCtl, type LocalMedia } from "../lib/rtc";
import { useI18n } from "../i18n";
import {
  IconClose,
  IconCopy,
  IconLink,
  IconPlus,
  IconRefresh,
  IconRooms,
  IconUserPlus,
} from "./icons";

type Guest = { peer: Peer; ctl: CanvasCtl; stream: MediaStream };
type Room = { id: string; name: string; seats: number; guests: Guest[]; admin: boolean };
type Recent = { id: string; name: string };

type Props = {
  localMedia: LocalMedia | null;
  ensureLocal: () => Promise<LocalMedia>;
  onToast: (msg: string, kind?: "ok" | "warn") => void;
  initialJoin?: string | null;
};

const RECENT_KEY = "viche:rooms";
const loadRecent = (): Recent[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
};

export default function Rooms({ localMedia, ensureLocal, onToast, initialJoin }: Props) {
  const { t } = useI18n();
  const [room, setRoom] = useState<Room | null>(null);
  const [name, setName] = useState("");
  const [seats, setSeats] = useState(4);
  const [joinId, setJoinId] = useState("");
  const [joinErr, setJoinErr] = useState(false);
  const [recent, setRecent] = useState<Recent[]>(loadRecent);
  const [searching, setSearching] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [friendId, setFriendId] = useState("");
  const [inviting, setInviting] = useState(false);
  const [burstId, setBurstId] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({});
  const [activity, setActivity] = useState<string[]>([]);
  const localRef = useRef<HTMLVideoElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (initialJoin) setJoinId(initialJoin);
  }, [initialJoin]);

  /* локальне відео у плитці */
  useEffect(() => {
    const v = localRef.current;
    if (v && localMedia?.isReal) {
      v.srcObject = localMedia.stream;
      v.play().catch(() => {});
    }
  }, [localMedia, room]);

  /* індикатори мовлення гостей */
  useEffect(() => {
    if (!room) return;
    const iv = window.setInterval(() => {
      const map: Record<string, boolean> = {};
      room.guests.forEach((g) => {
        const s = Math.random() > 0.5;
        map[g.peer.id] = s;
        g.ctl.setSpeaking(s);
      });
      setSpeaking(map);
    }, 2300);
    return () => window.clearInterval(iv);
  }, [room]);

  const saveRecent = (r: Recent) => {
    setRecent((prev) => {
      const next = [r, ...prev.filter((x) => x.id !== r.id)].slice(0, 5);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* noop */
      }
      return next;
    });
  };
  const log = (s: string) => setActivity((a) => [...a.slice(-6), s]);

  const createRoom = async () => {
    await ensureLocal();
    const id = genRoomId();
    setRoom({ id, name: name.trim() || "Viche Room", seats, guests: [], admin: true });
    saveRecent({ id, name: name.trim() || "Viche Room" });
    setActivity([]);
    log(`${t("room.youAdmin")} · ${id}`);
  };

  const joinRoom = async (idRaw: string) => {
    const id = idRaw.trim().toUpperCase();
    if (!/^VCH-[0-9A-F]{6}$/.test(id)) {
      setJoinErr(true);
      window.setTimeout(() => setJoinErr(false), 600);
      return;
    }
    await ensureLocal();
    setRoom({ id, name: "Room " + id.slice(4), seats: 4, guests: [], admin: false });
    saveRecent({ id, name: "Room " + id.slice(4) });
    setActivity([]);
    log(`${t("room.enter")} → ${id}`);
  };

  const stopGuests = (r: Room | null) => r?.guests.forEach((g) => g.ctl.close());

  const leaveRoom = () => {
    stopGuests(room);
    setRoom(null);
    setSearching(false);
  };

  const spawnGuest = useCallback((peer?: Peer): Guest => {
    const p = peer ?? makePeer();
    const ctl = makeCanvasStream(p.name.split("_")[1] ?? "GG", p.hue);
    return { peer: p, ctl, stream: ctl.stream };
  }, []);

  const addRandom = async () => {
    if (!room || searching) return;
    if (room.guests.length >= room.seats - 1) {
      onToast(`${room.seats - 1} ${t("room.guests")} max`, "warn");
      return;
    }
    setSearching(true);
    log(t("room.searching"));
    await simulateMatch({ gender: "any", lang: "uk", tags: [] }, true);
    if (!alive.current) return;
    const g = spawnGuest();
    setRoom((r) => (r ? { ...r, guests: [...r.guests, g] } : r));
    log(`${g.peer.name} ${t("room.guestJoined")}`);
    setSearching(false);
  };

  const kick = (id: string) => {
    setRoom((r) => {
      if (!r) return r;
      const g = r.guests.find((x) => x.peer.id === id);
      g?.ctl.close();
      if (g) log(`${g.peer.name} ${t("room.guestLeft")}`);
      return { ...r, guests: r.guests.filter((x) => x.peer.id !== id) };
    });
  };

  const replace = async (id: string) => {
    if (searching) return;
    setBurstId(id);
    window.setTimeout(() => setBurstId(null), 480);
    kick(id);
    setSearching(true);
    log(t("room.searching"));
    await simulateMatch({ gender: "any", lang: "uk", tags: [] }, true);
    if (!alive.current) return;
    const g = spawnGuest();
    setRoom((r) => (r ? { ...r, guests: [...r.guests, g] } : r));
    log(`${g.peer.name} ${t("room.guestJoined")}`);
    setSearching(false);
  };

  const inviteFriend = () => {
    if (!room || inviting) return;
    const raw = friendId.trim().toUpperCase().replace(/^VCH-/, "");
    const p = makePeer({ name: raw ? "Гість_" + raw.slice(-4) : undefined, id: raw.slice(-6) || undefined });
    setInviting(true);
    log(t("room.invSent") + (raw ? ` → ${p.name}` : ""));
    window.setTimeout(() => {
      if (!alive.current) return;
      const g = spawnGuest(p);
      setRoom((r) => {
        if (!r) return r;
        if (r.guests.length >= r.seats - 1) return r;
        return { ...r, guests: [...r.guests, g] };
      });
      log(`${p.name} ${t("room.guestJoined")}`);
      setInviting(false);
      setFriendId("");
    }, 2400);
  };

  const copyLink = async () => {
    if (!room) return;
    const url = `${location.origin}${location.pathname}?room=${room.id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    onToast(t("toast.copied"), "ok");
  };

  /* ── Екран кімнати ── */
  if (room) {
    const freeSeats = room.seats - 1 - room.guests.length;
    return (
      <div className="card overflow-hidden fadeup">
        <div className="flex flex-wrap items-center gap-3 px-4 sm:px-5 py-3.5 border-b border-[var(--c-line)] bg-[var(--c-panel)]">
          <span className="led led-mint" />
          <div className="min-w-0">
            <h2 className="font-display font-700 text-lg leading-tight truncate">{room.name}</h2>
            <p className="font-mono text-[11px] text-[var(--c-dim)]">
              {t("room.live")} · {room.guests.length}/{room.seats - 1} {t("room.guests")}
              {room.admin && <span className="text-[var(--c-amber)]"> · {t("room.youAdmin")}</span>}
            </p>
          </div>
          <span className="tick-id text-[12px]">{room.id}</span>
          <div className="ml-auto flex items-center gap-2">
            <button className="btn" onClick={copyLink}>
              <IconLink className="w-4 h-4" /> <span className="hidden sm:inline">{t("room.copyLink")}</span>
            </button>
            <button className="btn" onClick={() => setInviteOpen(true)}>
              <IconUserPlus className="w-4 h-4" /> <span className="hidden sm:inline">{t("room.invite")}</span>
            </button>
            <button className="btn btn-red" onClick={leaveRoom}>
              {t("room.leave")}
            </button>
          </div>
        </div>

        <div className="p-4 sm:p-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {/* своя плитка */}
          <div className="relative aspect-video rounded-xl overflow-hidden border border-[var(--c-line2)] bg-[var(--c-bg2)] group">
            {localMedia?.isReal ? (
              <video ref={localRef} autoPlay playsInline muted className="w-full h-full object-cover -scale-x-100" />
            ) : (
              <div className="w-full h-full grid place-items-center">
                <span className="font-display text-3xl text-[var(--c-amber)]">TI</span>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 px-3 py-2 bg-gradient-to-t from-black/70 to-transparent flex items-center gap-2">
              <span className="led led-mint" />
              <span className="font-mono text-[11px] tracking-widest text-white">{t("video.you")} · {t("room.admin")}</span>
            </div>
          </div>

          {/* гості */}
          {room.guests.map((g) => (
            <div key={g.peer.id} className="relative aspect-video rounded-xl overflow-hidden border border-[var(--c-line2)] bg-black group fadeup">
              <GuestVideo stream={g.stream} />
              {burstId === g.peer.id && <div className="absolute inset-0 staticburst opacity-60 z-10 pointer-events-none" />}
              <div className="absolute inset-x-0 bottom-0 px-3 py-2 bg-gradient-to-t from-black/75 to-transparent">
                <div className="flex items-center gap-2">
                  <span className={`led ${speaking[g.peer.id] ? "led-mint" : ""}`} />
                  <span className="font-mono text-[11px] tracking-wide text-white truncate">{g.peer.name}</span>
                  <span className="font-mono text-[10px] text-white/50">{g.peer.ping} ms</span>
                </div>
                <p className="font-mono text-[10px] text-white/45 mt-0.5">{g.peer.tags.map((x) => "#" + x).join(" ")}</p>
              </div>
              {room.admin && (
                <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                  <button
                    className="grid place-items-center w-8 h-8 rounded-lg bg-[color-mix(in_srgb,var(--c-bg)_75%,transparent)] backdrop-blur border border-[var(--c-line)] text-[var(--c-amber)] hover:border-[var(--c-amber)] transition-colors"
                    title={t("room.replace")}
                    onClick={() => replace(g.peer.id)}
                  >
                    <IconRefresh className="w-4 h-4" />
                  </button>
                  <button
                    className="grid place-items-center w-8 h-8 rounded-lg bg-[color-mix(in_srgb,var(--c-bg)_75%,transparent)] backdrop-blur border border-[var(--c-line)] text-[var(--c-red)] hover:border-[var(--c-red)] transition-colors"
                    title={t("room.kick")}
                    onClick={() => kick(g.peer.id)}
                  >
                    <IconClose className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* пошук гостя */}
          {searching && (
            <div className="relative aspect-video rounded-xl overflow-hidden border border-[var(--c-mint)] bg-[var(--c-bg2)] grid place-items-center">
              <div className="absolute w-40 h-40 rounded-full radar-sweep opacity-60" />
              <p className="relative font-mono text-[12px] text-[var(--c-mint)] caret">{t("room.searching")}</p>
            </div>
          )}

          {/* Add Random */}
          {!searching && room.admin && freeSeats > 0 && (
            <button
              onClick={addRandom}
              className="aspect-video rounded-xl border-2 border-dashed border-[var(--c-line2)] hover:border-[var(--c-amber)] bg-[var(--c-bg2)] hover:bg-[color-mix(in_srgb,var(--c-amber)_7%,var(--c-bg2))] transition-all grid place-items-center group/add"
            >
              <span className="flex flex-col items-center gap-2 text-[var(--c-dim)] group-hover/add:text-[var(--c-amber)] transition-colors">
                <IconPlus className="w-7 h-7" />
                <span className="font-700 text-[14px]">{t("room.addRandom")}</span>
                <span className="font-mono text-[10px] opacity-70">roulette pool → room</span>
              </span>
            </button>
          )}

          {/* вільні місця */}
          {!searching &&
            Array.from({ length: Math.max(0, freeSeats - (room.admin ? 1 : 0)) }).map((_, i) => (
              <div key={i} className="aspect-video rounded-xl border border-[var(--c-line)] bg-[var(--c-bg2)] grid place-items-center">
                <span className="font-mono text-[11px] text-[var(--c-faint)]">seat {room.guests.length + i + 2} · empty</span>
              </div>
            ))}
        </div>

        <div className="px-4 sm:px-5 pb-4">
          <div className="rounded-lg border border-[var(--c-line)] bg-[var(--c-bg2)] px-3.5 py-2.5 font-mono text-[11px] text-[var(--c-dim)] space-y-1">
            {activity.map((a, i) => (
              <p key={i} className="logline">
                <span className="text-[var(--c-mint)]">▸</span> {a}
              </p>
            ))}
          </div>
        </div>

        {inviteOpen && (
          <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-[color-mix(in_srgb,var(--c-bg)_72%,transparent)] backdrop-blur-[3px]" onClick={() => setInviteOpen(false)}>
            <div className="card w-full max-w-md p-6 shadow-[var(--c-shadow)] fadeup" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-display font-700 text-lg">{t("room.invite")}</h3>
                <button className="text-[var(--c-faint)] hover:text-[var(--c-text)]" onClick={() => setInviteOpen(false)}>
                  <IconClose className="w-5 h-5" />
                </button>
              </div>
              <p className="text-[13px] text-[var(--c-dim)] mb-4">{t("room.inviteSub")}</p>
              <div className="flex items-center gap-2 rounded-xl border border-[var(--c-line2)] bg-[var(--c-bg2)] px-3.5 py-3">
                <IconLink className="w-4 h-4 text-[var(--c-amber)] flex-none" />
                <span className="font-mono text-[12px] truncate flex-1">{location.origin + location.pathname}?room={room.id}</span>
                <button className="btn btn-icon !p-2" onClick={copyLink} title={t("room.copyLink")}>
                  <IconCopy className="w-4 h-4" />
                </button>
              </div>
              <p className="panel-title mt-5 mb-2">{t("room.inviteById")}</p>
              <div className="flex gap-2">
                <input
                  className="input font-mono"
                  placeholder="7F3K9Q"
                  value={friendId}
                  onChange={(e) => setFriendId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && inviteFriend()}
                  disabled={inviting}
                />
                <button className="btn btn-mint" onClick={inviteFriend} disabled={inviting}>
                  {inviting ? "…" : t("room.sendInvite")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ── Екран списку / створення ── */
  return (
    <div className="fadeup">
      <div className="max-w-2xl mb-6">
        <h1 className="font-display font-900 text-2xl sm:text-4xl tracking-tight">{t("room.title")}</h1>
        <p className="mt-2.5 text-[15px] text-[var(--c-dim)] leading-relaxed">{t("room.sub")}</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4 items-start">
        <div className="card p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-5">
            <span className="grid place-items-center w-10 h-10 rounded-xl bg-[color-mix(in_srgb,var(--c-amber)_15%,transparent)] text-[var(--c-amber)]">
              <IconRooms className="w-5 h-5" />
            </span>
            <h2 className="font-display font-700 text-lg">{t("room.create")}</h2>
          </div>
          <label className="panel-title block mb-2">{t("room.name")}</label>
          <input className="input mb-4" placeholder={t("room.namePh")} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="panel-title block mb-2">{t("room.seats")}</label>
          <div className="flex gap-2 mb-5">
            {[2, 3, 4, 6].map((s) => (
              <button key={s} className={`chip !px-4 font-mono ${seats === s ? "chip-on" : ""}`} onClick={() => setSeats(s)}>
                {s}
              </button>
            ))}
          </div>
          <button className="btn btn-amber w-full !py-3" onClick={createRoom}>
            <IconPlus className="w-5 h-5" /> {t("room.createBtn")}
          </button>
          <p className="mt-3 font-mono text-[11px] text-[var(--c-faint)]">id: VCH-XXXXXX · redis: room:{`{id}`} → peers[]</p>
        </div>

        <div className="space-y-4">
          <div className="card p-5 sm:p-6">
            <h2 className="font-display font-700 text-lg mb-4">{t("room.join")}</h2>
            <div className="flex gap-2">
              <input
                className={`input font-mono uppercase ${joinErr ? "shake !border-[var(--c-red)]" : ""}`}
                placeholder={t("room.idPh")}
                value={joinId}
                onChange={(e) => setJoinId(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && joinRoom(joinId)}
              />
              <button className="btn btn-mint" onClick={() => joinRoom(joinId)}>
                {t("room.joinBtn")}
              </button>
            </div>
            {joinErr && <p className="mt-2 text-[12px] font-600 text-[var(--c-red)] fadeup">{t("room.invalid")}</p>}
          </div>

          <div className="card p-5 sm:p-6">
            <p className="panel-title mb-3">{t("room.recent")}</p>
            {recent.length === 0 ? (
              <p className="text-[13px] text-[var(--c-faint)] italic">{t("room.noRecent")}</p>
            ) : (
              <ul className="space-y-2">
                {recent.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 rounded-lg border border-[var(--c-line)] bg-[var(--c-bg2)] px-3.5 py-2.5">
                    <span className="led led-mint" />
                    <span className="font-600 text-[14px] truncate flex-1">{r.name}</span>
                    <span className="tick-id text-[11px]">{r.id}</span>
                    <button className="btn !py-1.5 !px-3 !text-[12px]" onClick={() => joinRoom(r.id)}>
                      {t("room.enter")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GuestVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (v) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className="w-full h-full object-cover" />;
}
