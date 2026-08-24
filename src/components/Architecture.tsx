import { useI18n } from "../i18n";
import { useReveal } from "../lib/hooks";
import { IconCopy } from "./icons";

const TREE = `viche/
├─ server/                  # Go: сигналінг + матчер (stateless)
│  ├─ main.go               # init: PG, Redis, WS-роутер, shutdown
│  ├─ handler.go            # WS handshake, RTC-сигнали, rate limit
│  ├─ matcher.go            # черга пар: стать/мова/теги, Pub/Sub
│  ├─ room.go               # кімнати + add_random + kick&replace
│  ├─ moderation.go         # скарги → бан IP (ZSET+SETEX), мат-фільтр
│  ├─ go.mod
│  └─ Dockerfile            # multi-stage, distroless, non-root
├─ src/                     # React 18 + Vite + Tailwind 4
│  ├─ App.tsx               # shell: теми, i18n, навігація
│  ├─ i18n.tsx              # UK / EN
│  ├─ lib/
│  │  ├─ rtc.ts             # getUserMedia, loopback RTCPeerConnection
│  │  └─ sim.ts             # демо-матчер (у продакшн → WebSocket)
│  └─ components/
│     ├─ Roulette.tsx  ├─ VideoChat.tsx
│     ├─ Rooms.tsx     ├─ Captcha.tsx  └─ Architecture.tsx
├─ docker-compose.yml       # app + postgres + redis + coturn
└─ README.md`;

const PROTO: Array<[string, string, string]> = [
  ["hello", "C→S", "captcha_token, ua, prefs{gender, lang, tags[]}"],
  ["match.join", "C→S", "filters{gender, lang, tags[]} → шред-черга Redis"],
  ["match.next", "C→S", "розірвати пару, повернутись у чергу"],
  ["match.found", "S→C", "peer_id, room_sig — обом учасникам пари"],
  ["rtc.offer / rtc.answer / rtc.ice", "C↔S", "транзит SDP/ICE між пірами (без збереження)"],
  ["chat.msg", "C↔S", "текст → серверний мат-фільтр → peer"],
  ["report.user", "C→S", "ZINCRBY reports:{ip} (TTL 24h); ≥3 → SETEX ban"],
  ["room.create / room.join", "C→S", "id VCH-XXXXXX, seats, peers[] у Redis hash"],
  ["room.add_random", "A→S", "pop з черги рулетки → pair у кімнату"],
  ["room.kick_replace", "A→S", "close peer + повторний pop з черги"],
];

const INFRA: Array<[string, string, string, string]> = [
  ["01", "viche-server", "build: ./server", ":8080 — WS сигналінг, N реплік за LB"],
  ["02", "postgres:16-alpine", "pgdata volume", ":5432 — користувачі, скарги, кімнати"],
  ["03", "redis:7-alpine", "appendonly", ":6379 — черги, Pub/Sub, rate limit, бани (TTL)"],
  ["04", "instrumentisto/coturn", "realm=viche", ":3478 UDP/TCP, :5349 TLS — TURN/STUN"],
  ["05", "viche-web", "nginx:alpine", ":3000 — статичний фронт (dist/), SPA fallback"],
];

const STEPS_UK = [
  ["docker compose up -d --build", "підніме Go-сервер, Postgres, Redis та coturn"],
  ["http://localhost:3000", "фронт; сигналінг — ws://localhost:8080/ws"],
  ["перевір TURN", "turnutils_uclient -t -u viche -w secret localhost"],
  ["VITE_SIGNALING_URL", "змінна оточення фронту для іншого хоста"],
  ["продакшн", "TLS-термінація + coturn за публічним IP, горизонтальні репліки server"],
];
const STEPS_EN = [
  ["docker compose up -d --build", "starts Go server, Postgres, Redis and coturn"],
  ["http://localhost:3000", "frontend; signaling at ws://localhost:8080/ws"],
  ["verify TURN", "turnutils_uclient -t -u viche -w secret localhost"],
  ["VITE_SIGNALING_URL", "frontend env var to point at another host"],
  ["production", "TLS termination + coturn on a public IP, horizontal server replicas"],
];

function Section({ title, sub, children, wide }: { title: string; sub?: string; children: React.ReactNode; wide?: boolean }) {
  const { ref, inView } = useReveal<HTMLDivElement>();
  return (
    <section ref={ref} className={`reveal ${inView ? "in" : ""} ${wide ? "lg:col-span-2" : ""}`}>
      <h2 className="font-display font-700 text-xl tracking-tight">{title}</h2>
      {sub && <p className="mt-1.5 mb-4 text-[13.5px] text-[var(--c-dim)] leading-relaxed max-w-2xl">{sub}</p>}
      {!sub && <div className="mb-4" />}
      {children}
    </section>
  );
}

export default function Architecture({ onToast }: { onToast: (m: string, k?: "ok" | "warn") => void }) {
  const { t, lang } = useI18n();
  const steps = lang === "uk" ? STEPS_UK : STEPS_EN;

  const copyTree = async () => {
    try {
      await navigator.clipboard.writeText(TREE);
      onToast(t("toast.copied"), "ok");
    } catch {
      /* noop */
    }
  };

  return (
    <div>
      <div className="max-w-3xl mb-8">
        <p className="panel-title mb-2">viche · system design</p>
        <h1 className="font-display font-900 text-2xl sm:text-4xl tracking-tight">{t("arch.title")}</h1>
        <p className="mt-3 text-[15px] text-[var(--c-dim)] leading-relaxed">{t("arch.sub")}</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-x-8 gap-y-10">
        {/* ── Топологія ── */}
        <Section title={t("arch.dTitle")} sub={t("arch.dNote")} wide>
          <div className="card p-4 sm:p-6 overflow-x-auto">
            <svg viewBox="0 0 860 300" className="w-full min-w-[700px] h-auto" role="img" aria-label="topology">
              <defs>
                <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 10 5 0 10z" fill="var(--c-faint)" />
                </marker>
                <marker id="arm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 10 5 0 10z" fill="var(--c-mint)" />
                </marker>
              </defs>
              {/* клієнти */}
              {[40, 40].map((y, i) => (
                <g key={i} transform={`translate(20 ${30 + i * 130})`}>
                  <rect width="150" height="70" rx="10" fill="var(--c-raise)" stroke="var(--c-line2)" />
                  <text x="14" y="27" fontFamily="JetBrains Mono" fontSize="12" fill="var(--c-text)">client_{i === 0 ? "A" : "B"}</text>
                  <text x="14" y="47" fontFamily="JetBrains Mono" fontSize="10" fill="var(--c-faint)">React · WebRTC</text>
                </g>
              ))}
              {/* P2P медіа */}
              <path d="M95 105 C 95 140, 95 150, 95 160" stroke="var(--c-mint)" strokeWidth="2" strokeDasharray="5 4" fill="none" markerEnd="url(#arm)" markerStart="url(#arm)" />
              <text x="108" y="140" fontFamily="JetBrains Mono" fontSize="10.5" fill="var(--c-mint)">P2P media · DTLS/SRTP</text>
              {/* LB */}
              <g transform="translate(250 100)">
                <rect width="110" height="70" rx="10" fill="var(--c-panel)" stroke="var(--c-line2)" />
                <text x="14" y="28" fontFamily="JetBrains Mono" fontSize="12" fill="var(--c-text)">nginx / LB</text>
                <text x="14" y="47" fontFamily="JetBrains Mono" fontSize="10" fill="var(--c-faint)">wss :443</text>
              </g>
              <path d="M170 65 H 250 M170 195 H 220 q30 0 30 -35 V 155" stroke="var(--c-faint)" strokeWidth="1.5" fill="none" markerEnd="url(#ar)" />
              {/* go-вузли */}
              {[0, 1, 2].map((i) => (
                <g key={i} transform={`translate(420 ${26 + i * 86})`}>
                  <rect width="150" height="64" rx="10" fill={i === 0 ? "color-mix(in srgb, var(--c-amber) 14%, var(--c-raise))" : "var(--c-raise)"} stroke={i === 0 ? "var(--c-amber)" : "var(--c-line2)"} />
                  <text x="13" y="26" fontFamily="JetBrains Mono" fontSize="12" fill="var(--c-text)">go-signal #{i + 1}</text>
                  <text x="13" y="45" fontFamily="JetBrains Mono" fontSize="10" fill="var(--c-faint)">stateless · matcher</text>
                </g>
              ))}
              <path d="M360 135 H 420 M360 135 q30 0 45 -50 M360 135 q30 0 45 50" stroke="var(--c-faint)" strokeWidth="1.5" fill="none" markerEnd="url(#ar)" />
              {/* redis */}
              <g transform="translate(640 96)">
                <rect width="190" height="78" rx="10" fill="color-mix(in srgb, var(--c-mint) 10%, var(--c-raise))" stroke="var(--c-mint)" />
                <text x="14" y="28" fontFamily="JetBrains Mono" fontSize="12" fill="var(--c-text)">redis 7</text>
                <text x="14" y="47" fontFamily="JetBrains Mono" fontSize="10" fill="var(--c-faint)">pub/sub · queues · bans</text>
                <text x="14" y="63" fontFamily="JetBrains Mono" fontSize="10" fill="var(--c-faint)">rate limit · room state</text>
              </g>
              <path d="M570 58 H 640 M570 135 H 640 M570 212 H 610 q30 0 30 -37" stroke="var(--c-mint)" strokeWidth="1.5" strokeDasharray="4 3" fill="none" markerEnd="url(#arm)" markerStart="url(#arm)" />
              {/* pg */}
              <g transform="translate(660 226)">
                <rect width="170" height="58" rx="10" fill="var(--c-raise)" stroke="var(--c-line2)" />
                <text x="14" y="25" fontFamily="JetBrains Mono" fontSize="12" fill="var(--c-text)">postgres 16</text>
                <text x="14" y="44" fontFamily="JetBrains Mono" fontSize="10" fill="var(--c-faint)">users · reports · rooms</text>
              </g>
              <path d="M735 174 V 226" stroke="var(--c-faint)" strokeWidth="1.5" fill="none" markerEnd="url(#ar)" markerStart="url(#ar)" />
              {/* coturn */}
              <g transform="translate(250 226)">
                <rect width="140" height="58" rx="10" fill="var(--c-raise)" stroke="var(--c-line2)" />
                <text x="14" y="25" fontFamily="JetBrains Mono" fontSize="12" fill="var(--c-text)">coturn</text>
                <text x="14" y="44" fontFamily="JetBrains Mono" fontSize="10" fill="var(--c-faint)">:3478 relay fallback</text>
              </g>
              <path d="M170 95 q40 10 60 60 q10 40 20 70" stroke="var(--c-faint)" strokeWidth="1.2" strokeDasharray="3 4" fill="none" />
              <path d="M390 255 H 560 q40 0 55 -20" stroke="var(--c-faint)" strokeWidth="1.2" strokeDasharray="3 4" fill="none" opacity=".6" />
            </svg>
          </div>
        </Section>

        {/* ── Дерево ── */}
        <Section title={t("arch.treeTitle")}>
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--c-line)]">
              <span className="font-mono text-[11px] text-[var(--c-faint)]">~/viche $ tree -L 2</span>
              <button className="btn !py-1.5 !px-2.5" onClick={copyTree}>
                <IconCopy className="w-3.5 h-3.5" />
              </button>
            </div>
            <pre className="px-4 py-4 font-mono text-[11.5px] leading-[1.65] text-[var(--c-dim)] overflow-x-auto whitespace-pre">{TREE}</pre>
          </div>
        </Section>

        {/* ── Протокол ── */}
        <Section title={t("arch.protoTitle")} sub={t("arch.protoSub")}>
          <div className="card overflow-hidden">
            <table className="w-full text-left">
              <tbody>
                {PROTO.map(([type, dir, desc], i) => (
                  <tr key={type} className={`${i > 0 ? "border-t border-[var(--c-line)]" : ""} hover:bg-[var(--c-raise)] transition-colors`}>
                    <td className="px-4 py-2.5 align-top w-[38%]">
                      <span className="font-mono text-[12px] text-[var(--c-amber)]">{type}</span>
                      <span className="ml-2 font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--c-bg2)] border border-[var(--c-line)] text-[var(--c-faint)]">{dir}</span>
                    </td>
                    <td className="px-3 py-2.5 align-top text-[12px] text-[var(--c-dim)] leading-snug">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── Інфраструктура ── */}
        <Section title={t("arch.infraTitle")}>
          <div className="space-y-2">
            {INFRA.map(([n, name, meta, desc]) => (
              <div key={n} className="card flex items-center gap-4 px-4 py-3 hover:border-[var(--c-line2)] hover:translate-x-1 transition-all">
                <span className="font-display font-900 text-lg text-[var(--c-amber)] w-8">{n}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[13px] text-[var(--c-text)] font-500 truncate">{name}</p>
                  <p className="text-[11.5px] text-[var(--c-faint)] truncate">{desc}</p>
                </div>
                <span className="font-mono text-[10.5px] text-[var(--c-mint)] hidden sm:block flex-none">{meta}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Кроки запуску ── */}
        <Section title={t("arch.stepsTitle")}>
          <ol className="space-y-2.5">
            {steps.map(([cmd, desc], i) => (
              <li key={cmd} className="card flex items-start gap-3.5 px-4 py-3">
                <span className="grid place-items-center w-7 h-7 rounded-lg bg-[color-mix(in_srgb,var(--c-mint)_14%,transparent)] text-[var(--c-mint)] font-mono text-[12px] font-700 flex-none mt-0.5">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <code className="font-mono text-[12.5px] text-[var(--c-text)] break-all">$ {cmd}</code>
                  <p className="text-[12px] text-[var(--c-dim)] mt-0.5">{desc}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        {/* ── Масштабування ── */}
        <Section title={t("arch.scaleTitle")} wide>
          <div className="grid sm:grid-cols-2 gap-3">
            {(["arch.s1", "arch.s2", "arch.s3", "arch.s4"] as const).map((k, i) => (
              <div key={k} className="card p-4 flex gap-3.5">
                <span className="font-display font-900 text-[var(--c-amber)] flex-none">{String(i + 1).padStart(2, "0")}</span>
                <p className="text-[13px] text-[var(--c-dim)] leading-relaxed">{t(k)}</p>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
