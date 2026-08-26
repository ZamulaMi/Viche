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
   аудіо-хвиля. Енергоефективні 12 FPS і компактна сцена — мінімальне навантаження на процесор. */
export function makeCanvasStream(label: string, hue: number): CanvasCtl {
  const W = 480;
  const H = 360; // 4:3 — компактний енергоефективний формат сцени Viche
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
    const cy = H / 2 - 10;
    // орбітальні кільця
    for (let i = 0; i < 3; i++) {
      const r = 72 + i * 22;
      const a0 = t * (0.25 + i * 0.14) * (i % 2 ? -1 : 1) + seed;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a0 + Math.PI * (1.1 - i * 0.22));
      ctx.strokeStyle = `hsla(${hue} 70% 62% / ${0.5 - i * 0.13})`;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
    // медальйон з ініціалами
    const rg = ctx.createRadialGradient(cx, cy, 6, cx, cy, 66);
    rg.addColorStop(0, `hsl(${hue} 45% 26%)`);
    rg.addColorStop(1, `hsl(${hue} 45% 15%)`);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, 64, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `hsla(${hue} 80% 70% / 0.75)`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = `hsl(${hue} 85% 78%)`;
    ctx.font = "700 44px Unbounded, Manrope, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label.slice(0, 2).toUpperCase(), cx, cy + 3);
    // аудіо-хвиля
    const bars = 24;
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const amp = speaking
        ? 10 + Math.abs(Math.sin(t * 5.2 + i * 0.9 + seed)) * 22
        : 4 + Math.abs(Math.sin(t * 1.4 + i * 0.7 + seed)) * 6;
      const x = i * bw;
      ctx.fillStyle = `hsla(${hue} 75% 65% / ${speaking ? 0.85 : 0.4})`;
      ctx.fillRect(x + bw * 0.24, H - 20 - amp, bw * 0.5, amp);
    }
    // позначка LIVE
    ctx.font = "500 11px 'JetBrains Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = speaking ? "hsla(152 70% 62% / 0.95)" : "hsla(0 0% 100% / 0.4)";
    ctx.fillText(speaking ? "● VOICE" : "○ IDLE", 12, 18);
  };

  const loop = (ts: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    if (document.hidden) return; // пропуск рендерингу у фоні
    if (ts - last < 80) return; // ~12 FPS
    last = ts;
    draw(ts / 1000);
  };

  if (reduced) {
    draw(1.2);
  } else {
    raf = requestAnimationFrame(loop);
  }

  const stream = canvas.captureStream(12);
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

export type SwitchCamResult = {
  facingMode: FacingMode;
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
};

export type LocalMedia = CanvasCtl & {
  stream: MediaStream;
  hasCam: boolean;
  facingMode: FacingMode;
  switchCamera: (target?: FacingMode) => Promise<SwitchCamResult>;
};

async function getCameraDevices(): Promise<{
  back: MediaDeviceInfo[];
  front: MediaDeviceInfo[];
  all: MediaDeviceInfo[];
}> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === "videoinput");
    const back = videoInputs.filter((d) => {
      const lbl = (d.label || "").toLowerCase();
      return /back|rear|environment|main|wide|ultra|0,\s*facing back|camera2\s*0|задн|основн|головн/.test(lbl);
    });
    const front = videoInputs.filter((d) => {
      const lbl = (d.label || "").toLowerCase();
      return /front|user|selfie|forward|1,\s*facing front|camera2\s*1|передн|фронт/.test(lbl);
    });
    return { back, front, all: videoInputs };
  } catch {
    return { back: [], front: [], all: [] };
  }
}

const THERMAL_SAFE_VIDEO = (mode?: FacingMode, deviceId?: string) => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : mode ? { facingMode: { ideal: mode } } : {}),
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 24, max: 30 },
});

const THERMAL_SAFE_AUDIO = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

async function acquireCameraTrack(
  targetMode: FacingMode,
  previousTrackId?: string,
): Promise<{ track: MediaStreamTrack; facing: FacingMode }> {
  const devs = await getCameraDevices();

  // 1. Спроба через exact facingMode (найнадійніший метод для сучасних Android та iOS Safari)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: targetMode },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 24, max: 30 },
      },
    });
    const tr = stream.getVideoTracks()[0];
    if (tr) {
      return { track: tr, facing: targetMode };
    }
  } catch {
    /* next */
  }

  // 2. Спроба через знайдений deviceId відповідного типу камери
  const targetList = targetMode === "environment" ? devs.back : devs.front;
  for (const dev of targetList) {
    if (dev.deviceId) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: THERMAL_SAFE_VIDEO(undefined, dev.deviceId),
        });
        const tr = stream.getVideoTracks()[0];
        if (tr) {
          return { track: tr, facing: targetMode };
        }
      } catch {
        /* next device */
      }
    }
  }

  // 3. Якщо є кілька камер і ми знаємо попередній ID, обираємо іншу камеру зі списку
  if (devs.all.length > 1) {
    const otherDev = devs.all.find((d) => d.deviceId && d.deviceId !== previousTrackId);
    if (otherDev?.deviceId) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: THERMAL_SAFE_VIDEO(undefined, otherDev.deviceId),
        });
        const tr = stream.getVideoTracks()[0];
        if (tr) {
          const lbl = (otherDev.label || "").toLowerCase();
          const isBack = /back|rear|environment|main|wide|0,\s*facing back|camera2\s*0|задн|основн/.test(lbl);
          const isFront = /front|user|selfie|1,\s*facing front|camera2\s*1|передн|фронт/.test(lbl);
          const detFacing: FacingMode = isBack ? "environment" : isFront ? "user" : targetMode;
          return { track: tr, facing: detFacing };
        }
      } catch {
        /* next */
      }
    }
  }

  // 4. Спроба з ideal facingMode
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: THERMAL_SAFE_VIDEO(targetMode),
    });
    const tr = stream.getVideoTracks()[0];
    if (tr) {
      const settings = tr.getSettings();
      const actualFacing: FacingMode = (settings.facingMode as FacingMode) || targetMode;
      return { track: tr, facing: actualFacing };
    }
  } catch {
    /* next */
  }

  // 5. Загальна спроба з простим facingMode
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: targetMode, frameRate: { ideal: 24, max: 30 } },
    });
    const tr = stream.getVideoTracks()[0];
    if (tr) {
      return { track: tr, facing: targetMode };
    }
  } catch {
    /* next */
  }

  throw new Error("Could not acquire camera track");
}

export async function getLocalStream(initialFacing: FacingMode = "user"): Promise<LocalMedia> {
  let currentFacing: FacingMode = initialFacing;

  try {
    // горизонтальна камера → 4:3; телефон у вертикалі сам віддасть 3:4
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        video: THERMAL_SAFE_VIDEO(currentFacing),
        audio: THERMAL_SAFE_AUDIO,
      });
    } catch {
      try {
        s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: currentFacing } },
          audio: true,
        });
      } catch {
        s = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
      }
    }

    const localObj: LocalMedia = {
      stream: s,
      hasCam: true,
      isReal: true,
      facingMode: currentFacing,
      setSpeaking: () => {},
      close: () => {
        s.getTracks().forEach((tr) => tr.stop());
        localObj.stream.getTracks().forEach((tr) => tr.stop());
      },
      switchCamera: async (target?: FacingMode) => {
        const nextMode: FacingMode = target ?? (currentFacing === "user" ? "environment" : "user");
        const oldVideoTracks = s.getVideoTracks();
        const oldTrack = oldVideoTracks[0];
        const oldTrackId = oldTrack?.getSettings()?.deviceId;

        // Зупиняємо старий відеотрек, щоб звільнити доступ до сенсора камери
        oldVideoTracks.forEach((tr) => {
          try {
            tr.stop();
            s.removeTrack(tr);
          } catch {
            /* noop */
          }
        });

        let acquired: { track: MediaStreamTrack; facing: FacingMode };
        try {
          acquired = await acquireCameraTrack(nextMode, oldTrackId);
        } catch (err) {
          // Якщо не вдалося відкрити нову камеру, спробуємо повернути попередню
          try {
            acquired = await acquireCameraTrack(currentFacing);
          } catch {
            throw err;
          }
        }

        s.addTrack(acquired.track);
        currentFacing = acquired.facing;
        localObj.facingMode = acquired.facing;

        // Створюємо оновлений MediaStream із новим відеотреком
        const audioTracks = s.getAudioTracks();
        const newStream = new MediaStream([acquired.track, ...audioTracks]);
        localObj.stream = newStream;

        return {
          facingMode: acquired.facing,
          stream: newStream,
          videoTrack: acquired.track,
        };
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
