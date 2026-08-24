import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I18nProvider, useI18n, type Lang } from "./i18n";
import { SimNet } from "./lib/sim";
import { getLocalStream, prefersReducedMotion, type LocalMedia } from "./lib/rtc";
import { useScramble } from "./lib/hooks";
import Roulette from "./components/Roulette";
import Rooms from "./components/Rooms";
import Architecture from "./components/Architecture";
import {
  IconBlueprint,
  IconMoon,
  IconRooms,
  IconShuffle,
  IconSun,
  LogoMark,
} from "./components/icons";

type View = "roulette" | "rooms" | "arch";
type Toast = { id: number; msg: string; kind: "ok" | "warn" };

let tid = 0;

function Ambient() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const resize = () => {
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const dots = Array.from({ length: 44 }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.24,
      vy: (Math.random() - 0.5) * 0.24,
      r: Math.random() * 1.7 + 0.6,
      a: Math.random() * 0.4 + 0.12,
      amber: Math.random() > 0.82,
    }));
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      ctx.clearRect(0, 0, w, h);
      for (const d of dots) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < -4) d.x = w + 4;
        if (d.x > w + 4) d.x = -4;
        if (d.y < -4) d.y = h + 4;
        if (d.y > h + 4) d.y = -4;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = d.amber ? `rgba(240,168,60,${d.a})` : `rgba(67,214,154,${d.a})`;
        ctx.fill();
      }
    };
    if (!prefersReducedMotion()) raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return <canvas ref={ref} className="fixed inset-0 w-full h-full pointer-events-none" aria-hidden />;
}

function Shell() {
  const { t, lang, setLang } = useI18n();
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("viche:theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const initialJoin = useMemo(() => new URLSearchParams(location.search).get("room"), []);
  const [view, setView] = useState<View>(initialJoin ? "rooms" : "roulette");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [, setTick] = useState(0);

  const net = useMemo(() => new SimNet(), []);
  const localPromise = useRef<Promise<LocalMedia> | null>(null);
  const [localMedia, setLocalMedia] = useState<LocalMedia | null>(null);

  useEffect(() => net.start(), [net]);
  useEffect(() => net.subscribe(() => setTick((v) => v + 1)), [net]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("viche:theme", theme);
    } catch {
      /* noop */
    }
  }, [theme]);

  const push = useCallback((msg: string, kind: "ok" | "warn" = "ok") => {
    const id = ++tid;
    setToasts((ts) => [...ts.slice(-3), { id, msg, kind }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 2800);
  }, []);

  const ensureLocal = useCallback(async () => {
    if (!localPromise.current) localPromise.current = getLocalStream();
    const m = await localPromise.current;
    setLocalMedia(m);
    return m;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "1") setView("roulette");
      if (e.key === "2") setView("rooms");
      if (e.key === "3") setView("arch");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const snap = net.snapshot();
  const brand = useScramble("VICHE", 120);

  const NAV: Array<{ v: View; k: string; icon: React.ReactNode; key: string }> = [
    { v: "roulette", k: "1", icon: <IconShuffle className="w-5 h-5" />, key: "nav.roulette" },
    { v: "rooms", k: "2", icon: <IconRooms className="w-5 h-5" />, key: "nav.rooms" },
    { v: "arch", k: "3", icon: <IconBlueprint className="w-5 h-5" />, key: "nav.arch" },
  ];

  const tickerItems = [
    [`● ${snap.online.toLocaleString("uk-UA")}`, t("tick.online"), "mint"],
    [snap.pairs24.toLocaleString("uk-UA"), t("tick.pairs"), "amber"],
    [snap.avgWait.toFixed(1) + "s", t("tick.wait"), "mint"],
    [t("tick.sig"), "", "dim"],
    [t("tick.turn"), "", "dim"],
  ] as const;

  return (
    <div className="min-h-screen relative">
      <Ambient />
      <div className="fixed inset-0 gridlines pointer-events-none" aria-hidden />
      <div className="fixed inset-0 noise pointer-events-none z-[60]" aria-hidden />
      <div className="fixed inset-0 vignette pointer-events-none" aria-hidden />

      <div className="relative z-10 flex flex-col min-h-screen">
        {/* ── Шапка ── */}
        <header className="sticky top-0 z-40 border-b border-[var(--c-line)] bg-[color-mix(in_srgb,var(--c-bg)_85%,transparent)] backdrop-blur-md">
          <div className="max-w-[1400px] mx-auto w-full px-4 sm:px-6 h-[60px] flex items-center gap-4">
            <button className="flex items-center gap-3 group" onClick={() => setView("roulette")}>
              <LogoMark className="w-9 h-9 transition-transform group-hover:rotate-6" />
              <span className="text-left leading-none">
                <span className="font-display font-900 text-[19px] tracking-[0.08em] block">{brand}</span>
                <span className="font-mono text-[10px] text-[var(--c-faint)] tracking-wide">{t("brand.tag")}</span>
              </span>
            </button>

            <div className="ml-auto flex items-center gap-2">
              <div className="flex rounded-lg border border-[var(--c-line2)] overflow-hidden">
                {(["uk", "en"] as Lang[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLang(l)}
                    className={`px-2.5 py-1.5 font-mono text-[11px] font-700 tracking-wider transition-colors ${
                      lang === l ? "bg-[var(--c-amber)] text-[#14100a]" : "text-[var(--c-dim)] hover:text-[var(--c-text)]"
                    }`}
                  >
                    {l.toUpperCase()}
                  </button>
                ))}
              </div>
              <button
                className="btn btn-icon"
                onClick={() => setTheme((v) => (v === "dark" ? "light" : "dark"))}
                title="theme"
                aria-label="toggle theme"
              >
                {theme === "dark" ? <IconSun className="w-5 h-5" /> : <IconMoon className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* тікер */}
          <div className="marquee border-t border-[var(--c-line)] overflow-hidden py-1.5">
            <div className="marquee-track flex w-max items-center">
              {[0, 1].map((dup) => (
                <div key={dup} className="flex items-center" aria-hidden={dup === 1}>
                  {tickerItems.map(([v, l, c], i) => (
                    <span key={i} className="flex items-center gap-2 px-6 font-mono text-[11px] whitespace-nowrap">
                      <span className={`led ${c === "mint" ? "led-mint" : c === "amber" ? "led-amber" : ""}`} style={c === "dim" ? { width: 5, height: 5 } : undefined} />
                      <span className={c === "mint" ? "text-[var(--c-mint)]" : c === "amber" ? "text-[var(--c-amber)]" : "text-[var(--c-text)]"}>{v}</span>
                      {l && <span className="text-[var(--c-faint)]">{l}</span>}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </header>

        <div className="flex-1 flex max-w-[1400px] mx-auto w-full px-4 sm:px-6">
          {/* ── Рейка навігації (desktop) ── */}
          <aside className="hidden lg:flex flex-col w-48 flex-none py-7 pr-5 gap-1.5">
            {NAV.map((n) => (
              <button
                key={n.v}
                onClick={() => setView(n.v)}
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg border text-left transition-all ${
                  view === n.v
                    ? "border-[var(--c-amber)] bg-[color-mix(in_srgb,var(--c-amber)_9%,transparent)] text-[var(--c-text)] shadow-[var(--c-glow-amber)]"
                    : "border-transparent text-[var(--c-dim)] hover:text-[var(--c-text)] hover:border-[var(--c-line)]"
                }`}
              >
                <span className={view === n.v ? "text-[var(--c-amber)]" : ""}>{n.icon}</span>
                <span className="font-700 text-[14px] flex-1">{t(n.key as never)}</span>
                <span className="kbd">{n.k}</span>
              </button>
            ))}
            <div className="mt-auto pt-6">
              <div className="rounded-lg border border-[var(--c-line)] bg-[var(--c-panel)] px-3.5 py-3">
                <p className="flex items-center gap-2 font-mono text-[10.5px] text-[var(--c-mint)]">
                  <span className="led led-mint" /> ws connected
                </p>
                <p className="font-mono text-[10px] text-[var(--c-faint)] mt-1.5 leading-relaxed">
                  wss://signal.viche.app<br />node eu-1 · rt {(18 + (snap.online % 23))} ms
                </p>
              </div>
            </div>
          </aside>

          {/* ── Контент ── */}
          <main className="flex-1 min-w-0 py-6 pb-28 lg:pb-10">
            <div className={view === "roulette" ? "block" : "hidden"}>
              <Roulette localMedia={localMedia} ensureLocal={ensureLocal} onToast={push} net={net} />
            </div>
            <div className={view === "rooms" ? "block" : "hidden"}>
              <Rooms localMedia={localMedia} ensureLocal={ensureLocal} onToast={push} initialJoin={initialJoin} />
            </div>
            <div className={view === "arch" ? "block" : "hidden"}>
              <Architecture onToast={push} />
            </div>
          </main>
        </div>

        {/* ── Футер ── */}
        <footer className="border-t border-[var(--c-line)] mt-auto">
          <div className="max-w-[1400px] mx-auto w-full px-4 sm:px-6 py-4 flex flex-col sm:flex-row gap-2 sm:items-center">
            <p className="font-mono text-[10.5px] text-[var(--c-faint)] leading-relaxed max-w-2xl">{t("footer.demo")}</p>
            <p className="sm:ml-auto font-mono text-[10.5px] text-[var(--c-faint)] whitespace-nowrap">
              go 1.22 · react 18 · webrtc · <span className="text-[var(--c-mint)]">viche v0.9</span>
            </p>
          </div>
        </footer>

        {/* ── Мобільна навігація ── */}
        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 grid grid-cols-3 border-t border-[var(--c-line)] bg-[color-mix(in_srgb,var(--c-bg)_90%,transparent)] backdrop-blur-md pb-[env(safe-area-inset-bottom)]">
          {NAV.map((n) => (
            <button
              key={n.v}
              onClick={() => setView(n.v)}
              className={`flex flex-col items-center gap-1 py-2.5 transition-colors ${
                view === n.v ? "text-[var(--c-amber)]" : "text-[var(--c-dim)]"
              }`}
            >
              {n.icon}
              <span className="text-[10px] font-700">{t(n.key as never)}</span>
              <span className={`h-[3px] w-8 rounded-full transition-all ${view === n.v ? "bg-[var(--c-amber)]" : "bg-transparent"}`} />
            </button>
          ))}
        </nav>

        {/* ── Тости ── */}
        <div className="fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 z-[70] flex flex-col items-center gap-2 pointer-events-none">
          {toasts.map((x) => (
            <div
              key={x.id}
              className="fadeup flex items-center gap-2.5 card !bg-[color-mix(in_srgb,var(--c-panel)_92%,transparent)] backdrop-blur-md px-4 py-2.5 shadow-[var(--c-shadow)]"
            >
              <span className={`led ${x.kind === "ok" ? "led-mint" : "led-amber"}`} />
              <span className="text-[13px] font-600">{x.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}
