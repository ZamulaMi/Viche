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
    // Надійні високошвидкісні глобальні STUN-сервери Google та Cloudflare
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
  iceCandidatePoolSize: 0,
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
   ICE restart на живих RTCPeerConnection */
export function restartIceOn(call: MediaConnection | null | undefined): boolean {
  try {
    const pc = call?.peerConnection;
    if (pc && pc.signalingState !== "closed") {
      if (typeof pc.restartIce === "function") {
        pc.restartIce();
        return true;
      }
    }
  } catch {
    /* noop */
  }
  return false;
}

/* Оптимізація бітрейту та параметрів енкодера: миттєва адаптація без падіння роздільності та без перегріву */
export function optimizeSenderBitrate(pc: RTCPeerConnection | null | undefined) {
  if (!pc) return;
  try {
    const senders = pc.getSenders();
    senders.forEach((sender) => {
      if (sender.track?.kind === "video") {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          // 1.5 Mbps та збалансована деградація забезпечують швидкий чіткий старт без змазування та затримок
          params.encodings[0].maxBitrate = 1_500_000;
          params.encodings[0].maxFramerate = 30;
          params.degradationPreference = "balanced";
          sender.setParameters(params).catch(() => {});
        } catch {
          /* noop */
        }
      }
    });
  } catch {
    /* noop */
  }
}

export function attachNetRecovery(
  getCalls: () => Array<MediaConnection | null | undefined>,
  onNetworkChange?: () => void
) {
  let debounceTimer = 0;
  const trigger = () => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      getCalls().forEach(restartIceOn);
      onNetworkChange?.();
    }, 600);
  };

  window.addEventListener("online", trigger);

  const nav = navigator as Navigator & {
    connection?: {
      addEventListener?: (t: string, f: () => void) => void;
      removeEventListener?: (t: string, f: () => void) => void;
    };
  };
  nav.connection?.addEventListener?.("change", trigger);

  return () => {
    window.clearTimeout(debounceTimer);
    window.removeEventListener("online", trigger);
    nav.connection?.removeEventListener?.("change", trigger);
  };
}
