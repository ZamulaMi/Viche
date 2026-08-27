/* ─────────────────────────────────────────────────────────────
   Viche · MediaStream Relayer & RoomStreamCompositor
   (для ретрансляції відео рулетки в кімнату та кімнати в рулетку)

   1. StreamRelay: перетворює вхідний віддалений WebRTC-потік гостя рулетки
      на стабільний локальний MediaStream (через canvas render loop + WebAudio).
   2. RoomStreamCompositor: компонує потоки 1 або 2 учасників кімнати
      (розподіл екрана навпіл при двох учасниках + мікшування звуку)
      для передачі випадковому гостю з рулетки.
   ───────────────────────────────────────────────────────────── */

export class StreamRelay {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private audioCtx: AudioContext | null = null;
  private animId: number = 0;
  public relayedStream: MediaStream;
  private disposed = false;

  constructor(sourceStream: MediaStream) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.srcObject = sourceStream;
    this.video.play().catch(() => {});

    this.canvas = document.createElement("canvas");
    this.canvas.width = 640;
    this.canvas.height = 480;
    this.ctx = this.canvas.getContext("2d");

    // 1. Створюємо стабільний локальний відеотрек через canvas.captureStream (24 FPS для збереження заряду та процесора)
    const canvasStream = this.canvas.captureStream(24);
    const videoTrack = canvasStream.getVideoTracks()[0];

    // 2. Цикл відтворення кадрів з вхідного відео у canvas (енергоефективний троттлінг ~24 FPS)
    let lastRenderTime = 0;
    const render = (ts: number) => {
      if (this.disposed) return;
      this.animId = requestAnimationFrame(render);
      if (ts - lastRenderTime < 41) return; // ~24 FPS замість 60 FPS
      lastRenderTime = ts;

      if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.ctx) {
        const vw = this.video.videoWidth;
        const vh = this.video.videoHeight;
        if (vw > 0 && vh > 0) {
          if (this.canvas.width !== vw || this.canvas.height !== vh) {
            this.canvas.width = vw;
            this.canvas.height = vh;
          }
        }
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      }
    };
    this.animId = requestAnimationFrame(render);

    // 3. Створюємо стабільний локальний аудіотрек через WebAudio
    let audioTrack: MediaStreamTrack | null = null;
    try {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass && sourceStream.getAudioTracks().length > 0) {
        const actx = new AudioContextClass();
        this.audioCtx = actx;
        const src = actx.createMediaStreamSource(sourceStream);
        const dest = actx.createMediaStreamDestination();
        src.connect(dest);
        audioTrack = dest.stream.getAudioTracks()[0] ?? null;
      }
    } catch {
      if (sourceStream.getAudioTracks().length > 0) {
        audioTrack = sourceStream.getAudioTracks()[0];
      }
    }

    const tracks: MediaStreamTrack[] = [];
    if (videoTrack) tracks.push(videoTrack);
    else if (sourceStream.getVideoTracks().length > 0) {
      tracks.push(sourceStream.getVideoTracks()[0]);
    }
    if (audioTrack) tracks.push(audioTrack);

    this.relayedStream = new MediaStream(tracks);
  }

  updateSource(newSource: MediaStream) {
    if (this.disposed) return;
    this.video.srcObject = newSource;
    this.video.play().catch(() => {});
  }

  dispose() {
    this.disposed = true;
    if (this.animId) cancelAnimationFrame(this.animId);
    try {
      this.video.pause();
      this.video.srcObject = null;
    } catch {
      /* noop */
    }
    try {
      this.audioCtx?.close();
    } catch {
      /* noop */
    }
    try {
      this.relayedStream.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
  }
}

export type RoomSource = {
  id: string;
  name: string;
  stream: MediaStream;
  isSelf?: boolean;
  facingMode?: "user" | "environment";
};

/* Допоміжна функція малювання відео з правильним збереженням пропорцій (contain за замовчуванням для запобігання обрізці) */
function drawFittedVideo(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  w: number,
  h: number,
  mirror: boolean = false,
  fit: "contain" | "cover" = "contain"
) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const targetRatio = w / h;
  const videoRatio = vw / vh;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // Чистий чорний фон
  ctx.fillStyle = "#0c0a09";
  ctx.fillRect(x, y, w, h);

  if (fit === "contain") {
    // Повний кадр без обрізки зображення
    let dw = w;
    let dh = h;
    let dx = x;
    let dy = y;

    if (videoRatio > targetRatio) {
      dh = w / videoRatio;
      dy = y + (h - dh) / 2;
    } else {
      dw = h * videoRatio;
      dx = x + (w - dw) / 2;
    }

    if (mirror) {
      ctx.translate(dx + dw, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, vw, vh, 0, 0, dw, dh);
    } else {
      ctx.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh);
    }
  } else {
    let sx = 0,
      sy = 0,
      sw = vw,
      sh = vh;

    if (videoRatio > targetRatio) {
      // Відео ширше за слот — обрізаємо боки
      sw = vh * targetRatio;
      sx = (vw - sw) / 2;
    } else {
      // Відео вище за слот — обрізаємо зверху/знизу
      sh = vw / targetRatio;
      sy = (vh - sh) / 2;
    }

    if (mirror) {
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    } else {
      ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
    }
  }

  ctx.restore();
}

/* Композитор потоків кімнати: об'єднує 1 або 2 людей у єдиний потік для гостя з рулетки */
export class RoomStreamCompositor {
  private sources: RoomSource[] = [];
  private videoEls = new Map<string, HTMLVideoElement>();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private audioCtx: AudioContext | null = null;
  private audioDest: MediaStreamAudioDestinationNode | null = null;
  private audioSources = new Map<string, { src: MediaStreamAudioSourceNode; trackId: string }>();
  private animId = 0;
  public compositeStream: MediaStream;
  private disposed = false;
  public isPortrait: boolean = false;

  constructor(initialSources: RoomSource[] = [], isPortrait: boolean = false) {
    this.isPortrait = isPortrait;
    this.canvas = document.createElement("canvas");
    this.canvas.width = isPortrait ? 720 : 1280;
    this.canvas.height = isPortrait ? 1280 : 720;
    this.ctx = this.canvas.getContext("2d");

    try {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
        this.audioDest = this.audioCtx.createMediaStreamDestination();
      }
    } catch {
      /* noop */
    }

    const canvasStream = this.canvas.captureStream(24);
    const videoTrack = canvasStream.getVideoTracks()[0];
    const tracks: MediaStreamTrack[] = [];
    if (videoTrack) tracks.push(videoTrack);
    if (this.audioDest && this.audioDest.stream.getAudioTracks().length > 0) {
      tracks.push(this.audioDest.stream.getAudioTracks()[0]);
    }
    this.compositeStream = new MediaStream(tracks);

    this.updateSources(initialSources, isPortrait);
    this.startLoop();
  }

  setPortrait(isPortrait: boolean) {
    if (this.disposed) return;
    this.isPortrait = isPortrait;
    const targetW = isPortrait ? 720 : 1280;
    const targetH = isPortrait ? 1280 : 720;
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    this.draw();
  }

  updateSources(newSources: RoomSource[], isPortrait?: boolean) {
    if (this.disposed) return;
    if (typeof isPortrait === "boolean") {
      this.setPortrait(isPortrait);
    }
    this.sources = newSources.slice(0, 2); // підтримуємо 1 або 2 користувачів кімнати

    const activeIds = new Set(this.sources.map((s) => s.id));

    // Очищаємо застарілі відеоелементи
    for (const [id, el] of this.videoEls.entries()) {
      if (!activeIds.has(id)) {
        try {
          el.pause();
          el.srcObject = null;
        } catch {
          /* noop */
        }
        this.videoEls.delete(id);
      }
    }

    // Створюємо або оновлюємо відеоелементи та аудіоноди
    for (const s of this.sources) {
      let v = this.videoEls.get(s.id);
      if (!v) {
        v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.autoplay = true;
        this.videoEls.set(s.id, v);
      }
      if (v.srcObject !== s.stream) {
        v.srcObject = s.stream;
        v.play().catch(() => {});
      }

      // Мікшування аудіотреків
      if (this.audioCtx && this.audioDest) {
        const aTrack = s.stream.getAudioTracks()[0];
        const existing = this.audioSources.get(s.id);
        if (aTrack && (!existing || existing.trackId !== aTrack.id)) {
          try {
            existing?.src.disconnect();
          } catch {
            /* noop */
          }
          try {
            const src = this.audioCtx.createMediaStreamSource(s.stream);
            src.connect(this.audioDest);
            this.audioSources.set(s.id, { src, trackId: aTrack.id });
          } catch {
            /* noop */
          }
        } else if (!aTrack && existing) {
          try {
            existing.src.disconnect();
          } catch {
            /* noop */
          }
          this.audioSources.delete(s.id);
        }
      }
    }

    // Очищаємо застарілі аудіоноди
    for (const [id, a] of this.audioSources.entries()) {
      if (!activeIds.has(id)) {
        try {
          a.src.disconnect();
        } catch {
          /* noop */
        }
        this.audioSources.delete(id);
      }
    }

    this.draw();
  }

  private startLoop() {
    let last = 0;
    const render = (ts: number) => {
      if (this.disposed) return;
      this.animId = requestAnimationFrame(render);
      if (ts - last < 28) return; // ~35 FPS для миттєвого оновлення
      last = ts;
      this.draw();
    };
    this.animId = requestAnimationFrame(render);
  }

  private draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.fillStyle = "#0c0a08";
    ctx.fillRect(0, 0, W, H);

    const validSources = this.sources.filter((s) => s && s.stream);

    if (validSources.length === 0) {
      // Порожній стан
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.font = "600 14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Підключення до кімнати…", W / 2, H / 2);
      return;
    }

    if (validSources.length === 1) {
      // 1 користувач у кімнаті: відображення на весь екран
      const s0 = validSources[0];
      const v0 = this.videoEls.get(s0.id);
      const isReady = v0 && v0.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

      if (isReady && v0) {
        const mirror = !!(s0.isSelf && s0.facingMode !== "environment");
        drawFittedVideo(ctx, v0, 0, 0, W, H, mirror);
      } else {
        ctx.fillStyle = "#161310";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "rgba(235, 178, 95, 0.9)";
        ctx.font = "700 36px Unbounded, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText((s0.name || "K").slice(0, 2).toUpperCase(), W / 2, H / 2 - 8);
      }

      // Бейдж імені внизу
      this.drawNameTag(ctx, s0.name, 20, H - 52);
    } else {
      // 2 користувача у кімнаті
      const s0 = validSources[0];
      const s1 = validSources[1];
      const v0 = this.videoEls.get(s0.id);
      const v1 = this.videoEls.get(s1.id);

      const isPort = this.isPortrait;

      if (isPort && (this.canvas.width !== 720 || this.canvas.height !== 1280)) {
        this.canvas.width = 720;
        this.canvas.height = 1280;
      } else if (!isPort && (this.canvas.width !== 1280 || this.canvas.height !== 720)) {
        this.canvas.width = 1280;
        this.canvas.height = 720;
      }

      const curW = this.canvas.width;
      const curH = this.canvas.height;

      if (isPort) {
        // Портретний режим: вертикальне розташування один над одним (50% зверху, 50% знизу)
        const halfH = curH / 2;

        // Верхній слот (Користувач 1)
        if (v0 && v0.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const mirror = !!(s0.isSelf && s0.facingMode !== "environment");
          drawFittedVideo(ctx, v0, 0, 0, curW, halfH, mirror);
        } else {
          ctx.fillStyle = "#161310";
          ctx.fillRect(0, 0, curW, halfH);
          ctx.fillStyle = "rgba(235, 178, 95, 0.9)";
          ctx.font = "700 36px Unbounded, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText((s0.name || "K1").slice(0, 2).toUpperCase(), curW / 2, halfH / 2 - 12);
        }
        this.drawNameTag(ctx, s0.name, 16, halfH - 44);

        // Нижній слот (Користувач 2)
        if (v1 && v1.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const mirror = !!(s1.isSelf && s1.facingMode !== "environment");
          drawFittedVideo(ctx, v1, 0, halfH, curW, halfH, mirror);
        } else {
          ctx.fillStyle = "#1c1813";
          ctx.fillRect(0, halfH, curW, halfH);
          ctx.fillStyle = "rgba(75, 219, 154, 0.9)";
          ctx.font = "700 36px Unbounded, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText((s1.name || "K2").slice(0, 2).toUpperCase(), curW / 2, halfH + halfH / 2 - 12);
        }
        this.drawNameTag(ctx, s1.name, 16, curH - 44);

        // Горизонтальна лінія розподілу між верхнім і нижнім учасником
        ctx.strokeStyle = "rgba(235, 178, 95, 0.7)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, halfH);
        ctx.lineTo(curW, halfH);
        ctx.stroke();

        // Маленький індикатор кімнати по центру лінії розподілу
        ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
        ctx.beginPath();
        ctx.roundRect(curW / 2 - 56, halfH - 13, 112, 26, 6);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "rgba(235, 178, 95, 0.95)";
        ctx.font = "600 12px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("2 УЧАСНИКИ", curW / 2, halfH);
      } else {
        // Альбомний режим: горизонтальне розташування поруч (50% зліва, 50% справа)
        const halfW = curW / 2;

        // Ліва половина (Користувач 1)
        if (v0 && v0.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const mirror = !!(s0.isSelf && s0.facingMode !== "environment");
          drawFittedVideo(ctx, v0, 0, 0, halfW, curH, mirror);
        } else {
          ctx.fillStyle = "#161310";
          ctx.fillRect(0, 0, halfW, curH);
          ctx.fillStyle = "rgba(235, 178, 95, 0.9)";
          ctx.font = "700 36px Unbounded, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText((s0.name || "K1").slice(0, 2).toUpperCase(), halfW / 2, curH / 2 - 12);
        }
        this.drawNameTag(ctx, s0.name, 16, curH - 48);

        // Права половина (Користувач 2)
        if (v1 && v1.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const mirror = !!(s1.isSelf && s1.facingMode !== "environment");
          drawFittedVideo(ctx, v1, halfW, 0, halfW, curH, mirror);
        } else {
          ctx.fillStyle = "#1c1813";
          ctx.fillRect(halfW, 0, halfW, curH);
          ctx.fillStyle = "rgba(75, 219, 154, 0.9)";
          ctx.font = "700 36px Unbounded, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText((s1.name || "K2").slice(0, 2).toUpperCase(), halfW + halfW / 2, curH / 2 - 12);
        }
        this.drawNameTag(ctx, s1.name, halfW + 16, curH - 48);

        // Центральна лінія розподілу екрану навпіл
        ctx.strokeStyle = "rgba(235, 178, 95, 0.7)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(halfW, 0);
        ctx.lineTo(halfW, curH);
        ctx.stroke();

        // Маленький індикатор кімнати вгорі
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.beginPath();
        ctx.roundRect(halfW - 56, 12, 112, 26, 6);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "rgba(235, 178, 95, 0.95)";
        ctx.font = "600 12px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("2 УЧАСНИКИ", halfW, 25);
      }
    }
  }

  private drawNameTag(ctx: CanvasRenderingContext2D, name: string, x: number, y: number) {
    const text = (name || "Учасник").slice(0, 20);
    ctx.font = "600 14px sans-serif";
    const textWidth = ctx.measureText(text).width;
    const padX = 12;
    const tagW = textWidth + padX * 2;
    const tagH = 28;

    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.beginPath();
    ctx.roundRect(x, y, tagW, tagH, 6);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + padX, y + tagH / 2);
  }

  dispose() {
    this.disposed = true;
    if (this.animId) cancelAnimationFrame(this.animId);

    for (const v of this.videoEls.values()) {
      try {
        v.pause();
        v.srcObject = null;
      } catch {
        /* noop */
      }
    }
    this.videoEls.clear();

    for (const a of this.audioSources.values()) {
      try {
        a.src.disconnect();
      } catch {
        /* noop */
      }
    }
    this.audioSources.clear();

    try {
      this.audioCtx?.close();
    } catch {
      /* noop */
    }

    try {
      this.compositeStream.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
  }
}

