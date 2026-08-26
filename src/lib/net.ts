/* ─────────────────────────────────────────────────────────────
   Viche · спільні мережеві утиліти (NAT traversal, ICE, відновлення)

   Використовуються і рулеткою (roulettenet.ts), і кімнатами (roomnet.ts).
   Сигналінг — публічний PeerJS-брокер; медіа — P2P WebRTC (DTLS/SRTP).
   ───────────────────────────────────────────────────────────── */
import type { MediaConnection, PeerOptions } from "peerjs";

/* NAT traversal + глобальні з'єднання (Wi-Fi, 4G/5G, домашні та корпоративні мережі).
   Google STUN + Cloudflare STUN забезпечують швидке та безвідмовне визначення
   публічних адрес (srflx). При наявності власного coturn/TURN (VITE_TURN_URL або
   налаштувань у сховищі) вони додаються на початок списку. */
const env = import.meta.env;

// Читання користувацького TURN з localStorage (якщо налаштовано) або з .env
let savedTurnConfig: RTCIceServer[] = [];
try {
  const localTurnUrl = localStorage.getItem("viche_custom_turn_url");
  const localTurnUser = localStorage.getItem("viche_custom_turn_user");
  const localTurnPass = localStorage.getItem("viche_custom_turn_pass");
  if (localTurnUrl) {
    savedTurnConfig = [
      {
        urls: localTurnUrl.split(",").map((s) => s.trim()),
        username: localTurnUser || undefined,
        credential: localTurnPass || undefined,
      },
    ];
  }
} catch {
  /* noop */
}

const customTurn: RTCIceServer[] = env.VITE_TURN_URL
  ? [
      {
        urls: String(env.VITE_TURN_URL).split(",").map((s) => s.trim()),
        username: env.VITE_TURN_USERNAME ? String(env.VITE_TURN_USERNAME) : undefined,
        credential: env.VITE_TURN_CREDENTIAL ? String(env.VITE_TURN_CREDENTIAL) : undefined,
      },
    ]
  : savedTurnConfig;

const relayOnly = env.VITE_RELAY_ONLY === "true" || env.VITE_RELAY_ONLY === "1";

export const iceConfig: RTCConfiguration = {
  iceServers: [
    ...customTurn,
    // Найнадійніші відкриті глобальні STUN-сервери з миттєвим часом відповіді
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:stun2.l.google.com:19302",
        "stun:stun3.l.google.com:19302",
        "stun:stun4.l.google.com:19302",
        "stun:stun.cloudflare.com:3478",
      ],
    },
  ],
  ...(relayOnly ? { iceTransportPolicy: "relay" as RTCIceTransportPolicy } : {}),
  iceCandidatePoolSize: 2,
};

/* Спільні налаштування PeerJS */
export const defaultPeerOptions: PeerOptions = {
  debug: 0,
  config: iceConfig,
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
