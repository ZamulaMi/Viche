import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./rtc";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fn = () => setReduced(mq.matches);
    mq.addEventListener?.("change", fn);
    return () => mq.removeEventListener?.("change", fn);
  }, []);
  return reduced;
}

/* Scramble-decode: текст "розшифровується" з шумових символів */
const GLYPHS = "▚▞▟#/\\×+·01ВІЧЕVICHE";
export function useScramble(text: string, delay = 0) {
  const reduced = useReducedMotion();
  const [out, setOut] = useState(reduced ? text : "");
  useEffect(() => {
    if (reduced) {
      setOut(text);
      return;
    }
    let raf = 0;
    let frame = 0;
    const total = Math.max(14, text.length * 2.4);
    const tick = () => {
      frame++;
      const prog = Math.min(1, frame / total);
      const reveal = Math.floor(prog * text.length);
      let s = "";
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        s += i < reveal || ch === " " ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setOut(prog >= 1 ? text : s);
      if (prog < 1) raf = requestAnimationFrame(tick);
    };
    const to = window.setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => {
      window.clearTimeout(to);
      cancelAnimationFrame(raf);
    };
  }, [text, reduced, delay]);
  return out;
}

/* Scroll reveal через IntersectionObserver */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      setInView(true);
      return;
    }
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          ob.disconnect();
        }
      },
      { threshold: 0.12 }
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  return { ref, inView };
}
