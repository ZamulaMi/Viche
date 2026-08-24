import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LANGS,
  shortId,
  simulateMatch,
  TAGS,
  type Filters,
  type Peer,
} from "../lib/sim";
import { loopbackConnect, makeCanvasStream, type CanvasCtl, type LocalMedia } from "../lib/rtc";
import { useI18n, type DictKey } from "../i18n";
import { useScramble } from "../lib/hooks";
import CaptchaModal, { captchaToken } from "./Captcha";
import VideoChat from "./VideoChat";
import { IconBolt, IconCheck, IconFlag, IconShuffle, LogoMark } from "./icons";

type Phase = "idle" | "captcha" | "searching" | "connecting" | "live";

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

  const rtcClose = useRef<(() => void) | null>(null);
  const ctlRef = useRef<CanvasCtl | null>(null);
  const runRef = useRef(0);
  const liveRef = useRef(true);

  /* Реальний ідентифікатор сесії цього клієнта */
  const sessionId = useMemo(() => "SES-" + shortId(4), []);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      runRef.current++;
      rtcClose.current?.();
      ctlRef.current?.close();
    };
  }, []);

  const cleanupRemote = useCallback(() => {
    rtcClose.current?.();
    rtcClose.current = null;
    ctlRef.current?.close();
    ctlRef.current = null;
    setRemoteStream(null);
  }, []);

  const busy = phase === "searching" || phase === "connecting";

  /* Реальний таймер пошуку: йде лише поки триває пошук/з'єднання */
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  const beginSearch = useCallback(
    async (f: Filters) => {
      cleanupRemote();
      const run = ++runRef.current;
      setPeer(null);
      setElapsed(0);
      setPhase("searching");
      const p = await simulateMatch(f);
      if (runRef.current !== run || !liveRef.current) return;
      setPeer(p);
      setPhase("connecting");
      const ctl = makeCanvasStream(p.name.split("_")[1] ?? "GG", p.hue);
      ctlRef.current = ctl;
      try {
        const lc = await loopbackConnect(ctl.stream);
        if (runRef.current !== run || !liveRef.current) {
          lc.close();
          ctl.close();
          return;
        }
        rtcClose.current = lc.close;
        setRemoteStream(lc.stream);
      } catch {
        if (runRef.current !== run) return;
        setRemoteStream(ctl.stream);
      }
      setPhase("live");
    },
    [cleanupRemote]
  );

  const start = async () => {
    await ensureLocal();
    if (!captchaToken()) {
      setPhase("captcha");
      return;
    }
    beginSearch(filters);
  };

  const stop = () => {
    runRef.current++;
    cleanupRemote();
    setPeer(null);
    setElapsed(0);
    setPhase("idle");
  };

  const next = () => beginSearch(filters);

  const stateKey = phase === "searching" || phase === "connecting" || phase === "live" ? phase : "standby";
  const stateWord = useScramble(t(`state.${stateKey}`), 60);
  const titleWord = useScramble(t("idle.title"), 150);

  const ledCls =
    phase === "live" ? "led-mint" : phase === "idle" || phase === "captcha" ? "" : "led-amber";

  const mediaLabel = localMedia
    ? localMedia.hasCam
      ? t("stat.mediaCam")
      : t("stat.mediaAvatar")
    : t("stat.mediaPending");

  const genderLabel =
    filters.gender === "any" ? t("flt.any") : filters.gender === "m" ? t("flt.male") : t("flt.female");

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_330px] gap-4 items-start">
      <div className="min-w-0">
        {/* ── Сцена ── */}
        <div className="card overflow-hidden">
          <div className="relative aspect-video bg-[var(--c-bg2)] overflow-hidden">
            {phase === "live" && peer ? (
              <VideoChat
                peer={peer}
                remoteStream={remoteStream}
                setRemoteSpeaking={(b) => ctlRef.current?.setSpeaking(b)}
                localMedia={localMedia}
                onLeave={(k) => (k === "next" ? next() : stop())}
                onReport={() => onToast(t("rep.sent"), "ok")}
                onToast={onToast}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center scanlines">
                {/* декоративні кільця */}
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
                        {([["idle.b1", <IconCheck key="a" className="w-3.5 h-3.5" />], ["idle.b2", <IconCheck key="b" className="w-3.5 h-3.5" />], ["idle.b3", <IconFlag key="c" className="w-3.5 h-3.5" />]] as const).map(([k, ic]) => (
                          <span key={k} className="chip !cursor-default !text-[12px]">{ic}{t(k)}</span>
                        ))}
                      </div>
                      <p className="mt-6 font-mono text-[11px] text-[var(--c-faint)] caret">ready · dtls-srtp · p2p</p>
                    </>
                  ) : (
                    <>
                      <h2 className={`font-display font-900 text-2xl sm:text-3xl ${phase === "connecting" ? "text-[var(--c-amber)]" : "text-[var(--c-mint)]"}`}>
                        {phase === "searching" ? t("state.searching") : t("state.connecting")}
                      </h2>
                      <p className="mt-3 font-mono text-[13px] text-[var(--c-dim)] caret">
                        {t("stat.elapsed")} · {fmtElapsed(elapsed)}
                      </p>
                      <button className="btn mt-6" onClick={stop}>{t("ctl.stop")}</button>
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
            {(phase !== "idle" && phase !== "captcha") && (
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

      {/* ── Бічна колонка: лише реальні дані сесії ── */}
      <aside className="space-y-4 min-w-0">
        <div className="card p-4">
          <p className="panel-title mb-3">{t("nav.roulette")} · status</p>
          <div className="flex items-center gap-3">
            <span
              className="grid place-items-center w-12 h-12 rounded-xl font-display font-900 text-lg"
              style={{
                background: peer && phase === "live" ? `hsl(${peer.hue} 45% 22%)` : "var(--c-raise)",
                color: peer && phase === "live" ? `hsl(${peer.hue} 85% 75%)` : "var(--c-amber)",
                border: "1px solid var(--c-line2)",
              }}
            >
              {peer && phase === "live" ? peer.name.split("_")[1]?.slice(0, 2) : "V"}
            </span>
            <div className="min-w-0">
              <p className="font-700 text-[15px] truncate">{peer && phase === "live" ? peer.name : sessionId}</p>
              <p className="font-mono text-[11px] text-[var(--c-dim)]">
                {peer && phase === "live"
                  ? `${peer.langs.map((l) => l.toUpperCase()).join("/")} · ${peer.tags.map((x) => "#" + x).join(" ")}`
                  : mediaLabel}
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-px rounded-lg border border-[var(--c-line)] bg-[var(--c-bg2)] overflow-hidden">
            {([
              [t("stat.elapsed"), busy || phase === "live" ? fmtElapsed(elapsed) : "—", busy ? "text-[var(--c-amber)]" : "text-[var(--c-mint)]"],
              [t("stat.session"), sessionId, "text-[var(--c-text)]"],
              [t("stat.media"), mediaLabel, "text-[var(--c-text)]"],
              [t("stat.channel"), phase === "live" ? t("stat.channelLive") : t("stat.channelIdle"), phase === "live" ? "text-[var(--c-mint)]" : "text-[var(--c-faint)]"],
            ] as const).map(([label, value, cls]) => (
              <div key={label} className="flex items-center justify-between gap-3 px-3.5 py-2.5 odd:bg-[color-mix(in_srgb,var(--c-raise)_55%,transparent)]">
                <span className="text-[11px] text-[var(--c-faint)]">{label}</span>
                <span className={`font-mono text-[12px] ${cls}`}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Активні фільтри — реальні значення з пульта */}
        <div className="card p-4">
          <p className="panel-title mb-3">{t("stat.filters")}</p>
          <div className="flex flex-wrap gap-1.5">
            <span className="chip !cursor-default !text-[12px]">{genderLabel}</span>
            <span className="chip !cursor-default !text-[12px] font-mono">{filters.lang.toUpperCase()}</span>
            {filters.tags.length === 0 && (
              <span className="chip !cursor-default !text-[12px] opacity-60">{t("stat.noTags")}</span>
            )}
            {filters.tags.map((tg) => (
              <span key={tg} className="chip chip-on !cursor-default !text-[12px]">
                #{t(`tag.${tg}` as DictKey)}
              </span>
            ))}
          </div>
        </div>
      </aside>

      {phase === "captcha" && (
        <CaptchaModal
          onPass={() => {
            beginSearch(filters);
          }}
        />
      )}
    </div>
  );
}
