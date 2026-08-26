import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LANGS, TAGS, makePeer, shortId, type LangCode, type Peer } from "../lib/sim";
import type { LocalMedia } from "../lib/rtc";
import { RouletteNet, type RouletteFilters } from "../lib/roulettenet";
import { useI18n, type DictKey } from "../i18n";
import { useScramble } from "../lib/hooks";
import CaptchaModal, { captchaToken } from "./Captcha";
import VideoChat from "./VideoChat";
import { IconBolt, IconCheck, IconFlag, IconShuffle, LogoMark } from "./icons";

type Phase = "idle" | "captcha" | "searching" | "live";

type Props = {
  localMedia: LocalMedia | null;
  ensureLocal: () => Promise<LocalMedia>;
  releaseMedia: () => void;
  onToast: (msg: string, kind?: "ok" | "warn") => void;
};

const fmtElapsed = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

const LANG_OPTS: Array<LangCode | "any"> = ["any", ...LANGS];

export default function Roulette({ localMedia, ensureLocal, releaseMedia, onToast }: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [filters, setFilters] = useState<RouletteFilters>({ gender: "any", lang: "any", tags: [] });
  const [peer, setPeer] = useState<Peer | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [ice, setIce] = useState("");
  const [orient, setOrient] = useState<"land" | "port">("land");
  const [slot, setSlot] = useState(-1);

  const netRef = useRef<RouletteNet | null>(null);
  const lmRef = useRef(localMedia);
  const liveRef = useRef(true);
  const filtersRef = useRef(filters);
  const tRef = useRef(t);
  const toastRef = useRef(onToast);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  useEffect(() => {
    lmRef.current = localMedia;
    if (localMedia && netRef.current) {
      netRef.current.updateStream(localMedia.stream);
    }
  }, [localMedia]);
  useEffect(() => {
    tRef.current = t;
    toastRef.current = onToast;
  }, [t, onToast]);

  const sessionId = useMemo(() => "SES-" + shortId(4), []);

  /* демонтування: прибираємо мережу повністю */
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      netRef.current?.dispose();
      netRef.current = null;
    };
  }, []);

  /* реальний таймер: йде лише поки триває пошук */
  const busy = phase === "searching";
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  const openNet = useCallback((lm: LocalMedia) => {
    if (netRef.current) {
      netRef.current.updateStream(lm.stream);
      return netRef.current;
    }
    const net = new RouletteNet(lm.stream, {
      onState: (s) => {
        if (!liveRef.current) return;
        // «live» встановлює onPair (коли вже є стрім і партнер)
        if (s === "searching" || s === "connecting") setPhase("searching");
        else if (s === "idle") setPhase("idle");
      },
      onSlot: (sl) => setSlot(sl),
      onPair: (stream, peerId) => {
        if (!liveRef.current) return;
        const tail = peerId.replace(/[^0-9a-zA-Z]/g, "").slice(-4) || shortId(4);
        const p: Peer = {
          ...makePeer({ tags: [], langs: [] }),
          id: tail,
          name: "Учасник_" + tail,
          real: true,
        };
        setPeer(p);
        setRemoteStream(stream);
        setOrient("land");
        setPhase("live");
      },
      onPeerLeft: () => {
        if (!liveRef.current) return;
        setPeer(null);
        setRemoteStream(null);
        setIce("");
        setElapsed(0);
        toastRef.current(tRef.current("toast.peerLeft"), "warn");
        // пошук відновлює сам net — без ботів
      },
      onIce: (i) => setIce(i),
    });
    netRef.current = net;
    return net;
  }, []);

  const beginSearch = useCallback(
    (f: RouletteFilters) => {
      setPeer(null);
      setRemoteStream(null);
      setElapsed(0);
      setOrient("land");
      setIce("");
      setPhase("searching");
      const lm = lmRef.current;
      if (lm) openNet(lm).search(f);
    },
    [openNet]
  );

  const start = async () => {
    try {
      const lm = await ensureLocal();
      lmRef.current = lm;
      if (!captchaToken()) {
        setPhase("captcha");
        return;
      }
      beginSearch(filtersRef.current);
    } catch {
      onToast(t("toast.mic"), "warn");
    }
  };

  const stop = () => {
    netRef.current?.stop();
    setPeer(null);
    setRemoteStream(null);
    setElapsed(0);
    setOrient("land");
    setIce("");
    setSlot(-1);
    setPhase("idle");
    // після завершення розмови камера/мікрофон вимикаються повністю
    releaseMedia();
  };

  const next = () => {
    netRef.current?.next();
    setPeer(null);
    setRemoteStream(null);
    setElapsed(0);
    setIce("");
    setPhase("searching");
  };

  const stateKey = phase === "searching" || phase === "live" ? phase : "standby";
  const stateWord = useScramble(t(`state.${stateKey}`), 60);
  const titleWord = useScramble(t("idle.title"), 150);

  const ledCls = phase === "live" ? "led-mint" : phase === "searching" ? "led-amber" : "";

  /* реальний шлях з'єднання пари: relay / stun / lan */
  const iceView = (() => {
    if (!ice || phase !== "live") return null;
    if (ice === "relay") return { txt: "p2p · turn-relay", cls: "text-[var(--c-mint)]" };
    if (ice === "stun") return { txt: "p2p · stun", cls: "text-[var(--c-mint)]" };
    if (ice === "lan" || ice === "p2p") return { txt: "p2p · direct", cls: "text-[var(--c-mint)]" };
    if (ice === "failed") return { txt: "ice: failed", cls: "text-[var(--c-red)]" };
    if (ice === "disconnected") return { txt: "ice: reconnect", cls: "text-[var(--c-amber)]" };
    return { txt: "ice: connecting", cls: "text-[var(--c-amber)]" };
  })();

  const genderLabel =
    filters.gender === "any" ? t("flt.any") : filters.gender === "m" ? t("flt.male") : t("flt.female");

  return (
    <div>
      <div className="min-w-0">
        {/* ── Сцена: карточка сцени .card ── */}
        <div className="card overflow-hidden relative w-full">
          <div
            className="relative bg-[var(--c-bg2)] transition-all duration-300 aspect-[4/3] max-h-[min(48dvh,500px)] sm:max-h-[min(66dvh,640px)] min-h-[230px] w-full mx-auto overflow-hidden"
          >
            {phase === "live" && peer ? (
              <VideoChat
                peer={peer}
                remoteStream={remoteStream}
                setRemoteSpeaking={() => {}}
                onOrient={setOrient}
                chat={netRef.current ? { ...netRef.current.chat } : undefined}
                localMedia={localMedia}
                onStreamUpdate={(s, track) => {
                  netRef.current?.updateStream(s, track);
                }}
                onLeave={(k) => (k === "next" ? next() : stop())}
                onReport={() => onToast(t("rep.sent"), "ok")}
                onToast={onToast}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center scanlines p-2.5 sm:p-6 overflow-hidden">
                <div className="absolute w-[min(300px,76vw)] h-[min(300px,76vw)] sm:w-[420px] sm:h-[420px] rounded-full border border-[var(--c-line)] opacity-60 pointer-events-none" />
                <div className="absolute w-[min(200px,52vw)] h-[min(200px,52vw)] sm:w-[300px] sm:h-[300px] rounded-full border border-[var(--c-line)] opacity-80 pointer-events-none" />
                {phase === "searching" && (
                  <div className="absolute w-[min(200px,52vw)] h-[min(200px,52vw)] sm:w-[300px] sm:h-[300px] rounded-full radar-sweep opacity-70 pointer-events-none" />
                )}
                <div className="relative text-center px-2 sm:px-6 max-w-xl my-auto w-full z-10">
                  <div className="relative inline-grid place-items-center mb-1.5 sm:mb-4">
                    {busy && (
                      <>
                        <span className="absolute w-14 h-14 sm:w-24 sm:h-24 rounded-full border-2 border-[var(--c-mint)] opacity-70" style={{ animation: "vring 1.8s ease-out infinite" }} />
                        <span className="absolute w-14 h-14 sm:w-24 sm:h-24 rounded-full border-2 border-[var(--c-mint)] opacity-50" style={{ animation: "vring 1.8s ease-out 0.6s infinite" }} />
                      </>
                    )}
                    <span className="floaty grid place-items-center w-11 h-11 sm:w-20 sm:h-20 rounded-xl sm:rounded-2xl border border-[var(--c-line2)] bg-[var(--c-panel)] shadow-[var(--c-shadow)]">
                      <LogoMark className="w-6 h-6 sm:w-12 sm:h-12" />
                    </span>
                  </div>

                  {phase === "idle" || phase === "captcha" ? (
                    <>
                      <h2 className="font-display font-900 text-lg sm:text-2xl md:text-3xl tracking-tight leading-tight">{titleWord}</h2>
                      <p className="mt-1 sm:mt-2 text-[11.5px] sm:text-[14px] text-[var(--c-dim)] leading-relaxed max-w-md mx-auto">{t("idle.sub")}</p>
                      <div className="mt-2 sm:mt-3.5 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
                        {([["idle.b1", <IconCheck key="a" className="w-3 h-3 sm:w-3.5 sm:h-3.5" />],
                           ["idle.b2", <IconCheck key="b" className="w-3 h-3 sm:w-3.5 sm:h-3.5" />],
                           ["idle.b3", <IconFlag key="c" className="w-3 h-3 sm:w-3.5 sm:h-3.5" />]] as const).map(([k, ic]) => (
                          <span key={k} className="chip !cursor-default !text-[10px] sm:!text-[12px] px-2 py-0.5 sm:px-2.5 sm:py-1 whitespace-nowrap">
                            {ic}
                            {t(k)}
                          </span>
                        ))}
                      </div>
                      <p className="mt-2 sm:mt-4 font-mono text-[9px] sm:text-[11px] text-[var(--c-faint)] caret">ready · dtls-srtp · p2p</p>
                    </>
                  ) : (
                    <>
                      <h2 className="font-display font-900 text-lg sm:text-2xl text-[var(--c-mint)]">
                        {t("state.searching")}
                      </h2>
                      <p className="mt-1 font-mono text-[10px] sm:text-[12px] text-[var(--c-dim)]">{t("search.captionOnline")}</p>
                      <p className="mt-0.5 font-mono text-[11px] sm:text-[13px] text-[var(--c-amber)] caret">
                        {t("stat.elapsed")} · {fmtElapsed(elapsed)}
                      </p>
                      {slot >= 0 && (
                        <p className="mt-0.5 font-mono text-[9.5px] sm:text-[11px] text-[var(--c-faint)]">
                          viche-q-{String(slot).padStart(3, "0")}
                        </p>
                      )}
                      <button className="btn mt-2.5 sm:mt-4 !py-2 !px-5" onClick={stop}>
                        {t("ctl.stop")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* нижня стрічка стану сцени */}
          <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 sm:py-2.5 border-t border-[var(--c-line)] bg-[var(--c-panel)] text-xs sm:text-sm">
            <span className={`led ${ledCls}`} />
            <span className="font-display text-[12px] sm:text-[13px] font-700 tracking-wide">{stateWord}</span>
            <span className="hidden sm:block font-mono text-[11px] text-[var(--c-faint)] truncate max-w-[200px]">
              {peer && phase === "live" ? `${peer.name} · #${peer.id}` : sessionId}
            </span>
            {iceView && (
              <span
                className={`font-mono text-[9.5px] sm:text-[10.5px] px-1.5 sm:px-2 py-0.5 rounded-md border border-[var(--c-line)] bg-[var(--c-bg2)] ${iceView.cls}`}
                title="WebRTC ICE path"
              >
                {iceView.txt}
              </span>
            )}
            <span className="ml-auto tick-id text-[10px] sm:text-[11px]">{phase === "live" && peer ? `PAIR-${peer.id}` : sessionId}</span>
          </div>
        </div>

        {/* ── Пульт керування ── */}
        <div className="mt-3 sm:mt-4 card p-3 sm:p-5">
          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 sm:gap-3">
            <button className="btn btn-amber !px-5 sm:!px-7 !py-2.5 sm:!py-3.5 !text-[13.5px] sm:!text-[15px] justify-center flex-1 sm:flex-none" onClick={start} disabled={busy}>
              <IconShuffle className="w-4 h-4 sm:w-5 sm:h-5" />
              {phase === "idle" || phase === "captcha" ? t("ctl.start") : t("ctl.resume")}
            </button>
            {phase !== "idle" && phase !== "captcha" && (
              <button className="btn btn-red !px-4 sm:!px-6 !py-2.5 sm:!py-3.5 !text-[13.5px] sm:!text-[15px] justify-center flex-1 sm:flex-none" onClick={stop}>
                {t("ctl.stop")}
              </button>
            )}
            <button
              className={`chip sm:ml-auto justify-center !py-2 sm:!py-2.5 !text-[12px] sm:!text-[13px] ${advanced ? "chip-on" : ""}`}
              onClick={() => setAdvanced((v) => !v)}
              disabled={busy || phase === "live"}
              style={busy || phase === "live" ? { opacity: 0.45, pointerEvents: "none" } : undefined}
            >
              <IconBolt className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              {t("ctl.advanced")}
              <span className="hidden md:inline font-mono text-[10px] opacity-70">· {t("ctl.advancedHint")}</span>
            </button>
          </div>

          <div className={`grid transition-all duration-300 overflow-hidden ${advanced ? "grid-rows-[1fr] mt-5 opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
            <div className="min-h-0 overflow-hidden">
              <div className="grid sm:grid-cols-[auto_1fr] gap-x-8 gap-y-4">
                <div>
                  <p className="panel-title mb-2">{t("flt.gender")}</p>
                  <div className="flex gap-2">
                    {([["any", "flt.any"], ["m", "flt.male"], ["f", "flt.female"]] as const).map(([g, k]) => (
                      <button key={g} className={`chip ${filters.gender === g ? "chip-on" : ""}`} onClick={() => setFilters((f) => ({ ...f, gender: g }))}>
                        {t(k)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="panel-title mb-2">{t("flt.lang")}</p>
                  <div className="flex flex-wrap gap-2">
                    {LANG_OPTS.map((l) => (
                      <button key={l} className={`chip !px-3 font-mono ${filters.lang === l ? "chip-on" : ""}`} onClick={() => setFilters((f) => ({ ...f, lang: l }))}>
                        {l === "any" ? t("flt.any").toUpperCase() : l.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <p className="panel-title mb-2">{t("flt.tags")}</p>
                  <div className="flex flex-wrap gap-2">
                    {TAGS.map((tg) => {
                      const on = filters.tags.includes(tg);
                      return (
                        <button
                          key={tg}
                          className={`chip ${on ? "chip-on" : ""}`}
                          onClick={() =>
                            setFilters((f) => ({
                              ...f,
                              tags: on ? f.tags.filter((x) => x !== tg) : [...f.tags, tg],
                            }))
                          }
                        >
                          #{t(`tag.${tg}` as DictKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="sm:col-span-2 font-mono text-[11px] text-[var(--c-faint)]">
                  {t("flt.summary")}: {genderLabel} · {filters.lang === "any" ? t("flt.any").toUpperCase() : filters.lang.toUpperCase()} ·{" "}
                  {filters.tags.length === 0 ? t("stat.noTags") : filters.tags.map((x) => "#" + x).join(" ")}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {phase === "captcha" && (
        <CaptchaModal
          onPass={() => {
            beginSearch(filtersRef.current);
          }}
        />
      )}
    </div>
  );
}
