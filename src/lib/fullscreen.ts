/**
 * Надійне крос-браузерне керування повноекранним режимом (Desktop + Mobile)
 */

export function isNativeFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as any;
  return !!(
    doc.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement
  );
}

export async function enterFullscreen(element?: HTMLElement | null): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") return false;

  const target = element || document.documentElement;
  const el = target as any;

  try {
    // 1. Спроба з приховуванням системної навігації (Android Chrome / WebRTC)
    if (el.requestFullscreen) {
      try {
        await el.requestFullscreen({ navigationUI: "hide" });
        return true;
      } catch {
        // Деякі браузери (Safari/Desktop) не підтримують об'єкт options у requestFullscreen
        await el.requestFullscreen();
        return true;
      }
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
      return true;
    } else if (el.mozRequestFullScreen) {
      el.mozRequestFullScreen();
      return true;
    } else if (el.msRequestFullscreen) {
      el.msRequestFullscreen();
      return true;
    }
  } catch (err) {
    console.warn("Fullscreen request failed or restricted:", err);
  }

  // Якщо браузер обмежує Fullscreen API (наприклад, iPhone Safari або iframe без allowfullscreen),
  // повертаємо false, щоб компонент увімкнув повноекранний CSS-режим (100dvh fallback)
  return false;
}

export async function exitFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  const doc = document as any;

  try {
    if (isNativeFullscreen()) {
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
  } catch (err) {
    console.warn("Exit fullscreen failed:", err);
  }
}
