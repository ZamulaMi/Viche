import { useCallback, useEffect, useRef, useState } from "react";
import type { Peer } from "../lib/sim";
import { filterProfanity, now, randomPhrase } from "../lib/sim";
import type { LocalMedia } from "../lib/rtc";
import { enterFullscreen, exitFullscreen, isNativeFullscreen } from "../lib/fullscreen";
import { useI18n } from "../i18n";
import {
  IconCam,
  IconCamOff,
  IconChat,
  IconClose,
  IconEnd,
  IconExitFull,
  IconFlag,
  IconFull,
  IconMic,
  IconMicOff,
  IconNext,
  IconSend,
  IconSwitchCamera,
} from "./icons";

type Msg = { id: number; from: "peer" | "you" | "sys" | "warn"; text: string; time: string };

type Props = {
  peer: Peer;
  remoteStream: MediaStream | null;
  setRemoteSpeaking: (b: boolean) => void;
  /** орієнтація відео партнера: 4:3 горизонталь / 3:4 вертикаль */
  onOrient?: (o: "land" | "port") => void;
  /** реальний текстовий чат (лише для мережевої пари) */
  chat?: { send: (text: string) => void; subscribe: (fn: (text: string) => void) => () => void };
  localMedia: LocalMedia | null;
  onLeave: (kind: "next" | "end") => void;
  onReport: () => void;
  onToast: (msg: string, kind?: "ok" | "warn") => void;
};

let mid = 0;

export default function VideoChat({
  peer,
  remoteStream,
  setRemoteSpeaking,
  onOrient,
  chat,
  localMedia,
  onLeave,
  onReport,
  onToast,
}: Props) {
  const { t, lang } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [cool, setCool] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [switchingCam, setSwitchingCam] = useState(false);

  const peerLang = peer.langs.includes("uk") ? "uk" : "en";

  const push = useCallback((from: Msg["from"], text: string) => {
    setMsgs((m) => [...m.slice(-70), { id: ++mid, from, text, time: now() }]);
    if (from === "peer") setUnread((u) => u + 1);
  }, []);

  /* підключення медіа */
  useEffect(() => {
    const v = remoteRef.current;
    if (v && remoteStream) {
      v.srcObject = remoteStream;
      v.onloadedmetadata = () => v.play().catch(() => {});
      v.play().catch(() => {});
    }
  }, [remoteStream]);
  useEffect(() => {
    const v = localRef.current;
    if (v && localMedia?.isReal) {
      v.srcObject = localMedia.stream;
      v.onloadedmetadata = () => v.play().catch(() => {});
      v.play().catch(() => {});
    }
  }, [localMedia]);

  /* скидання чату при зміні співрозмовника */
  useEffect(() => {
    setMsgs([]);
    setUnread(0);
    const sys = window.setTimeout(() => push("sys", t("chat.sysJoin")), 400);
    return () => {
      window.clearTimeout(sys);
    };
  }, [peer.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /* індикатор мовлення: реальний VAD за аудіо-треком, для демо — симуляція */
  useEffect(() => {
    let stopFn: (() => void) | null = null;
    const hasAudio = !!remoteStream && remoteStream.getAudioTracks().length > 0;
    if (hasAudio && remoteStream) {
      let ctx: AudioContext | null = null;
      let raf = 0;
      let dead = false;
      try {
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(remoteStream);
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        const buf = new Uint8Array(an.fftSize);
        let last = 0;
        const tick = (ts: number) => {
          if (dead) return;
          raf = requestAnimationFrame(tick);
          if (ts - last < 140) return;
          last = ts;
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const d = (buf[i] - 128) / 128;
            sum += d * d;
          }
          const s = Math.sqrt(sum / buf.length) > 0.04;
          setSpeaking(s);
          setRemoteSpeaking(s);
        };
        raf = requestAnimationFrame(tick);
        stopFn = () => {
          dead = true;
          cancelAnimationFrame(raf);
          ctx?.close().catch(() => {});
        };
      } catch {
        stopFn = null;
      }
    }
    if (!stopFn) {
      // демо-співрозмовник: симульоване мовлення
      const iv = window.setInterval(() => {
        const s = Math.random() > 0.42;
        setSpeaking(s);
        setRemoteSpeaking(s);
      }, 2400);
      stopFn = () => window.clearInterval(iv);
    }
    return () => {
      stopFn?.();
      setSpeaking(false);
      setRemoteSpeaking(false);
    };
  }, [remoteStream, peer.id, setRemoteSpeaking]);

  /* репліки "співрозмовника" — лише для демо-пари */
  useEffect(() => {
    if (chat) return;
    const timers: number[] = [];
    const count = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      timers.push(
        window.setTimeout(() => push("peer", randomPhrase(peerLang)), 3600 + i * 6500 + Math.random() * 2000)
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [peer.id, peerLang, push, chat]);

  /* вхідні повідомлення з реального data-каналу */
  useEffect(() => {
    if (!chat) return;
    return chat.subscribe((text) => {
      const { text: clean, flagged } = filterProfanity(text);
      push("peer", clean);
      if (flagged) push("warn", t("chat.warn"));
    });
  }, [chat, push, t]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, chatOpen]);

  const send = () => {
    const raw = draft.trim();
    if (!raw) return;
    const { text, flagged } = filterProfanity(raw);
    push("you", text);
    setDraft("");
    if (flagged) {
      push("warn", t("chat.warn"));
      onToast(t("chat.warn"), "warn");
    }
    if (chat) {
      // реальна доставка співрозмовнику через DataConnection
      chat.send(text);
      return;
    }
    if (Math.random() > 0.55) {
      window.setTimeout(() => push("peer", randomPhrase(peerLang)), 1600 + Math.random() * 1800);
    }
  };

  const report = () => {
    if (cool) {
      onToast(t("rep.cool"), "warn");
      return;
    }
    setCool(true);
    window.setTimeout(() => setCool(false), 20000);
    onReport();
    onToast(t("rep.sent"), "ok");
  };

  const toggleMic = () => {
    setMicOn((v) => {
      localMedia?.stream.getAudioTracks().forEach((tr) => (tr.enabled = v ? false : true));
      return !v;
    });
  };
  const toggleCam = () => {
    setCamOn((v) => {
      localMedia?.stream.getVideoTracks().forEach((tr) => (tr.enabled = v ? false : true));
      return !v;
    });
  };

  const handleSwitchCam = async () => {
    if (!localMedia?.isReal || !localMedia?.switchCamera || switchingCam) return;
    setSwitchingCam(true);
    try {
      const newMode = await localMedia.switchCamera();
      onToast(newMode === "environment" ? t("video.camBack") : t("video.camFront"), "ok");
      if (localRef.current) {
        localRef.current.srcObject = localMedia.stream;
        localRef.current.play().catch(() => {});
      }
    } catch {
      onToast(t("toast.noMultiCam"), "warn");
    } finally {
      setSwitchingCam(false);
    }
  };

  const enterFs = async () => {
    setIsFull(true);
    await enterFullscreen(boxRef.current);
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

  return (
    <div
      ref={boxRef}
      className={`${
        isFull
          ? "fixed inset-0 z-[9999] w-screen h-[100dvh] bg-black overflow-hidden select-none"
          : "absolute inset-0 bg-black overflow-visible"
      }`}
    >
      {/* remote: чисте відео без обрізки й без жодних спотворень */}
      <video
        ref={remoteRef}
        autoPlay
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth > 0 && v.videoHeight > 0) {
            onOrient?.(v.videoWidth < v.videoHeight ? "port" : "land");
          }
        }}
        className="absolute inset-0 w-full h-full object-contain bg-black"
      />

      {/* верхня панель: статус + пір */}
      <div className={`absolute top-2 sm:top-3 left-2 sm:left-3 right-2 sm:right-3 ${isFull ? "pt-[env(safe-area-inset-top,10px)]" : "pt-[env(safe-area-inset-top,0px)]"} flex items-start justify-between gap-2 z-20 pointer-events-none`}>
        <div className="flex items-center gap-2 sm:gap-2.5 rounded-xl bg-[color-mix(in_srgb,var(--c-bg)_76%,transparent)] backdrop-blur-md border border-[var(--c-line)] px-2.5 sm:px-3.5 py-1.5 sm:py-2 pointer-events-auto shadow-sm">
          <span className="led led-mint" />
          <div className="leading-tight">
            <p className="font-mono text-[9px] sm:text-[10px] tracking-[0.18em] text-[var(--c-mint)]">{t("state.live")}</p>
            <p className="text-xs sm:text-sm font-700 text-[var(--c-text)] truncate max-w-[140px] sm:max-w-[200px]">
              {peer.name}
              {!peer.real && <span className="font-mono text-[10px] sm:text-[11px] text-[var(--c-dim)]"> · {peer.ping}ms</span>}
              {peer.real && <span className="font-mono text-[10px] sm:text-[11px] text-[var(--c-mint)]"> · p2p</span>}
            </p>
          </div>
        </div>
        <div className="hidden sm:flex flex-col items-end gap-1.5 pointer-events-auto">
          <div className="flex items-end gap-[3px] h-7 px-3 rounded-lg bg-[color-mix(in_srgb,var(--c-bg)_72%,transparent)] backdrop-blur-md border border-[var(--c-line)]">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="w-[3px] rounded-full bg-[var(--c-mint)] transition-all duration-300"
                style={{ height: speaking ? `${10 + ((i * 7 + peer.ping) % 14)}px` : "4px" }}
              />
            ))}
          </div>
          <div className="flex gap-1">
            {peer.real ? (
              <span className="font-mono text-[10px] px-2 py-0.5 rounded-md bg-[color-mix(in_srgb,var(--c-bg)_72%,transparent)] backdrop-blur-md border border-[var(--c-line)] text-[var(--c-mint)]">
                #{peer.id} · webrtc
              </span>
            ) : (
              (peer.tags ?? []).slice(0, 3).map((tg) => (
                <span key={tg} className="font-mono text-[10px] px-2 py-0.5 rounded-md bg-[color-mix(in_srgb,var(--c-bg)_72%,transparent)] backdrop-blur-md border border-[var(--c-line)] text-[var(--c-dim)]">
                  #{tg}
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      {/* локальне відео (PiP) */}
      <div className="absolute right-2 sm:right-3 bottom-14 sm:bottom-20 w-24 sm:w-36 md:w-44 aspect-[4/3] rounded-lg overflow-hidden border border-[var(--c-line2)] shadow-[var(--c-shadow)] z-20 bg-[var(--c-bg2)]">
        {localMedia?.isReal ? (
          <video
            ref={localRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-contain bg-[var(--c-bg2)] transition-transform duration-300 ${
              localMedia?.facingMode === "environment" ? "scale-x-1" : "-scale-x-100"
            }`}
          />
        ) : (
          <div className="w-full h-full grid place-items-center">
            <span className="font-display text-xl sm:text-2xl text-[var(--c-amber)]">TI</span>
          </div>
        )}
        {!camOn && (
          <div className="absolute inset-0 bg-[var(--c-bg)] grid place-items-center">
            <IconCamOff className="w-5 h-5 sm:w-6 sm:h-6 text-[var(--c-faint)]" />
          </div>
        )}
        <div className="absolute top-1 left-1.5 flex items-center gap-1 z-30">
          <span className="font-mono text-[9px] sm:text-[10px] tracking-widest text-[var(--c-mint)]">{t("video.you")}</span>
          {localMedia?.hasCam && (
            <span className="font-mono text-[8px] sm:text-[9px] px-1 py-0.2 rounded bg-black/60 text-[var(--c-faint)] uppercase">
              {localMedia.facingMode === "environment" ? "rear" : "front"}
            </span>
          )}
        </div>
        {localMedia?.hasCam && camOn && (
          <button
            type="button"
            className="absolute top-1 right-1 p-1 sm:p-1.5 rounded-md bg-[color-mix(in_srgb,var(--c-bg)_80%,transparent)] hover:bg-[var(--c-amber)] hover:text-black backdrop-blur-md border border-[var(--c-line2)] text-[var(--c-amber)] transition-all z-30 shadow-md active:scale-90"
            onClick={(e) => {
              e.stopPropagation();
              void handleSwitchCam();
            }}
            disabled={switchingCam}
            title={`${t("video.switchCam")} (${t("video.flipHint")})`}
            aria-label={t("video.switchCam")}
          >
            <IconSwitchCamera className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${switchingCam ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>
      {!localMedia?.hasCam && (
        <p className="absolute right-2 sm:right-3 bottom-12 sm:bottom-[72px] z-20 font-mono text-[9.5px] sm:text-[10px] text-[var(--c-amber)] bg-[color-mix(in_srgb,var(--c-bg)_78%,transparent)] backdrop-blur-md rounded-md px-1.5 sm:px-2 py-0.5 border border-[var(--c-line)]">
          {t("video.noCam")}
        </p>
      )}

      {/* чат */}
      <div
        className={`absolute z-30 transition-all duration-300 ${
          chatOpen ? "opacity-100 translate-x-0" : "opacity-0 translate-x-6 pointer-events-none"
        } top-12 sm:top-16 bottom-14 sm:bottom-20 right-2 sm:right-3 w-[calc(100%-16px)] sm:w-72 max-w-[320px] flex flex-col card overflow-hidden !bg-[color-mix(in_srgb,var(--c-panel)_88%,transparent)] backdrop-blur-md shadow-2xl`}
      >
        <div className="flex items-center justify-between px-3 py-2 sm:px-3.5 sm:py-2.5 border-b border-[var(--c-line)]">
          <span className="panel-title">{t("chat.title")}</span>
          <button className="text-[var(--c-faint)] hover:text-[var(--c-text)] transition-colors p-1" onClick={() => setChatOpen(false)} aria-label="close chat">
            <IconClose className="w-4 h-4" />
          </button>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          {msgs.length === 0 && <p className="text-[12px] text-[var(--c-faint)] italic py-2">{t("chat.empty")}</p>}
          {msgs.map((m) => (
            <div key={m.id} className={`logline text-[12.5px] sm:text-[13px] leading-snug ${m.from === "you" ? "text-right" : ""}`}>
              {m.from === "sys" && <p className="font-mono text-[10.5px] sm:text-[11px] text-[var(--c-faint)]">— {m.text} —</p>}
              {m.from === "warn" && <p className="font-mono text-[10.5px] sm:text-[11px] text-[var(--c-amber)]">⚠ {m.text}</p>}
              {(m.from === "peer" || m.from === "you") && (
                <span
                  className={`inline-block max-w-full text-left px-2.5 py-1.5 rounded-lg break-words ${
                    m.from === "you"
                      ? "bg-[color-mix(in_srgb,var(--c-amber)_18%,transparent)] text-[var(--c-text)]"
                      : "bg-[var(--c-raise)] text-[var(--c-text)]"
                  }`}
                >
                  {m.text}
                  <span className="block font-mono text-[9px] text-[var(--c-faint)] mt-0.5">{m.time}</span>
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="p-2 border-t border-[var(--c-line)] flex gap-1.5">
          <input
            className="input !py-1.5 sm:!py-2 !text-[12.5px] sm:!text-[13px]"
            placeholder={t("chat.ph")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button className="btn btn-amber btn-icon !p-2 !rounded-lg" onClick={send} aria-label={t("chat.ph")}>
            <IconSend className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* адаптивна панель керування */}
      <div className={`absolute ${isFull ? "bottom-2 sm:bottom-4 pb-[env(safe-area-inset-bottom,8px)]" : "bottom-2 sm:bottom-4 pb-[env(safe-area-inset-bottom,0px)]"} left-1/2 -translate-x-1/2 z-30 flex justify-center px-1 pointer-events-none w-full max-w-[calc(100vw-8px)] sm:max-w-max`}>
        <div className="pointer-events-auto flex items-center justify-center gap-1 sm:gap-1.5 p-1 sm:p-1.5 bg-[color-mix(in_srgb,var(--c-bg)_82%,transparent)] backdrop-blur-md rounded-xl sm:rounded-2xl border border-[var(--c-line)] shadow-lg max-w-full overflow-x-auto no-scrollbar">
          <button
            className={`btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] !p-1.5 sm:!p-2.5 flex-none ${!micOn ? "!text-[var(--c-red)] !border-[color-mix(in_srgb,var(--c-red)_50%,transparent)]" : ""}`}
            onClick={toggleMic}
            title={t("video.mic")}
            aria-label={t("video.mic")}
          >
            {micOn ? <IconMic className="w-4 h-4 sm:w-5 sm:h-5" /> : <IconMicOff className="w-4 h-4 sm:w-5 sm:h-5" />}
          </button>
          <button
            className={`btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] !p-1.5 sm:!p-2.5 flex-none ${!camOn ? "!text-[var(--c-red)] !border-[color-mix(in_srgb,var(--c-red)_50%,transparent)]" : ""}`}
            onClick={toggleCam}
            title={t("video.cam")}
            aria-label={t("video.cam")}
          >
            {camOn ? <IconCam className="w-4 h-4 sm:w-5 sm:h-5" /> : <IconCamOff className="w-4 h-4 sm:w-5 sm:h-5" />}
          </button>
          <button
            className="btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] !p-1.5 sm:!p-2.5 flex-none relative"
            onClick={() => { setChatOpen((v) => !v); setUnread(0); }}
            title={t("chat.title")}
            aria-label={t("chat.title")}
          >
            <IconChat className="w-4 h-4 sm:w-5 sm:h-5" />
            {unread > 0 && !chatOpen && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] grid place-items-center rounded-full bg-[var(--c-amber)] text-[#14100a] font-mono text-[9px] font-700 px-0.5">
                {unread}
              </span>
            )}
          </button>
          <button
            className={`btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] !p-1.5 sm:!p-2.5 flex-none inline-flex ${isFull ? "!text-[var(--c-amber)] !border-[color-mix(in_srgb,var(--c-amber)_50%,transparent)] bg-[color-mix(in_srgb,var(--c-amber)_15%,transparent)]" : ""}`}
            onClick={toggleFullscreen}
            title={isFull ? t("video.exitFull") : t("video.full")}
            aria-label={isFull ? t("video.exitFull") : t("video.full")}
          >
            {isFull ? <IconExitFull className="w-4 h-4 sm:w-5 sm:h-5" /> : <IconFull className="w-4 h-4 sm:w-5 sm:h-5" />}
          </button>
          <span className="w-px h-5 sm:h-7 bg-[var(--c-line2)] mx-0.5 flex-none opacity-60" />
          <button
            className="btn btn-red btn-icon min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] !p-1.5 sm:!p-2.5 flex-none !bg-[color-mix(in_srgb,var(--c-red)_40%,transparent)] !border-[var(--c-red)] !text-[var(--c-red)] hover:!bg-[color-mix(in_srgb,var(--c-red)_60%,transparent)] backdrop-blur-md shadow-[0_0_16px_-2px_color-mix(in_srgb,var(--c-red)_40%,transparent)]"
            onClick={() => onLeave("end")}
            title={t("ctl.end")}
            aria-label={t("ctl.end")}
          >
            <IconEnd className="w-4 h-4 sm:w-5 sm:h-5" />
          </button>
          <button
            className="btn btn-amber min-h-[38px] sm:min-h-[44px] !px-2.5 sm:!px-4 !py-1.5 sm:!py-2 !text-xs sm:!text-sm font-700 whitespace-nowrap flex-none flex items-center gap-1 sm:gap-1.5"
            onClick={() => onLeave("next")}
            title={t("ctl.next")}
            aria-label={t("ctl.next")}
          >
            <IconNext className="w-3.5 h-3.5 sm:w-4.5 sm:h-4.5" />
            <span>{t("ctl.next")}</span>
          </button>
          <button
            className={`btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] !p-1.5 sm:!p-2.5 flex-none ${cool ? "opacity-40" : "!text-[var(--c-amber)]"}`}
            onClick={report}
            title={t("ctl.report")}
            aria-label={t("ctl.report")}
          >
            <IconFlag className="w-4 h-4 sm:w-5 sm:h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
