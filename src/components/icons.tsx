/* Кастомні SVG-іконки Viche — stroke: currentColor */

type P = { className?: string };
const S = ({ className, children, filled = false }: P & { children: React.ReactNode; filled?: boolean }) => (
  <svg
    className={className ?? "w-5 h-5"}
    viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

export const LogoMark = ({ className }: P) => (
  <svg
    className={className ?? "w-8 h-8"}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden
  >
    <rect
      width="32"
      height="32"
      rx="8"
      className="fill-[var(--c-raise)] stroke-[var(--c-line2)] transition-colors duration-300"
      strokeWidth="1.2"
    />
    {/* Realistic Hand Victory Silhouette (Monochrome with negative cuts) */}
    <g className="transition-colors duration-300">
      <path
        d="M13.2 27.5c-3.2 0-5-2-5.4-5.2-.4-2.8.5-4.8 1.4-6.2L8 6.6C7.6 5.3 8.8 4 10.2 4.3c.9.2 1.5 1 1.7 1.9l1.8 7.3c.2.6.9.7 1.2.2l2.6-9.2c.4-1.3 1.9-1.8 3-.9.8.6 1.1 1.7.8 2.7l-2.2 8.7c1 .3 2.5 1.4 2.7 3.5.3 3.5-1.5 6-4.5 8.2-1.2.7-2.3 1-3.6 1z"
        className="fill-[var(--c-text)]"
      />
      {/* Thumb crossing over curled fingers */}
      <path
        d="M8.8 18.2c.3-2 1.8-3.2 3.8-3.2h3.5c1.2 0 2.2.9 2.2 2.1 0 1.2-1 2.1-2.2 2.1h-3.8c-1.3 0-2.3.8-2.7 2"
        className="stroke-[var(--c-raise)]"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Curled ring finger contour */}
      <path
        d="M16 15.5c1.3-.2 2.7.2 3.1 1.5.3 1-.3 2-1.4 2.3"
        className="stroke-[var(--c-raise)]"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* Curled pinky finger contour */}
      <path
        d="M17.2 19.5c.8.3 1.8.8 1.9 1.8.1 1-.7 1.8-1.8 1.9"
        className="stroke-[var(--c-raise)]"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* Palm crease line */}
      <path
        d="M12.2 22.8c1.6.8 3.5.8 4.8.2"
        className="stroke-[var(--c-raise)]"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </g>
  </svg>
);

export const IconVictory = ({ className }: P) => (
  <svg
    className={className ?? "w-4 h-4"}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden
  >
    <path
      d="M10 20.8c-2.4 0-3.8-1.5-4.1-3.9-.3-2.1.4-3.6 1.1-4.7L6 5c-.3-1 .6-2 1.7-1.8.7.2 1.1.8 1.3 1.4l1.4 5.5c.2.5.7.5.9.1l2-6.9c.3-1 1.4-1.4 2.3-.7.6.5.8 1.3.6 2l-1.7 6.5c.8.2 1.9 1.1 2 2.6.2 2.6-1.1 4.5-3.4 6.2-.9.5-1.7.8-2.6.8z"
      fill="currentColor"
    />
    <path
      d="M6.6 13.8c.2-1.5 1.4-2.4 2.9-2.4h2.6c.9 0 1.7.7 1.7 1.6 0 .9-.8 1.6-1.7 1.6H9.5c-1 0-1.7.6-2 1.5"
      stroke="var(--c-raise, #0D1712)"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 11.8c1-.2 2.1.2 2.4 1.2.2.8-.2 1.5-1.1 1.7"
      stroke="var(--c-raise, #0D1712)"
      strokeWidth="1.1"
      strokeLinecap="round"
    />
    <path
      d="M13 14.8c.6.2 1.4.6 1.5 1.4.1.8-.5 1.4-1.4 1.5"
      stroke="var(--c-raise, #0D1712)"
      strokeWidth="1.1"
      strokeLinecap="round"
    />
  </svg>
);
export const IconShuffle = ({ className }: P) => (
  <S className={className}>
    <path d="M16 3h5v5" /><path d="M21 3 9.7 14.3" /><path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="M3 4l5.5 5.5" /><path d="M3 20l5.5-5.5" />
  </S>
);
export const IconRooms = ({ className }: P) => (
  <S className={className}>
    <path d="M3 21h18" /><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16" /><circle cx="14.6" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </S>
);
export const IconBlueprint = ({ className }: P) => (
  <S className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" /><path d="m13 14 3 3 3-3" opacity=".65" />
  </S>
);
export const IconMic = ({ className }: P) => (
  <S className={className}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3.5" />
  </S>
);
export const IconMicOff = ({ className }: P) => (
  <S className={className}>
    <path d="M9 5.5A3 3 0 0 1 15 5.5v5a3 3 0 0 1-.4 1.5M9 9.5v4a3 3 0 0 0 5 2.2" /><path d="M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.4 2.4" /><path d="M12 18v3.5" /><path d="m4 4 16 16" />
  </S>
);
export const IconCam = ({ className }: P) => (
  <S className={className}>
    <rect x="2.5" y="6" width="13" height="12" rx="2.5" /><path d="m21.5 8-6 4 6 4V8Z" />
  </S>
);
export const IconCamOff = ({ className }: P) => (
  <S className={className}>
    <path d="M8.5 6h4.5a2.5 2.5 0 0 1 2.5 2.5V10l6-3.6v11.2l-2-1.2M15.5 15.5v0A2.5 2.5 0 0 1 13 18H5a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 5 6h.5" /><path d="m3 3 18 18" />
  </S>
);
export const IconSwitchCamera = ({ className }: P) => (
  <S className={className}>
    <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
    <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
    <circle cx="12" cy="12" r="3" />
    <path d="m18 22-3-3 3-3" />
    <path d="m6 2 3 3-3 3" />
  </S>
);
export const IconNext = ({ className }: P) => (
  <S className={className}>
    <path d="m5 4 10 8-10 8V4Z" /><path d="M19 5v14" />
  </S>
);
export const IconFlag = ({ className }: P) => (
  <S className={className}>
    <path d="M5 21V4" /><path d="M5 4c2.5-1.8 5 1.8 7.5 0S17 2.5 19 4v9c-2-1.5-4.5-1.5-6.5 0S7.5 14.8 5 13" />
  </S>
);
export const IconEnd = ({ className }: P) => (
  <S className={className}>
    <path d="M21.5 15.5v2a2 2 0 0 1-2.2 2 19.6 19.6 0 0 1-8.5-3 19.3 19.3 0 0 1-6-6 19.6 19.6 0 0 1-3-8.6A2 2 0 0 1 3.8 0h2a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L7 7.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z" transform="translate(0 2.2)" />
  </S>
);
export const IconChat = ({ className }: P) => (
  <S className={className}>
    <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z" /><path d="M8 8.5h8M8 12h5" opacity=".6" />
  </S>
);
export const IconSend = ({ className }: P) => (
  <S className={className}>
    <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" />
  </S>
);
export const IconFull = ({ className }: P) => (
  <S className={className}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </S>
);
export const IconExitFull = ({ className }: P) => (
  <S className={className}>
    <path d="M4 14h6v6" /><path d="m10 14-7 7" /><path d="M20 10h-6V4" /><path d="m14 10 7-7" />
  </S>
);
export const IconAspect = ({ className }: P) => (
  <S className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M15 3v18" />
  </S>
);
export const IconClose = ({ className }: P) => (
  <S className={className}>
    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
  </S>
);
export const IconCopy = ({ className }: P) => (
  <S className={className}>
    <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </S>
);
export const IconSun = ({ className }: P) => (
  <S className={className}>
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </S>
);
export const IconMoon = ({ className }: P) => (
  <S className={className}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </S>
);
export const IconCheck = ({ className }: P) => (
  <S className={className}>
    <path d="M20 6 9 17l-5-5" />
  </S>
);
export const IconPlus = ({ className }: P) => (
  <S className={className}>
    <path d="M12 5v14" /><path d="M5 12h14" />
  </S>
);
export const IconUserPlus = ({ className }: P) => (
  <S className={className}>
    <circle cx="9" cy="8" r="4" /><path d="M2 21c0-4 3-6 7-6s7 2 7 6" /><path d="M19 8v6" /><path d="M22 11h-6" />
  </S>
);
export const IconRefresh = ({ className }: P) => (
  <S className={className}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" />
  </S>
);
export const IconLink = ({ className }: P) => (
  <S className={className}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </S>
);
export const IconShield = ({ className }: P) => (
  <S className={className}>
    <path d="M12 2 4.5 5v6c0 5 3.2 8.7 7.5 10.5 4.3-1.8 7.5-5.5 7.5-10.5V5L12 2Z" /><path d="m9 11.5 2.2 2.2L15.5 9.5" />
  </S>
);
export const IconBolt = ({ className }: P) => (
  <S className={className}>
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
  </S>
);
