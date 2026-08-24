import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { IconShield, IconRefresh } from "./icons";

const KEY = "viche:captcha";

export const captchaToken = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};

type Problem = { a: number; b: number; op: "×" | "+"; answer: number };
const gen = (): Problem => {
  const mul = Math.random() > 0.45;
  const a = 2 + Math.floor(Math.random() * 8);
  const b = mul ? 2 + Math.floor(Math.random() * 9) : 3 + Math.floor(Math.random() * 27);
  return { a, b, op: mul ? "×" : "+", answer: mul ? a * b : a + b };
};

export default function CaptchaModal({ onPass }: { onPass: () => void }) {
  const { t } = useI18n();
  const [p, setP] = useState<Problem>(gen);
  const [val, setVal] = useState("");
  const [err, setErr] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [p]);

  const submit = () => {
    if (parseInt(val, 10) === p.answer) {
      try {
        sessionStorage.setItem(KEY, btoa(`viche:${Date.now()}:${p.answer}`));
      } catch {
        /* noop */
      }
      onPass();
    } else {
      setErr(true);
      setVal("");
      setP(gen());
      window.setTimeout(() => setErr(false), 550);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-[color-mix(in_srgb,var(--c-bg)_72%,transparent)] backdrop-blur-[3px]">
      <div className={`card w-full max-w-md p-7 shadow-[var(--c-shadow)] fadeup ${err ? "shake" : ""}`}>
        <div className="flex items-center gap-3 mb-5">
          <span className="grid place-items-center w-11 h-11 rounded-xl bg-[color-mix(in_srgb,var(--c-mint)_14%,transparent)] text-[var(--c-mint)]">
            <IconShield className="w-6 h-6" />
          </span>
          <div>
            <h2 className="font-display font-700 text-lg leading-tight">{t("cap.title")}</h2>
            <p className="text-[13px] text-[var(--c-dim)]">{t("cap.sub")}</p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 py-6 rounded-xl border border-[var(--c-line)] bg-[var(--c-bg2)]">
          <span className="font-mono text-3xl font-700 tracking-wider">
            {p.a} <span className="text-[var(--c-amber)]">{p.op}</span> {p.b}{" "}
            <span className="text-[var(--c-faint)]">=</span>
          </span>
          <input
            ref={ref}
            inputMode="numeric"
            value={val}
            onChange={(e) => setVal(e.target.value.replace(/[^\d-]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="?"
            aria-label={t("cap.ph")}
            className="input !w-24 text-center font-mono text-2xl !py-2"
          />
        </div>

        {err && <p className="mt-3 text-[13px] font-600 text-[var(--c-red)] fadeup">{t("cap.err")}</p>}

        <div className="mt-5 flex items-center gap-3">
          <button className="btn btn-amber flex-1" onClick={submit}>
            {t("cap.btn")}
          </button>
          <button
            className="btn btn-icon"
            title="↻"
            aria-label="new problem"
            onClick={() => {
              setP(gen());
              setVal("");
            }}
          >
            <IconRefresh className="w-5 h-5" />
          </button>
        </div>
        <p className="mt-4 font-mono text-[11px] text-[var(--c-faint)] leading-relaxed">{t("cap.note")}</p>
      </div>
    </div>
  );
}
