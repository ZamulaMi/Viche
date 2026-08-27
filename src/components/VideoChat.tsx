import { useCallback, useEffect, useRef, useState } from "react";
import type { Peer } from "../lib/sim";
import { filterProfanity, now, randomPhrase } from "../lib/sim";
import type { FacingMode, LocalMedia } from "../lib/rtc";
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
  peerMicOn?: boolean;
  onMicToggle?: (on: boolean) => void;
  peerCamOn?: boolean;
  onCamToggle?: (on: boolean) => void;
  /** реальний текстовий чат (лише для мережевої пари) */
  chat?: { send: (text: string) => void; subscribe: (fn: (text: string) => void) => () => void };
  localMedia: LocalMedia | null;
  onStreamUpdate?: (stream: MediaStream, videoTrack?: MediaStreamTrack) => void;
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
  peerMicOn,
  onMicToggle,
  peerCamOn,
  onCamToggle,
  chat,
  localMedia,
  onStreamUpdate,
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
  const [remoteTrackMuted, setRemoteTrackMuted] = useState(false);
  const [remoteVideoTrackMuted, setRemoteVideoTrackMuted] = useState(false);
  const [cool, setCool] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);
  const [facingMode, setFacingMode] = useState<FacingMode>(localMedia?.facingMode ?? "user");
  const [switchingCam, setSwitchingCam] = useState(false);

  /* перетягування та магнітне прилипання (snap to edge) PiP-вікна */
  const pipRef = useRef<HTMLDivElement>(null);
  const [pipPos, setPipPos] = useState<{ x: number; y: number } | null>(null);
  const [isDraggingPip, setIsDraggingPip] = useState(false);
  const dragStartRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const handlePipPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Якщо клік на кнопку (наприклад перемикач камери), не ініціюємо перетягування
    if ((e.target as HTMLElement).closest("button")) return;
    const pipEl = pipRef.current;
    const containerEl = boxRef.current;
    if (!pipEl || !containerEl) return;

    e.preventDefault();
    const pipRect = pipEl.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();

    const currentX = pipRect.left - containerRect.left;
    const currentY = pipRect.top - containerRect.top;

    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: currentX,
      origY: currentY,
    };
    setIsDraggingPip(true);

    const onPointerMove = (moveEv: PointerEvent) => {
      if (!dragStartRef.current || !pipRef.current || !boxRef.current) return;
      const cRect = boxRef.current.getBoundingClientRect();
      const pRect = pipRef.current.getBoundingClientRect();
      const dx = moveEv.clientX - dragStartRef.current.startX;
      const dy = moveEv.clientY - dragStartRef.current.startY;

      const minX = 8;
      const minY = 8;
      const maxX = Math.max(minX, cRect.width - pRect.width - 8);
      const maxY = Math.max(minY, cRect.height - pRect.height - 8);

      let rawX = dragStartRef.current.origX + dx;
      let rawY = dragStartRef.current.origY + dy;

      // Магнітне притягання при наближенні до країв під час руху
      const snapThreshold = 24;
      if (rawX - minX < snapThreshold) rawX = minX;
      else if (maxX - rawX < snapThreshold) rawX = maxX;

      if (rawY - minY < snapThreshold) rawY = minY;
      else if (maxY - rawY < snapThreshold) rawY = maxY;

      const nextX = Math.min(Math.max(minX, rawX), maxX);
      const nextY = Math.min(Math.max(minY, rawY), maxY);

      setPipPos({ x: nextX, y: nextY });
    };

    const onPointerUp = () => {
      dragStartRef.current = null;
      setIsDraggingPip(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);

      // Автоматичне примагнічування до найближчого краю або кута після відпускання
      setPipPos((prev) => {
        if (!prev || !boxRef.current || !pipRef.current) return prev;
        const cRect = boxRef.current.getBoundingClientRect();
        const pRect = pipRef.current.getBoundingClientRect();

        const padX = cRect.width < 640 ? 8 : 12;
        const padTop = 50; // безпечний відступ від верхнього статусу
        const padBottom = 72; // безпечний відступ від нижньої панелі керування

        const minX = padX;
        const maxX = Math.max(minX, cRect.width - pRect.width - padX);
        const minY = padTop;
        const maxY = Math.max(minY, cRect.height - pRect.height - padBottom);

        // Примагнічуємо до лівого або правого краю
        const snapLeft = prev.x + pRect.width / 2 < cRect.width / 2;
        const snappedX = snapLeft ? minX : maxX;

        // По вертикалі: якщо близько до верху/низу — примагнічуємо до кутів, інакше зберігаємо плавне положення
        let snappedY = prev.y;
        const vSnapThreshold = 48;
        if (prev.y - minY < vSnapThreshold) {
          snappedY = minY;
        } else if (maxY - prev.y < vSnapThreshold) {
          snappedY = maxY;
        } else {
          snappedY = Math.min(Math.max(minY, prev.y), maxY);
        }

        return { x: snappedX, y: snappedY };
      });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  useEffect(() => {
    const handleResize = () => {
      setPipPos((prev) => {
        if (!prev || !boxRef.current || !pipRef.current) return prev;
        const cRect = boxRef.current.getBoundingClientRect();
        const pRect = pipRef.current.getBoundingClientRect();
        const padX = cRect.width < 640 ? 8 : 12;
        const padTop = 50;
        const padBottom = 72;
        const minX = padX;
        const maxX = Math.max(minX, cRect.width - pRect.width - padX);
        const minY = padTop;
        const maxY = Math.max(minY, cRect.height - pRect.height - padBottom);

        const snapLeft = prev.x + pRect.width / 2 < cRect.width / 2;
        const snappedX = snapLeft ? minX : maxX;
        const clampedY = Math.min(Math.max(minY, prev.y), maxY);

        return { x: snappedX, y: clampedY };
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const peerLang = peer.langs.includes("uk") ? "uk" : "en";

  const push = useCallback((from: Msg["from"], text: string) => {
    setMsgs((m) => [...m.slice(-70), { id: ++mid, from, text, time: now() }]);
    if (from === "peer") setUnread((u) => u + 1);
  }, []);

  /* підключення медіа: швидкий запуск без переривання декодера */
  useEffect(() => {
    const v = remoteRef.current;
    if (!v) return;
    if (remoteStream) {
      if (v.srcObject !== remoteStream) {
        v.srcObject = remoteStream;
      }
      const playPromise = v.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {});
      }
    } else {
      v.srcObject = null;
    }
  }, [remoteStream]);

  /* відстеження вимкнення аудіотреку співрозмовника через WebRTC події */
  useEffect(() => {
    if (!remoteStream) return;
    const audioTrack = remoteStream.getAudioTracks()[0];
    if (!audioTrack) {
      setRemoteTrackMuted(false);
      return;
    }
    setRemoteTrackMuted(!audioTrack.enabled || audioTrack.muted);
    const onMute = () => setRemoteTrackMuted(true);
    const onUnmute = () => setRemoteTrackMuted(false);
    audioTrack.addEventListener("mute", onMute);
    audioTrack.addEventListener("unmute", onUnmute);
    audioTrack.addEventListener("ended", onMute);
    return () => {
      audioTrack.removeEventListener("mute", onMute);
      audioTrack.removeEventListener("unmute", onUnmute);
      audioTrack.removeEventListener("ended", onMute);
    };
  }, [remoteStream]);

  /* відстеження вимкнення відеотреку співрозмовника через WebRTC події */
  useEffect(() => {
    if (!remoteStream) return;
    const videoTrack = remoteStream.getVideoTracks()[0];
    if (!videoTrack) {
      setRemoteVideoTrackMuted(false);
      return;
    }
    setRemoteVideoTrackMuted(!videoTrack.enabled || videoTrack.muted);
    const onMute = () => setRemoteVideoTrackMuted(true);
    const onUnmute = () => setRemoteVideoTrackMuted(false);
    videoTrack.addEventListener("mute", onMute);
    videoTrack.addEventListener("unmute", onUnmute);
    videoTrack.addEventListener("ended", onMute);
    return () => {
      videoTrack.removeEventListener("mute", onMute);
      videoTrack.removeEventListener("unmute", onUnmute);
      videoTrack.removeEventListener("ended", onMute);
    };
  }, [remoteStream]);

  useEffect(() => {
    const v = localRef.current;
    if (v && localMedia?.isReal) {
      v.srcObject = localMedia.stream;
      v.onloadedmetadata = () => v.play().catch(() => {});
      v.play().catch(() => {});
    }
    if (localMedia?.facingMode) {
      setFacingMode(localMedia.facingMode);
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

  /* індикатор мовлення: легкий VAD за аудіо-треком (інтервальний аналіз без навантаження на CPU) */
  useEffect(() => {
    let stopFn: (() => void) | null = null;
    const hasAudio = !!remoteStream && remoteStream.getAudioTracks().length > 0;
    if (hasAudio && remoteStream) {
      let ctx: AudioContext | null = null;
      let timer = 0;
      let prevSpeaking = false;
      try {
        const AudioCtxClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioCtxClass) {
          ctx = new AudioCtxClass();
          const src = ctx.createMediaStreamSource(remoteStream);
          const an = ctx.createAnalyser();
          an.fftSize = 128;
          src.connect(an);
          const buf = new Uint8Array(an.fftSize);

          timer = window.setInterval(() => {
            if (!ctx || ctx.state === "closed") return;
            an.getByteTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i += 2) {
              const d = (buf[i] - 128) / 128;
              sum += d * d;
            }
            const s = Math.sqrt(sum / (buf.length / 2)) > 0.045;
            if (s !== prevSpeaking) {
              prevSpeaking = s;
              setSpeaking(s);
              setRemoteSpeaking(s);
            }
          }, 180);

          stopFn = () => {
            window.clearInterval(timer);
            try {
              src.disconnect();
              an.disconnect();
              ctx?.close().catch(() => {});
            } catch {
              /* noop */
            }
          };
        }
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
      }, 2600);
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
      const next = !v;
      localMedia?.stream.getAudioTracks().forEach((tr) => (tr.enabled = next));
      onMicToggle?.(next);
      return next;
    });
  };
  const toggleCam = () => {
    setCamOn((v) => {
      const next = !v;
      localMedia?.stream.getVideoTracks().forEach((tr) => (tr.enabled = next));
      onCamToggle?.(next);
      return next;
    });
  };

  const handleSwitchCam = async () => {
    if (!localMedia?.isReal || !localMedia?.switchCamera || switchingCam) return;
    setSwitchingCam(true);
    try {
      const res = await localMedia.switchCamera();
      const newMode = res.facingMode;
      setFacingMode(newMode);
      onToast(newMode === "environment" ? t("video.camBack") : t("video.camFront"), "ok");

      // Повідомляємо WebRTC з'єднання про новий трек
      onStreamUpdate?.(res.stream, res.videoTrack);

      // Оновлюємо та перезапускаємо відтворення у локальному PiP-відео
      if (localRef.current) {
        localRef.current.srcObject = null;
        localRef.current.srcObject = res.stream;
        try {
          localRef.current.load();
        } catch {
          /* noop */
        }
        localRef.current.play().catch(() => {});
      }
    } catch {
      onToast(t("toast.noMultiCam"), "warn");
    } finally {
      setSwitchingCam(false);
    }
  };

  const resetHideTimer = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (isFull && !chatOpen) {
      hideTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false);
      }, 2000);
    }
  }, [isFull, chatOpen]);

  useEffect(() => {
    if (!isFull) {
      if (hideTimerRef.current) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setControlsVisible(true);
      return;
    }

    resetHideTimer();

    const handleUserActivity = () => {
      resetHideTimer();
    };

    window.addEventListener("mousemove", handleUserActivity, { passive: true });
    window.addEventListener("pointermove", handleUserActivity, { passive: true });
    window.addEventListener("pointerdown", handleUserActivity, { passive: true });
    window.addEventListener("touchstart", handleUserActivity, { passive: true });
    window.addEventListener("keydown", handleUserActivity, { passive: true });

    return () => {
      if (hideTimerRef.current) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      window.removeEventListener("mousemove", handleUserActivity);
      window.removeEventListener("pointermove", handleUserActivity);
      window.removeEventListener("pointerdown", handleUserActivity);
      window.removeEventListener("touchstart", handleUserActivity);
      window.removeEventListener("keydown", handleUserActivity);
    };
  }, [isFull, resetHideTimer]);

  useEffect(() => {
    const handleFsChange = () => {
      const isDocFull = !!(
        document.fullscreenElement ||
        (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement
      );
      if (!isDocFull && isFull) {
        setIsFull(false);
        setControlsVisible(true);
      }
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    document.addEventListener("webkitfullscreenchange", handleFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFsChange);
      document.removeEventListener("webkitfullscreenchange", handleFsChange);
    };
  }, [isFull]);

  const enterFs = async () => {
    setIsFull(true);
    resetHideTimer();
    await enterFullscreen(boxRef.current);
  };

  const exitFs = async () => {
    setIsFull(false);
    setControlsVisible(true);
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
      onPointerMove={resetHideTimer}
      onPointerDown={resetHideTimer}
      onTouchStart={resetHideTimer}
      onClick={resetHideTimer}
      className={`${
        isFull
          ? `fixed inset-0 z-[9999] w-screen h-[100dvh] bg-black overflow-hidden select-none ${
              !controlsVisible ? "cursor-none" : "cursor-default"
            }`
          : "absolute inset-0 bg-black overflow-visible"
      }`}
    >
      {/* remote: відео займає максимальну доступну площу без обрізки та без затримок адаптації */}
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
      {(() => {
        const effectivePeerMic = peerMicOn !== undefined ? peerMicOn : !remoteTrackMuted;
        const effectivePeerCam = peerCamOn !== undefined ? peerCamOn : !remoteVideoTrackMuted;
        return (
          <div
            className={`absolute top-2 sm:top-3 left-2 sm:left-3 right-2 sm:right-3 ${
              isFull ? "pt-[env(safe-area-inset-top,10px)]" : "pt-[env(safe-area-inset-top,0px)]"
            } flex items-start justify-between gap-2 z-20 pointer-events-none transition-all duration-500 ease-in-out ${
              isFull && !controlsVisible
                ? "opacity-0 -translate-y-2 pointer-events-none"
                : "opacity-100 translate-y-0"
            }`}
          >
            <div className="flex items-center gap-2 sm:gap-2.5 rounded-xl bg-[color-mix(in_srgb,var(--c-bg)_76%,transparent)] backdrop-blur-md border border-[var(--c-line)] px-2.5 sm:px-3.5 py-1.5 sm:py-2 pointer-events-auto shadow-sm">
              <span className="led led-mint" />
              <div className="leading-tight">
                <p className="font-mono text-[9px] sm:text-[10px] tracking-[0.18em] text-[var(--c-mint)]">{t("state.live")}</p>
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <p className="text-xs sm:text-sm font-700 text-[var(--c-text)] truncate max-w-[110px] sm:max-w-[170px]">
                    {peer.name}
                    {!peer.real && <span className="font-mono text-[10px] sm:text-[11px] text-[var(--c-dim)]"> · {peer.ping}ms</span>}
                    {peer.real && <span className="font-mono text-[10px] sm:text-[11px] text-[var(--c-mint)]"> · p2p</span>}
                  </p>
                  <span
                    className={`inline-flex items-center justify-center p-1 rounded-md border backdrop-blur-sm ${
                      effectivePeerMic
                        ? "text-emerald-400 border-emerald-500/40 bg-emerald-950/60 shadow-[0_0_8px_rgba(52,211,153,0.25)]"
                        : "text-rose-400 border-rose-500/40 bg-rose-950/60 shadow-[0_0_8px_rgba(244,63,94,0.25)]"
                    }`}
                    title={effectivePeerMic ? "Мікрофон співрозмовника увімкнено" : "Мікрофон співрозмовника вимкнено"}
                  >
                    {effectivePeerMic ? (
                      <IconMic className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <IconMicOff className="w-3.5 h-3.5 text-rose-400" />
                    )}
                  </span>
                  <span
                    className={`inline-flex items-center justify-center p-1 rounded-md border backdrop-blur-sm ${
                      effectivePeerCam
                        ? "text-emerald-400 border-emerald-500/40 bg-emerald-950/60 shadow-[0_0_8px_rgba(52,211,153,0.25)]"
                        : "text-rose-400 border-rose-500/40 bg-rose-950/60 shadow-[0_0_8px_rgba(244,63,94,0.25)]"
                    }`}
                    title={effectivePeerCam ? "Камера співрозмовника увімкнена" : "Камера співрозмовника вимкнена"}
                  >
                    {effectivePeerCam ? (
                      <IconCam className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <IconCamOff className="w-3.5 h-3.5 text-rose-400" />
                    )}
                  </span>
                </div>
              </div>
            </div>
            <div className="hidden sm:flex flex-col items-end gap-1.5 pointer-events-auto">
              <div className={`flex items-center gap-[3px] h-7 px-2.5 rounded-lg backdrop-blur-md border ${
                effectivePeerMic
                  ? "bg-[color-mix(in_srgb,var(--c-bg)_72%,transparent)] border-[var(--c-line)]"
                  : "bg-rose-950/40 border-rose-500/30"
              }`}>
                {effectivePeerMic ? (
                  [0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className="w-[3px] rounded-full bg-emerald-400 transition-all duration-300"
                      style={{ height: speaking ? `${10 + ((i * 7 + peer.ping) % 14)}px` : "4px" }}
                    />
                  ))
                ) : (
                  <span className="font-mono text-[10px] text-rose-400 flex items-center gap-1 font-600">
                    <IconMicOff className="w-3 h-3 text-rose-400" /> mute
                  </span>
                )}
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
        );
      })()}

      {/* локальне відео (PiP з можливістю вільного перетягування та примагнічування до країв) */}
      <div
        ref={pipRef}
        onPointerDown={handlePipPointerDown}
        style={pipPos ? { left: `${pipPos.x}px`, top: `${pipPos.y}px` } : undefined}
        className={`absolute ${
          pipPos ? "" : "right-2 sm:right-3 bottom-14 sm:bottom-20"
        } w-24 sm:w-36 md:w-44 aspect-[4/3] rounded-lg overflow-hidden border border-[var(--c-line2)] shadow-[var(--c-shadow)] z-20 bg-black touch-none select-none cursor-grab active:cursor-grabbing ${
          isDraggingPip
            ? "transition-none ring-2 ring-[var(--c-amber)] shadow-2xl scale-[1.03]"
            : "transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:border-[var(--c-amber)]/60"
        }`}
        title="Перетягуйте вікно (примагнічується до країв)"
      >
        {localMedia?.isReal ? (
          <video
            ref={localRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-contain bg-black pointer-events-none transition-transform duration-300 ${
              facingMode === "environment" ? "scale-x-100" : "-scale-x-100"
            }`}
          />
        ) : (
          <div className="w-full h-full grid place-items-center pointer-events-none">
            <span className="font-display text-xl sm:text-2xl text-[var(--c-amber)]">TI</span>
          </div>
        )}
        {!camOn && (
          <div className="absolute inset-0 bg-[var(--c-bg)] grid place-items-center pointer-events-none">
            <IconCamOff className="w-5 h-5 sm:w-6 sm:h-6 text-[var(--c-faint)]" />
          </div>
        )}
        <div className="absolute top-1 left-1.5 flex items-center gap-1.5 z-30 pointer-events-none">
          <span className="font-mono text-[9px] sm:text-[10px] tracking-widest text-[var(--c-mint)]">{t("video.you")}</span>
          <span
            className={`inline-flex items-center justify-center p-0.5 rounded border backdrop-blur-sm ${
              micOn
                ? "text-emerald-400 border-emerald-500/40 bg-emerald-950/60"
                : "text-rose-400 border-rose-500/40 bg-rose-950/60"
            }`}
            title={micOn ? "Ваш мікрофон увімкнено" : "Ваш мікрофон вимкнено"}
          >
            {micOn ? <IconMic className="w-2.5 h-2.5 text-emerald-400" /> : <IconMicOff className="w-2.5 h-2.5 text-rose-400" />}
          </span>
          <span
            className={`inline-flex items-center justify-center p-0.5 rounded border backdrop-blur-sm ${
              camOn
                ? "text-emerald-400 border-emerald-500/40 bg-emerald-950/60"
                : "text-rose-400 border-rose-500/40 bg-rose-950/60"
            }`}
            title={camOn ? "Ваша камера увімкнена" : "Ваша камера вимкнена"}
          >
            {camOn ? <IconCam className="w-2.5 h-2.5 text-emerald-400" /> : <IconCamOff className="w-2.5 h-2.5 text-rose-400" />}
          </span>
          {localMedia?.hasCam && (
            <span className="font-mono text-[8px] sm:text-[9px] px-1 py-0.2 rounded bg-black/60 text-[var(--c-faint)] uppercase">
              {facingMode === "environment" ? "rear" : "front"}
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
      <div
        className={`absolute ${
          isFull
            ? "bottom-2 sm:bottom-4 pb-[env(safe-area-inset-bottom,8px)]"
            : "bottom-2 sm:bottom-4 pb-[env(safe-area-inset-bottom,0px)]"
        } left-1/2 -translate-x-1/2 z-30 flex justify-center px-1 pointer-events-none w-full max-w-[calc(100vw-8px)] sm:max-w-max transition-all duration-500 ease-in-out ${
          isFull && !controlsVisible
            ? "opacity-0 translate-y-4 pointer-events-none"
            : "opacity-100 translate-y-0"
        }`}
      >
        <div className="pointer-events-auto flex items-center justify-center gap-1 sm:gap-1.5 p-1 sm:p-1.5 bg-[color-mix(in_srgb,var(--c-bg)_82%,transparent)] backdrop-blur-md rounded-xl sm:rounded-2xl border border-[var(--c-line)] shadow-lg max-w-full overflow-x-auto no-scrollbar">
          <button
            className={`btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] !p-1.5 sm:!p-2.5 flex-none transition-all ${
              micOn
                ? "!text-emerald-400 !border-emerald-500/40 bg-emerald-950/40 hover:bg-emerald-950/60"
                : "!text-rose-400 !border-rose-500/50 bg-rose-950/40 hover:bg-rose-950/60"
            }`}
            onClick={toggleMic}
            title={micOn ? t("video.mic") : t("video.mic")}
            aria-label={t("video.mic")}
          >
            {micOn ? <IconMic className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400" /> : <IconMicOff className="w-4 h-4 sm:w-5 sm:h-5 text-rose-400" />}
          </button>
          <button
            className={`btn btn-icon min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] !p-1.5 sm:!p-2.5 flex-none transition-all ${
              camOn
                ? "!text-emerald-400 !border-emerald-500/40 bg-emerald-950/40 hover:bg-emerald-950/60"
                : "!text-rose-400 !border-rose-500/50 bg-rose-950/40 hover:bg-rose-950/60"
            }`}
            onClick={toggleCam}
            title={t("video.cam")}
            aria-label={t("video.cam")}
          >
            {camOn ? <IconCam className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400" /> : <IconCamOff className="w-4 h-4 sm:w-5 sm:h-5 text-rose-400" />}
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
