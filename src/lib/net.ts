/* ─────────────────────────────────────────────────────────────
   Viche · спільні мережеві утиліти (NAT traversal, ICE, відновлення)

   Використовуються і рулеткою (roulettenet.ts), і кімнатами (roomnet.ts).
   Сигналінг — публічний PeerJS-брокер; медіа — P2P WebRTC (DTLS/SRTP).
   ───────────────────────────────────────────────────────────── */
import type { MediaConnection } from "peerjs";

/* NAT traversal + глобальні з'єднання.
   За замовчуванням — повний ICE-каскад (host → srflx/STUN → relay/TURN):
   браузер сам обирає найкращий робочий шлях, тому з'єднання встановлюється
   і локально, і глобально. Google STUN покриває більшість домашніх мереж
   (cone-NAT) без TURN; публічні TURN — резерв для симетричних NAT.
   VITE_RELAY_ONLY=true + VITE_TURN_URL — примусово ТІЛЬКИ relay через ваш
   coturn (приватність + гарантований глобальний трафік). Реквізити свого
   TURN: VITE_TURN_URL / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL. */
const env = import.meta.env;
const customTurn: RTCIceServer[] = env.VITE_TURN_URL
  ? [
      {
        urls: String(env.VITE_TURN_URL).split(",").map((s) => s.trim()),
        username: env.VITE_TURN_USERNAME ? String(env.VITE_TURN_USERNAME) : undefined,
        credential: env.VITE_TURN_CREDENTIAL ? String(env.VITE_TURN_CREDENTIAL) : undefined,
      },
    ]
  : [];

const relayOnly = env.VITE_RELAY_ONLY === "true" || env.VITE_RELAY_ONLY === "1";

export const iceConfig: RTCConfiguration = {
  iceServers: [
    ...customTurn,
    // STUN — визначає публічні адреси (srflx-кандидати). Більшість
    // глобальних з'єднань між домашніми мережами (cone-NAT) проходять
    // саме через STUN — без жодного TURN. Google STUN — найнадійніший.
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:stun2.l.google.com:19302",
      ],
    },
    // Публічні TURN — best-effort для симетричних NAT (мобільні
    // оператори, подвійний NAT). Реквізити часто ротуються, тому це
    // резерв, а не основа. Власний coturn (compose) — VITE_TURN_URL.
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:80?transport=tcp",
        "turn:openrelay.metered.ca:443",
        "turns:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:demo.nextcloud.com:443?transport=tcp",
      username: "nextcloud",
      credential: "nextcloud",
    },
  ],
  // Повний ICE-каскад: host → srflx (STUN) → relay (TURN). Браузер
  // пробує всі шляхи і обирає найкращий робочий — з'єднання встановлюється
  // і в локальній, і в глобальній мережі, незалежно від типу NAT.
  //
  // VITE_RELAY_ONLY=true — примусово ТІЛЬКИ relay (усі медіа через ваш
  // coturn): максимальна приватність + гарантований глобальний трафік,
  // але потрібен робочий TURN (VITE_TURN_URL), інакше з'єднань не буде.
  ...(relayOnly ? { iceTransportPolicy: "relay" as RTCIceTransportPolicy } : {}),
  iceCandidatePoolSize: 2,
};

/* Яким шляхом з'єдналась пара: relay (TURN) / stun / lan (direct) */
export async function icePathInfo(pc: RTCPeerConnection): Promise<string> {
  try {
    const stats = await pc.getStats();
    const types: string[] = [];
    stats.forEach((r) => {
      const rep = r as unknown as {
        type: string;
        state?: string;
        nominated?: boolean;
        localCandidateId?: string;
        remoteCandidateId?: string;
      };
      if (rep.type === "candidate-pair" && (rep.state === "succeeded" || rep.nominated)) {
        const l = stats.get(rep.localCandidateId ?? "") as unknown as { candidateType?: string } | undefined;
        const rm = stats.get(rep.remoteCandidateId ?? "") as unknown as { candidateType?: string } | undefined;
        if (l?.candidateType) types.push(l.candidateType);
        if (rm?.candidateType) types.push(rm.candidateType);
      }
    });
    if (types.includes("relay")) return "relay";
    if (types.includes("srflx") || types.includes("prflx")) return "stun";
    return types.length ? "lan" : "p2p";
  } catch {
    return "p2p";
  }
}

/* Повторне встановлення медіа після зміни мережі (Wi-Fi ↔ мобільні дані):
   ICE restart на живих RTCPeerConnection — сигнали йдуть тим самим
   (автовідновлюваним PeerJS) WebSocket-каналом.                        */
export function restartIceOn(call: MediaConnection | null | undefined) {
  try {
    const pc = call?.peerConnection;
    if (pc && pc.signalingState !== "closed") pc.restartIce();
  } catch {
    /* noop */
  }
}

export function attachNetRecovery(getCalls: () => Array<MediaConnection | null | undefined>) {
  const bump = () => getCalls().forEach(restartIceOn);
  window.addEventListener("online", bump);
  const nav = navigator as Navigator & { connection?: { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void } };
  const connChange = () => window.setTimeout(bump, 400);
  nav.connection?.addEventListener?.("change", connChange);
  return () => {
    window.removeEventListener("online", bump);
    nav.connection?.removeEventListener?.("change", connChange);
  };
}
