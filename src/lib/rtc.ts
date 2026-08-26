/* ─────────────────────────────────────────────────────────────
   Viche · WebRTC helpers
   - makeCanvasStream: легкий процедурний "аватар" (canvas →
     MediaStream, 15 FPS — береже CPU/RAM, див. архітектуру).
   - getLocalStream: getUserMedia з м'яким фолбеком.
   - loopbackConnect: справжній RTCPeerConnection-конвеєр
     (offer/answer/ICE, DTLS/SRTP) — у демо медіа йде через
     нього, у продакшн — сигнали передає server/handler.go.
   ───────────────────────────────────────────────────────────── */

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    // Продакшн (coturn з docker-compose.yml):
    // { urls: "turn:turn.viche.app:3478", username: "viche", credential: "secret" },
  ],
  bundlePolicy: "max-bundle",
};

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export type CanvasCtl = {
  stream: MediaStream;
  setSpeaking: (b: boolean) => void;
  close: () => void;
  isReal: boolean;
};

/* Процедурний аватар: кільця, що обертаються + ініціали +
   аудіо-хвиля. 15 FPS навмисно — медіа-енкодеру цього
   достатньо, а CPU навантаження мінімальне.                   */
export function makeCanvasStream(label: string, hue: number): CanvasCtl {
  const W = 640;
  const H = 480; // 4:3 — базовий формат сцени Viche
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  let speaking = false;
  let raf = 0;
  let last = 0;
  let alive = true;
  const reduced = prefersReducedMotion();
  const seed = Math.random() * 100;

  const draw = (t: number) => {
    // фон
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsl(${hue} 24% 8%)`);
    g.addColorStop(1, `hsl(${hue} 30% 12%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2 - 14;
    // орбітальні кільця
    for (let i = 0; i < 3; i++) {
      const r = 96 + i * 30;
      const a0 = t * (0.25 + i * 0.14) * (i % 2 ? -1 : 1) + seed;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a0 + Math.PI * (1.1 - i * 0.22));
      ctx.strokeStyle = `hsla(${hue} 70% 62% / ${0.5 - i * 0.13})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // медальйон з ініціалами
    const rg = ctx.createRadialGradient(cx, cy, 8, cx, cy, 88);
    rg.addColorStop(0, `hsl(${hue} 45% 26%)`);
    rg.addColorStop(1, `hsl(${hue} 45% 15%)`);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, 84, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `hsla(${hue} 80% 70% / 0.75)`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = `hsl(${hue} 85% 78%)`;
    ctx.font = "700 58px Unbounded, Manrope, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label.slice(0, 2).toUpperCase(), cx, cy + 4);
    // аудіо-хвиля
    const bars = 30;
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const amp = speaking
        ? 14 + Math.abs(Math.sin(t * 5.2 + i * 0.9 + seed)) * 30
        : 5 + Math.abs(Math.sin(t * 1.4 + i * 0.7 + seed)) * 9;
      const x = i * bw;
      ctx.fillStyle = `hsla(${hue} 75% 65% / ${speaking ? 0.85 : 0.4})`;
      ctx.fillRect(x + bw * 0.24, H - 26 - amp, bw * 0.5, amp);
    }
    // позначка LIVE
    ctx.font = "500 13px 'JetBrains Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = speaking ? "hsla(152 70% 62% / 0.95)" : "hsla(0 0% 100% / 0.4)";
    ctx.fillText(speaking ? "● VOICE" : "○ IDLE", 16, 24);
    // віньєтка
    const v = ctx.createRadialGradient(cx, H / 2, H * 0.35, cx, H / 2, H * 0.95);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.42)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  };

  const loop = (ts: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    if (ts - last < 66) return; // ~15 FPS
    last = ts;
    draw(ts / 1000);
  };

  if (reduced) {
    draw(1.2);
  } else {
    raf = requestAnimationFrame(loop);
  }

  const stream = canvas.captureStream(15);
  return {
    stream,
    isReal: false,
    setSpeaking(b: boolean) {
      speaking = b;
      if (reduced && alive) draw(1.2 + (b ? 0.9 : 0));
    },
    close() {
      alive = false;
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((tr) => tr.stop());
    },
  };
}

export type FacingMode = "user" | "environment";

export type LocalMedia = CanvasCtl & {
  stream: MediaStream;
  hasCam: boolean;
  facingMode: FacingMode;
  switchCamera: (target?: FacingMode) => Promise<FacingMode>;
};

export async function getLocalStream(initialFacing: FacingMode = "user"): Promise<LocalMedia> {
  let currentFacing: FacingMode = initialFacing;

  try {
    // горизонтальна камера → 4:3; телефон у вертикалі сам віддасть 3:4
    const s = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: currentFacing },
        width: { ideal: 640 },
        height: { ideal: 480 },
        aspectRatio: { ideal: 4 / 3 },
      },
      audio: true,
    });

    const localObj: LocalMedia = {
      stream: s,
      hasCam: true,
      isReal: true,
      facingMode: currentFacing,
      setSpeaking: () => {},
      close: () => s.getTracks().forEach((tr) => tr.stop()),
      switchCamera: async (target?: FacingMode) => {
        const nextMode: FacingMode = target ?? (currentFacing === "user" ? "environment" : "user");
        let newVideoStream: MediaStream | null = null;

        // 1. Спроба з точним facingMode
        try {
          newVideoStream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { exact: nextMode },
              width: { ideal: 640 },
              height: { ideal: 480 },
              aspectRatio: { ideal: 4 / 3 },
            },
          });
        } catch {
          // 2. Спроба з ideal facingMode
          try {
            newVideoStream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: nextMode },
                width: { ideal: 640 },
                height: { ideal: 480 },
                aspectRatio: { ideal: 4 / 3 },
              },
            });
          } catch {
            // 3. Спроба перелічити відеопристрої та обрати альтернативну камеру
            try {
              const devices = await navigator.mediaDevices.enumerateDevices();
              const videoInputs = devices.filter((d) => d.kind === "videoinput");
              const currentTrack = s.getVideoTracks()[0];
              const curId = currentTrack?.getSettings()?.deviceId;
              const nextDevice =
                videoInputs.find((d) => {
                  const lbl = d.label.toLowerCase();
                  if (nextMode === "environment") {
                    return (
                      lbl.includes("back") ||
                      lbl.includes("rear") ||
                      lbl.includes("environment") ||
                      lbl.includes("основн") ||
                      lbl.includes("задн")
                    );
                  }
                  return (
                    lbl.includes("front") ||
                    lbl.includes("user") ||
                    lbl.includes("selfie") ||
                    lbl.includes("передн") ||
                    lbl.includes("фронт")
                  );
                }) || videoInputs.find((d) => curId && d.deviceId !== curId) || videoInputs[0];

              if (nextDevice && nextDevice.deviceId !== curId) {
                newVideoStream = await navigator.mediaDevices.getUserMedia({
                  video: {
                    deviceId: { exact: nextDevice.deviceId },
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    aspectRatio: { ideal: 4 / 3 },
                  },
                });
              }
            } catch {
              /* noop */
            }
          }
        }

        if (!newVideoStream || newVideoStream.getVideoTracks().length === 0) {
          throw new Error("No alternative video camera found");
        }

        const newVideoTrack = newVideoStream.getVideoTracks()[0];
        const oldTracks = s.getVideoTracks();
        oldTracks.forEach((tr) => {
          tr.stop();
          s.removeTrack(tr);
        });

        s.addTrack(newVideoTrack);
        currentFacing = nextMode;
        localObj.facingMode = nextMode;
        return nextMode;
      },
    };

    return localObj;
  } catch {
    try {
      // Спроба отримати хоча б мікрофон, якщо відеокамера зайнята чи відхилена
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const c = makeCanvasStream("TI", 42);
      const combined = new MediaStream([
        ...c.stream.getVideoTracks(),
        ...audioStream.getAudioTracks(),
      ]);
      return {
        stream: combined,
        hasCam: false,
        isReal: true,
        facingMode: "user",
        setSpeaking: c.setSpeaking,
        close: () => {
          c.close();
          audioStream.getTracks().forEach((tr) => tr.stop());
        },
        switchCamera: async () => {
          throw new Error("No real camera available");
        },
      };
    } catch {
      const c = makeCanvasStream("TI", 42);
      return {
        ...c,
        hasCam: false,
        facingMode: "user",
        switchCamera: async () => {
          throw new Error("No real camera available");
        },
      };
    }
  }
}

export function stopStream(s: MediaStream | null | undefined) {
  s?.getTracks().forEach((tr) => tr.stop());
}

const waitIce = (pc: RTCPeerConnection) =>
  new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    let to = 0;
    const done = () => {
      window.clearTimeout(to);
      pc.removeEventListener("icegatheringstatechange", onch);
      resolve();
    };
    to = window.setTimeout(done, 1500);
    const onch = () => pc.iceGatheringState === "complete" && done();
    pc.addEventListener("icegatheringstatechange", onch);
  });

/* Два RTCPeerConnection у одному браузері: повний конвеєр
   (offer → answer → ICE → DTLS/SRTP) без сервера.             */
export async function loopbackConnect(source: MediaStream) {
  const a = new RTCPeerConnection(RTC_CONFIG);
  const b = new RTCPeerConnection(RTC_CONFIG);
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});

  const remote = new MediaStream();
  b.ontrack = (e) => remote.addTrack(e.track);

  source.getTracks().forEach((tr) => a.addTrack(tr, source));

  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(answer);

  await Promise.all([waitIce(a), waitIce(b)]);
  return {
    stream: remote,
    close() {
      a.close();
      b.close();
    },
  };
}
