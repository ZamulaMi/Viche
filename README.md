# Viche — анонімні відеозбори

Платформа миттєвого анонімного відео/аудіо спілкування: **рулетка** (випадкові пари),
**приватні кімнати** з гібридним режимом *Add Random / Kick & Replace*, модерація
(капча, мат-фільтр, автобан IP за скаргами). Медіа — **P2P WebRTC (DTLS/SRTP)**:
сервер не торкається відео.

| Шар | Технології |
|---|---|
| Сигналінг | Go 1.22, gorilla/websocket, stateless-вузли |
| Синхронізація | Redis 7: Pub/Sub, черги, rate limit, бани (TTL) |
| Довге зберігання | PostgreSQL 16: користувачі, скарги, кімнати |
| NAT traversal | coturn (TURN/STUN, long-term credentials) |
| Фронтенд | React 18 + Vite + Tailwind 4, i18n (UK/EN), dark/light |
| Медіа | WebRTC P2P, DTLS/SRTP; canvas-аватари 15 FPS (економія CPU/RAM) |

## Швидкий старт

```bash
# 1) Увесь стек (Go + Postgres + Redis + coturn + nginx):
docker compose up -d --build

# 2) Фронт (якщо ще не зібрано):
npm install && npm run build     # dist/ віддає контейнер viche-web

# 3) Відкрити:
open http://localhost:3000       # сигналінг: ws://localhost:8080/ws
```

Лише фронт (без Docker) — рулетка з'єднує **реальних відвідувачів** через
публічний сигналінг PeerJS (`0.peerjs.com`): два відкриті сайти справді
знаходять одне одного, чат — через DataConnection.

Пошук — **децентралізований** (`src/lib/roulettenet.ts`): кожен шукач займає
вільний слот-«домівку» (`viche-v2-q-NNN`) і водночас безперервно стукає до
інших слотів. Усі — і «домівки», і «мандрівники», тому немає єдиної точки
відмови (на відміну від черги з одним тримачем). Парує той, чий ID менший —
детерміновано, без дублів дзвінків. **Ботів немає**: якщо нікого нема,
пошук просто триває. «Add Random» у кімнатах теж шукає реальну людину з
цього пулу, а не створює бота.

Медіа — WebRTC (DTLS/SRTP) з **повним ICE-каскадом**: `host → srflx (STUN)
→ relay (TURN)`. Браузер сам обирає найкращий робочий шлях, тому пари
з'єднуються і в локальній, і в глобальній мережі, за будь-яким NAT.
Глобальні з'єднання між домашніми мережами проходять через Google STUN
(без TURN); для симетричних NAT (мобільні оператори) є публічні TURN
(best-effort, реквізити ротуються) — чип «ICE» на сцені показує реальний
шлях: `lan` / `stun` / `relay`.

Примусово ТІЛЬКИ глобальний relay (приватність + гарантований трафік):
власний coturn (є в compose) —
`VITE_TURN_URL=turn:ваш-хост:3478 VITE_TURN_USERNAME=… VITE_TURN_CREDENTIAL=…
VITE_RELAY_ONLY=true npm run build`.
Якщо брокер недоступний — м'який фолбек на офлайн-демо:

```bash
npm install
npm run dev
```

Горизонтальне масштабування сигналінгу:

```bash
docker compose up -d --scale viche-server=4
```

## Деплой фронту (Vercel)

У корені є `vercel.json` (`framework: vite`, `outputDirectory: dist`, SPA-rewrites),
тому попередження *"build output contains no functions or static directory"* не
з'являється:

```bash
npm i -g vercel && vercel --prod
```

Для іншого хостингу (Netlify/Cloudflare Pages) вкажіть build `npm run build`
та publish/output каталог `dist`.

## Структура

```
server/
  main.go        — init: PG, Redis, HTTP/WS, graceful shutdown
  handler.go     — WS handshake, капча/бан-чек, pumps, маршрутизація
  matcher.go     — шардовані черги пар + Redis Pub/Sub (крос-інстанс)
  room.go        — кімнати, add_random, kick_replace, крос-вузловий ефір
  moderation.go  — скарги→бан IP (ZSET+SETEX), мат-фільтр, капча, rate limit
src/
  App.tsx        — shell: теми, i18n, навігація, тікер, тости
  i18n.tsx       — словники UK/EN
  lib/rtc.ts     — getUserMedia, loopback RTCPeerConnection (демо)
  lib/sim.ts     — демо-матчер (у продакшн замінюється WS-клієнтом)
  components/    — Roulette, VideoChat, Rooms, Captcha
docker-compose.yml · deploy/{nginx.conf,schema.sql} · server/Dockerfile
vercel.json      — деплой фронту на Vercel (framework vite, output dist)
```

## WS-протокол

Єдиний JSON-конверт `{type, payload}`. Основні типи:
`hello`, `match.join`, `match.next`, `match.found`,
`rtc.offer / rtc.answer / rtc.ice`, `chat.msg`, `report.user`,
`room.create / room.join / room.leave / room.add_random / room.kick_replace`.

## Модерація

- **Капча** — математична задача перед першим WS (HMAC-токен, TTL 10 хв;
  у продакшн — hCaptcha).
- **Скарги** — sliding window `ZADD reports:{ip}` (TTL 24 год);
  ≥ 3 скарг → `SETEX ban:{ip}` на 24 год + роз'єднання сесій через Pub/Sub.
- **Мат-фільтр** — словник uk/en/ru, нормалізація проти обфускації
  (`ф.у.к` → `фук`), клієнтська і серверна сторона.
- **Rate limit** — 10 msg/сек на IP (`INCR` + `EXPIRE`).

## Масштабування

- Кожен Go-вузол **stateless** — за будь-яким LB, без sticky-сесій.
- Матчер шардований за хешем мови+тегів; пари синхронізуються Redis Pub/Sub.
- Стан кімнат — Redis (`room:{id}`, `room:{id}:peers`), медіа-сигнали —
  канал `viche:room:{id}`.
- TURN (coturn) як relay-fallback для суворих NAT/фаєрволів.
