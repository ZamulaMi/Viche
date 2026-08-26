/* ─────────────────────────────────────────────────────────────
   Viche · MediaStream Relayer (для ретрансляції відео рулетки в кімнату)

   Перетворює вхідний віддалений WebRTC-потік гостя рулетки (RouletteNet)
   на стабільний локальний MediaStream (через canvas render loop + WebAudio).
   Це усуває SSRC-колізії та порожні кадри в Chrome/Firefox/Safari при
   ретрансляції іншим учасникам кімнати (RoomNet).
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
