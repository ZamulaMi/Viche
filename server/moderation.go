package main

// moderation.go — безпека та модерація.
//
//  1. Скарги: sliding window у Redis (ZSET reports:{ip}, TTL 24 год).
//     ≥ N скарг за вікно → SETEX ban:{ip} на BanTTL. Аудит — у PostgreSQL.
//  2. Мат-фільтр: словник (uk/en/ru) + нормалізація (нижній регістр,
//     прибирання розділювачів на кшталт "ф.у.к").
//  3. Капча: математична задача, токен — base64(ts:hmac_sha256(secret, ts)),
//     TTL 10 хв. У продакшн легко підміняється на hCaptcha siteverify.
//  4. Rate limit: 10 повідомлень/сек на IP (INCR + EXPIRE).

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const (
	rateLimitPerSec = 10
	captchaTTL      = 10 * time.Minute
	reportWindow    = 24 * time.Hour
)

type Moderation struct {
	rdb       *redis.Client
	db        *pgxpool.Pool
	secret    []byte
	threshold int
	banTTL    time.Duration
	dict      []string
}

func NewModeration(rdb *redis.Client, db *pgxpool.Pool, secret string, threshold int, banTTL time.Duration) *Moderation {
	return &Moderation{
		rdb:       rdb,
		db:        db,
		secret:    []byte(secret),
		threshold: threshold,
		banTTL:    banTTL,
		dict: []string{
			// en
			"fuck", "shit", "bitch", "asshole", "bastard", "dick", "pussy",
			// uk / ru
			"хуй", "хуе", "хуя", "пизд", "бляд", "блять", "сука", "сучар",
			"мудак", "мудил", "гандон", "гондон", "долбоєб", "долбойоб",
			"ідіот", "дура", "дебіл", "урод", "чмо", "падлюк", "сволоч",
		},
	}
}

/* ── Бани та скарги ───────────────────────────────────────── */

func (m *Moderation) IsBanned(ctx context.Context, ip string) bool {
	n, err := m.rdb.Exists(ctx, "ban:"+ip).Result()
	return err == nil && n > 0
}

// Report — зараховує скаргу; повертає true, якщо IP забанено.
func (m *Moderation) Report(ctx context.Context, targetIP, reporterIP, reason string) bool {
	key := "reports:" + targetIP
	now := time.Now().UnixMilli()

	// Sliding window: кожна скарга — елемент ZSET зі skorom=часом.
	m.rdb.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: fmt.Sprintf("%d:%s", now, reporterIP)})
	m.rdb.Expire(ctx, key, reportWindow)
	// Старіші за 24 год — геть.
	m.rdb.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", now-reportWindow.Milliseconds()))

	count, err := m.rdb.ZCard(ctx, key).Result()
	if err != nil {
		return false
	}

	// Аудит у Postgres — асинхронно, не блокуємо сигналінг.
	go func() {
		bg, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = m.db.Exec(bg,
			`INSERT INTO reports (target_ip, reporter_ip, reason, created_at)
			 VALUES ($1, $2, $3, now())`,
			targetIP, reporterIP, reason)
	}()

	log.Printf("report: %s ← %s (%s), count=%d", targetIP, reporterIP, reason, count)

	if int(count) >= m.threshold {
		// Автобан IP з автоматичним звільненням через TTL.
		m.rdb.Set(ctx, "ban:"+targetIP, reason, m.banTTL)
		m.rdb.Del(ctx, key)
		return true
	}
	return false
}

/* ── Мат-фільтр ───────────────────────────────────────────── */

// FilterText — повертає очищений текст і прапорець "була лайка".
func (m *Moderation) FilterText(s string) (string, bool) {
	norm := normalize(s)
	dirty := false
	for _, w := range m.dict {
		if strings.Contains(norm, w) {
			dirty = true
			break
		}
	}
	if !dirty {
		return s, false
	}
	// Маскуємо у оригіналі (зберігаємо довжину): шукаємо позиції у
	// нормалізованому рядку посимвольно.
	out := []rune(s)
	runes := []rune(norm)
	for _, w := range m.dict {
		wr := []rune(w)
		for i := 0; i+len(wr) <= len(runes); i++ {
			if string(runes[i:i+len(wr)]) == w {
				for j := i + 1; j < i+len(wr) && j < len(out); j++ {
					out[j] = '*'
				}
			}
		}
	}
	return string(out), true
}

// normalize — нижній регістр + прибирання розділювачів-обфускаторів.
func normalize(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'а' && r <= 'я', r >= '0' && r <= '9', r == 'ї' || r == 'і' || r == 'є' || r == 'ґ' || r == 'ё':
			b.WriteRune(r)
		}
	}
	return b.String()
}

/* ── Капча-токени (математична задача) ────────────────────── */

// SignCaptcha — видає токен після розв'язаної задачі (викликає окремий
// HTTP-ендпойнт, або інтегрується з hCaptcha siteverify у продакшн).
func (m *Moderation) SignCaptcha() string {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(ts))
	return base64.RawURLEncoding.EncodeToString([]byte(ts + ":" + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))))
}

// VerifyCaptcha — перевіряє HMAC і вікно 10 хвилин.
func (m *Moderation) VerifyCaptcha(_ context.Context, token string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return false
	}
	parts := strings.SplitN(string(raw), ":", 2)
	if len(parts) != 2 {
		return false
	}
	ts, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || time.Now().Unix()-ts > int64(captchaTTL.Seconds()) {
		return false
	}
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(parts[0]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(parts[1]))
}

/* ── Rate limiting ────────────────────────────────────────── */

// Allow — фіксоване вікно 1 сек, ліміт 10 повідомлень на IP.
func (m *Moderation) Allow(ctx context.Context, ip string) bool {
	key := "rl:" + ip
	n, err := m.rdb.Incr(ctx, key).Result()
	if err != nil {
		return true // Redis недоступний — не караємо користувача
	}
	if n == 1 {
		m.rdb.Expire(ctx, key, time.Second)
	}
	return n <= rateLimitPerSec
}
