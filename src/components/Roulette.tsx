import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LANGS, TAGS, shortId, type Filters, type Peer } from "../lib/sim";
import type { LocalMedia } from "../lib/rtc";
import { FALLBACK_WAIT_MS, MatchClient, type MatchResult } from "../lib/net";
import { useI18n, type DictKey } from "../i18n";
import { useScramble } from "../lib/hooks";
import CaptchaModal, { captchaToken } from "./Captcha";
import VideoChat from "./VideoChat";
import { IconBolt, IconCheck, IconFlag, IconShuffle, LogoMark } from "./icons";

type Phase = "idle" | "captcha" | "searching" | "live";

type Props = {
  localMedia: LocalMedia | null;
  ensureLocal: () => Promise<LocalMedia>;
  onToast: (msg: string, kind?: "ok" | "warn") => void;
};

const fmtElapsed = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export default function Roulette({ localMedia, ensureLocal, onToast }: Props) {
  const { t, lang } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [filters, setFilters] = useState<Filters>({ gender: "any", lang, tags: [] });
  const [peer, setPeer] = useState<Peer | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [chat, setChat] = useState<MatchResult["chat"] | null>(null);
  const [orient, setOrient] = useState<"land" | "port">("land");
  const [ice, setIce] = useState("");

  const clientRef = useRef<MatchClient | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const speakRef = useRef<((b: boolean) => void) | null>(null);
  const lmRef = useRef(localMedia);
  const hasSearched = useRef(false);
  const runRef = useRef(0);
  const liveRef = useRef(true);
  const waitTimer = useRef(0);
  const filtersRef = useRef(filters);
  const tRef = useRef(t);
  const toastRef = useRef(onToast);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  useEffect(() => {
    lmRef.current = localMedia;
  }, [localMedia]);
  useEffect(() => {
    tRef.current = t;
    toastRef.current = onToast;
  }, [t, onToast]);

  const sessionId = useMemo(() => "SES-" + shortId(4), []);

  const clearWait = () => {
    window.clearTimeout(waitTimer.current);
    waitTimer.current = 0;
  };

  const closeRemote = useCallback(() => {
    closeRef.current?.();
    closeRef.current = null;
    setRemoteStream(null);
  }, []);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      runRef.current++;
      clearWait();
      closeRef.current?.();
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  /* реальний таймер: йде лише поки триває пошук */
  const busy = phase === "searching";
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  const openClient = useCallback(
    (lm: LocalMedia) => {
      if (clientRef.current) return clientRef.current;
      const client = new MatchClient(lm.stream, {
        onMode: (m) => {
          if (m === "demo" && hasSearched.current) {
            toastRef.current(tRef.current("toast.demoFallback"), "warn");
          }
        },
        onQueued: () => {
          clearWait();
          waitTimer.current = window.setTimeout(() => {
            clientRef.current?.demoPairOnce();
          }, FALLBACK_WAIT_MS);
        },
        onPair: (r) => {
          if (!liveRef.current) {
            r.close();
            return;
          }
          clearWait();
          setOrient("land");
          setPeer(r.peer);
          setChat(r.chat ?? null);
          speakRef.current = r.setSpeaking ?? null;
          closeRef.current = r.close;
          setRemoteStream(r.stream);
          setPhase("live");
        },
        onPeerLeft: () => {
          clearWait();
          closeRemote();
          setPeer(null);
          setChat(null);
          setIce("");
          speakRef.current = null;
          if (!liveRef.current) return;
          toastRef.current(tRef.current("toast.peerLeft"), "warn");
          // автоматично шукаємо наступного
          window.setTimeout(() => {
            if (liveRef.current) beginSearchRef.current(filtersRef.current);
          }, 700);
        },
        onNotice: (key) => {
          toastRef.current(tRef.current(key as DictKey), "warn");
        },
        onIce: setIce,
      });
      clientRef.current = client;
      return client;
    },
    [closeRemote]
  );

  const beginSearch = useCallback(
    (f: Filters) => {
      runRef.current++;
      clearWait();
      closeRemote();
      setPeer(null);
      setElapsed(0);
      setOrient("land");
      setIce("");
      setPhase("searching");
      hasSearched.current = true;
      const lm = lmRef.current;
      if (lm) openClient(lm).search(f);
    },
    [closeRemote, openClient]
  );
  const beginSearchRef = useRef(beginSearch);
  useEffect(() => {
    beginSearchRef.current = beginSearch;
  }, [beginSearch]);

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
      onToast(t("toast.demoFallback"), "warn");
    }
  };

  const stop = () => {
    runRef.current++;
    clearWait();
    clientRef.current?.stop();
    closeRemote();
    setPeer(null);
    setElapsed(0);
    setOrient("land");
    setIce("");
    setPhase("idle");
  };

  const next = () => beginSearch(filtersRef.current);

  const stateKey = phase === "searching" || phase === "live" ? phase : "standby";
  const stateWord = useScramble(t(`state.${stateKey}`), 60);
  const titleWord = useScramble(t("idle.title"), 150);

  const ledCls = phase === "live" ? "led-mint" : phase === "searching" ? "led-amber" : "";

  /* реальний шлях з'єднання пари: TURN-relay / STUN / LAN */
  const iceView = (() => {
    if (!ice || phase !== "live") return null;
    if (ice === "relay") return { txt: "p2p · turn-relay", cls: "text-[var(--c-mint)]" };
    if (ice === "stun") return { txt: "p2p · stun", cls: "text-[var(--c-mint)]" };
    if (ice === "lan" || ice === "p2p") return { txt: "p2p · direct", cls: "text-[var(--c-mint)]" };
    if (ice === "failed") return { txt: "ice: failed", cls: "text-[var(--c-red)]" };
    if (ice === "disconnected") return { txt: "ice: reconnect", cls: "text-[var(--c-amber)]" };
    return { txt: "ice: connecting", cls: "text-[var(--c-amber)]" };
  })();

  return (
    <div>
      <div className="min-w-0">
        {/* ── Сцена: 4:3 для горизонтального відео, 3:4 для вертикального ── */}
        <div className="card overflow-hidden">
          <div
            className={`relative bg-[var(--c-bg2)] overflow-hidden ${
              orient === "port"
                ? "aspect-[3/4] max-w-[500px] sm:max-w-[560px] mx-auto"
                : "aspect-[4/3] max-w-[900px] mx-auto"
            }`}
          >
            {phase === "live" && peer ? (
              <VideoChat
                peer={peer}
                remoteStream={remoteStream}
                setRemoteSpeaking={(b) => speakRef.current?.(b)}
                onOrient={setOrient}
                chat={chat ?? undefined}
                localMedia={localMedia}
                onLeave={(k) => (k === "next" ? next() : stop())}
                onReport={() => onToast(t("rep.sent"), "ok")}
                onToast={onToast}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center scanlines">
                <div className="absolute w-[420px] h-[420px] rounded-full border border-[var(--c-line)] opacity-60" />
                <div className="absolute w-[300px] h-[300px] rounded-full border border-[var(--c-line)] opacity-80" />
                {phase === "searching" && (
                  <div className="absolute w-[300px] h-[300px] rounded-full radar-sweep opacity-70" />
                )}
                <div className="relative text-center px-6 max-w-xl">
                  <div className="relative inline-grid place-items-center mb-6">
                    {busy && (
                      <>
                        <span className="absolute w-24 h-24 rounded-full border-2 border-[var(--c-mint)] opacity-70" style={{ animation: "vring 1.8s ease-out infinite" }} />
                        <span className="absolute w-24 h-24 rounded-full border-2 border-[var(--c-mint)] opacity-50" style={{ animation: "vring 1.8s ease-out 0.6s infinite" }} />
                      </>
                    )}
                    <span className="floaty grid place-items-center w-20 h-20 rounded-2xl border border-[var(--c-line2)] bg-[var(--c-panel)] shadow-[var(--c-shadow)]">
                      <LogoMark className="w-12 h-12" />
                    </span>
                  </div>

                  {phase === "idle" || phase === "captcha" ? (
                    <>
                      <h2 className="font-display font-900 text-2xl sm:text-4xl tracking-tight">{titleWord}</h2>
                      <p className="mt-3 text-sm sm:text-[15px] text-[var(--c-dim)] leading-relaxed">{t("idle.sub")}</p>
                      <div className="mt-5 flex flex-wrap justify-center gap-2">
                        {([[
                          "idle.b1",
                          <IconCheck key="a" className="w-3.5 h-3.5" />,
                        ], [
                          "idle.b2",
                          <IconCheck key="b" className="w-3.5 h-3.5" />,
                        ], [
                          "idle.b3",
                          <IconFlag key="c" className="w-3.5 h-3.5" />,
                        ]] as const).map(([k, ic]) => (
                          <span key={k} className="chip !cursor-default !text-[12px]">
                            {ic}
                            {t(k)}
                          </span>
                        ))}
                      </div>
                      <p className="mt-6 font-mono text-[11px] text-[var(--c-faint)] caret">ready · dtls-srtp · p2p</p>
                    </>
                  ) : (
                    <>
                      <h2 className="font-display font-900 text-2xl sm:text-3xl text-[var(--c-mint)]">
                        {t("state.searching")}
                      </h2>
                      <p className="mt-2 font-mono text-[12px] text-[var(--c-dim)]">{t("search.captionOnline")}</p>
                      <p className="mt-1 font-mono text-[13px] text-[var(--c-amber)] caret">
                        {t("stat.elapsed")} · {fmtElapsed(elapsed)}
                      </p>
                      <button className="btn mt-6" onClick={stop}>
                        {t("ctl.stop")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* нижня стрічка стану сцени */}
          <div className="flex items-center gap-3 px-4 py-2.5 border-t border-[var(--c-line)] bg-[var(--c-panel)]">
            <span className={`led ${ledCls}`} />
            <span className="font-display text-[13px] font-700 tracking-wide">{stateWord}</span>
            <span className="hidden sm:block font-mono text-[11px] text-[var(--c-faint)]">
              {peer && phase === "live" ? `${peer.name} · #${peer.id}` : sessionId}
            </span>
            {iceView && (
              <span
                className={`font-mono text-[10.5px] px-2 py-0.5 rounded-md border border-[var(--c-line)] bg-[var(--c-bg2)] ${iceView.cls}`}
                title="WebRTC ICE path"
              >
                {iceView.txt}
              </span>
            )}
            <span className="ml-auto tick-id text-[11px]">{phase === "live" && peer ? `PAIR-${peer.id}` : sessionId}</span>
          </div>
        </div>

        {/* ── Пульт керування ── */}
        <div className="mt-4 card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-amber !px-7 !py-3.5 !text-[15px]" onClick={start} disabled={busy}>
              <IconShuffle className="w-5 h-5" />
              {phase === "idle" || phase === "captcha" ? t("ctl.start") : t("ctl.resume")}
            </button>
            {phase !== "idle" && phase !== "captcha" && (
              <button className="btn btn-red" onClick={stop} disabled={busy}>
                {t("ctl.stop")}
              </button>
            )}
            <button
              className={`chip ml-auto ${advanced ? "chip-on" : ""}`}
              onClick={() => setAdvanced((v) => !v)}
              disabled={busy || phase === "live"}
              style={busy || phase === "live" ? { opacity: 0.45, pointerEvents: "none" } : undefined}
            >
              <IconBolt className="w-4 h-4" />
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
                    {LANGS.map((l) => (
                      <button key={l} className={`chip !px-3 font-mono ${filters.lang === l ? "chip-on" : ""}`} onClick={() => setFilters((f) => ({ ...f, lang: l }))}>
                        {l.toUpperCase()}
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
