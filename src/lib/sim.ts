/* ─────────────────────────────────────────────────────────────
   Viche · demo signaling engine
   Емулює чергу матчера та WS-події продакшн-сервера (server/).
   У продакшн цей модуль замінюється на WebSocket-клієнт до Go.
   ───────────────────────────────────────────────────────────── */

export type Gender = "any" | "m" | "f";
export type LangCode = "uk" | "en" | "de" | "pl" | "es";

export type Filters = {
  gender: Gender;
  lang: LangCode;
  tags: string[];
};

export type Peer = {
  id: string;
  name: string;
  gender: Exclude<Gender, "any">;
  langs: LangCode[];
  tags: string[];
  hue: number;
  ping: number;
  /** true — реальний учасник (мережевий пошук), без вигаданих тегів/мов */
  real?: boolean;
};



export const TAGS = ["music", "cinema", "games", "travel", "tech", "art", "sport", "books"] as const;
export const LANGS: LangCode[] = ["uk", "en", "de", "pl", "es"];

export const now = () => new Date().toLocaleTimeString("uk-UA", { hour12: false });
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const ri = (a: number, b: number) => Math.round(rnd(a, b));
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

const HEX = "0123456789ABCDEF";
export const shortId = (n = 4) =>
  Array.from({ length: n }, () => HEX[Math.floor(Math.random() * 16)]).join("");

/* Кімната = номер (6 цифр) + код (4 знаки). Обоє значень — у посиланні,
   тому за лінком вхід без ручного введення.                        */
export type RoomId = { number: string; code: string };
const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // без 0/O/1/I/L
export const makeRoomId = (): RoomId => ({
  number: String(ri(100000, 999999)),
  code: Array.from({ length: 4 }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join(""),
});
export const roomIdStr = (r: RoomId) => `${r.number}-${r.code}`;
export const roomLink = (r: RoomId) =>
  `${location.origin}${location.pathname}?room=${r.number}&code=${r.code}`;

export function makePeer(partial?: Partial<Peer>): Peer {
  const gender = partial?.gender ?? (Math.random() > 0.5 ? "m" : "f");
  const tags: string[] = [];
  while (tags.length < ri(2, 3)) {
    const tg = pick(TAGS);
    if (!tags.includes(tg)) tags.push(tg);
  }
  return {
    id: shortId(6),
    name: "Гість_" + shortId(4),
    gender,
    langs: Math.random() > 0.4 ? ["uk", "en"] : [pick(LANGS)],
    tags,
    hue: ri(80, 200),
    ping: ri(18, 74),
    ...partial,
  };
}

/* Фрази "співрозмовника" для демо-чату */
export const BOT_PHRASES: Record<string, string[]> = {
  uk: [
    "Привіт! Чути мене нормально?",
    "О, збіг по тегам — теж любиш це?",
    "Звідки ти? Я з Києва",
    "Класний вайб у цьому віче, чесно",
    "Го наступного разу в кімнаті посидимо?",
    "Я тут вперше, як тобі рулетка?",
  ],
  en: [
    "Hey! Can you hear me okay?",
    "Nice tag match — you into that too?",
    "Where are you from?",
    "This viche has a great vibe, honestly",
    "Wanna continue in a private room?",
    "First time here, how do you like it?",
  ],
};

/* ── Фільтр нецензурної лексики (клієнтська сторона) ───────
   Серверський відповідник: server/moderation.go              */
const PROFANITY = [
  "fuck", "shit", "bitch", "asshole", "bastard", "dick", "pussy",
  "хуй", "хуе", "хуя", "пизд", "бляд", "блять", "сука", "сучар",
  "мудак", "мудил", "гандон", "гондон", "долбойоб", "долбоєб",
  "ідіот", "дура", "дебіл", "урод", "чмо", "падлюк", "сволоч",
];

export function filterProfanity(raw: string): { text: string; flagged: boolean } {
  let text = raw;
  let flagged = false;
  for (const w of PROFANITY) {
    const re = new RegExp(w, "gi");
    if (re.test(text)) {
      flagged = true;
      text = text.replace(re, (m) => m[0] + "*".repeat(m.length - 1));
    }
  }
  return { text, flagged };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* Пошук пари: повторює логіку server/matcher.go
   (перетин мов, взаємний фільтр статі, спільні теги)          */
export async function simulateMatch(filters: Filters, fast = false): Promise<Peer> {
  await sleep(fast ? 350 : ri(500, 900));
  await sleep(fast ? 300 : ri(400, 800));
  if (filters.tags.length > 0) {
    await sleep(fast ? 300 : ri(450, 900));
  }
  const cand = makePeer({
    gender: filters.gender === "any" ? undefined : filters.gender,
    langs: [filters.lang, ...(Math.random() > 0.5 ? ["en" as LangCode] : [])],
    tags: filters.tags.length
      ? Array.from(new Set([...filters.tags.slice(0, 2), ...makePeer().tags.slice(0, 1)]))
      : undefined,
  });
  await sleep(fast ? 300 : ri(350, 700));
  await sleep(fast ? 250 : ri(300, 550));
  return cand;
}

export function randomPhrase(lang: LangCode): string {
  const pool = lang === "uk" ? BOT_PHRASES.uk : BOT_PHRASES.en;
  return pick(pool);
}
