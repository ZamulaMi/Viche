/**
 * Утиліти для надійного повноекранного режиму (Fullscreen API)
 * з примусовим приховуванням панелей та інтерфейсу браузера на мобільних пристроях.
 */

export type FullscreenOptionsExtended = FullscreenOptions & {
  navigationUI?: "hide" | "show" | "auto";
};

interface WebKitElement extends HTMLElement {
  webkitRequestFullscreen?: (options?: FullscreenOptionsExtended) => Promise<void> | void;
  mozRequestFullScreen?: (options?: FullscreenOptionsExtended) => Promise<void> | void;
  msRequestFullscreen?: (options?: FullscreenOptionsExtended) => Promise<void> | void;
}

interface WebKitDocument extends Document {
  webkitFullscreenElement?: Element;
  mozFullScreenElement?: Element;
  msFullscreenElement?: Element;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
}

export function isFullscreenActive(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as WebKitDocument;
  return !!(
    doc.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement ||
    document.body.classList.contains("is-fullscreen")
  );
}

export async function requestMobileFullscreen(targetElement?: HTMLElement | null): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") return false;

  const el = (targetElement || document.documentElement) as WebKitElement;
  const doc = document as WebKitDocument;

  // Фіксація body проти небажаного скролу/жестів згортання в браузері
  document.body.classList.add("is-fullscreen");
  window.scrollTo({ top: 0, left: 0 });

  const fsOptions: FullscreenOptionsExtended = {
    navigationUI: "hide",
  };

  try {
    if (el.requestFullscreen) {
      await el.requestFullscreen(fsOptions);
      return true;
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen(fsOptions);
      return true;
    } else if (el.mozRequestFullScreen) {
      el.mozRequestFullScreen(fsOptions);
      return true;
    } else if (el.msRequestFullscreen) {
      el.msRequestFullscreen(fsOptions);
      return true;
    }
  } catch {
    // Якщо браузер обмежує Fullscreen API (наприклад, у деяких версіях iOS Safari),
    // CSS-режим (is-fullscreen + fixed inset-0 100dvh) забезпечує повноекранний вигляд
  }

  return true;
}

export async function exitMobileFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  const doc = document as WebKitDocument;

  document.body.classList.remove("is-fullscreen");

  try {
    const fsEl =
      doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.mozFullScreenElement ||
      doc.msFullscreenElement;

    if (fsEl) {
      if (doc.exitFullscreen) {
        await doc.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      } else if (doc.mozCancelFullScreen) {
        doc.mozCancelFullScreen();
      } else if (doc.msExitFullscreen) {
        doc.msExitFullscreen();
      }
    }
  } catch {
    /* noop */
  }
}
