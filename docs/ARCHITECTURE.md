# Архитектура проекта

Общая схема работы, стек технологий и назначение каждого файла.

---

## 1. Общая схема данных (end-to-end)

```
┌─────────────────────────────┐
│  FaucetPay Public API       │
│  faucetpay.io/api/listv1    │
│  (список всех кранов)       │
└──────────────┬──────────────┘
               │  HTTP GET
               ▼
┌──────────────────────────────────────────────────────────┐
│  GitHub Actions (workflow: fetch-faucets.yml)             │
│  Каждый час в 13 минут cron: '13 * * * *'                 │
│  1) Скачивает faucets.json                                │
│  2) Запрашивает цены CoinGecko (опционально)              │
│  3) node build_faucets.js → расчёт HS/Рейтинга            │
│  4) ЗАПИСЬ через TURSO_TOKEN (WRITE-READ) в БД Turso      │
│  5) git commit faucets.json [skip ci]                     │
└──────────────────────────────────────┬────────────────────┘
                                       │ WRITE
                                       ▼
                    ┌───────────────────────────────────┐
                    │   Turso Database (Edge-SQLite)    │
                    │   Таблицы: faucets, raw_hourly,   │
                    │   targets_moderation, config      │
                    └──────────────┬────────────────────┘
                                   │ READ ONLY (public)
                                   │ READ WRITE (admin only)
                                   ▼
            ┌─────────────────────────────────────────────────────────┐
            │  Браузер пользователя (статический Frontend)            │
            │  index.html + app.js + style.css + cryptoPrices.js      │
            │  - fetch() через READ-ONLY токен Turso                  │
            │  - Кэш в IndexedDB (snapshots, ключ real-v3)            │
            │  - clientCalc: Health Score + Rating пересчитывается    │
            │    локально при каждой загрузке страницы                │
            └─────────────────────────────────────────────────────────┘
```

---

## 2. Frontend-стек

Проект использует **«ванильный» JavaScript (ES2022+) без фреймворков React/Vue/Angular**. Это
позволяет деплоить проект на GitHub Pages **без сборщика** (Vite/Webpack не нужны).

| Файл | Назначение | Ссылка |
|------|-----------|--------|
| `index.html` | **Точка входа** — разметка таблицы, модалок, подключение JS/CSS | [index.html](../index.html) |
| `app.js` | **Вся клиентская логика** (~3000 строк): загрузка БД, расчёт, рендер, админка | [app.js](../app.js) |
| `style.css` | Стили Tailwind-like, адаптив, цвета для бейджей Health/Rating | [style.css](../style.css) |
| `cryptoPrices.js` | Статический объект с ценами криптовалют (fallback, если CoinGecko недоступен) | [cryptoPrices.js](../cryptoPrices.js) |
| `auth_config.js` | Пароль **UI-уровня** для входа в админпанель (по умолчанию `admin123`) | [auth_config.js](../auth_config.js) |

### Cache-busting

Каждый скрипт/стиль подключён с суффиксом `?v=N`:

```html
<link rel="stylesheet" href="./style.css?v=5">
<script src="./cryptoPrices.js?v=1"></script>
<script src="./app.js?v=34"></script>
```

**После каждой правки JS/CSS инкрементируйте соответствующий номер.** Иначе браузер пользователей
подхватит старую версию файла из дискового HTTP-кэша.

---

## 3. Backend-скрипты (Node.js)

Эти файлы выполняются **только на сервере** (GitHub Actions или локально через `node build_faucets.js`).
Они НИКОГДА не подключаются в `<script>` браузера.

| Файл | Назначение | Ссылка |
|------|-----------|--------|
| `build_faucets.js` | **Основной пайплайн**: парсинг `faucets.json` → расчёт Health Score → расчёт Рейтинга → запись снепшотов `raw_hourly` и строк `faucets` в БД Turso через WRITE-READ токен | [build_faucets.js](../build_faucets.js) |
| `init_db.js` | **Инициализация схемы**: `CREATE TABLE` для пустой БД Turso. Запускается один раз при первом создании БД командой `npm run init-db` | [init_db.js](../init_db.js) |
| `healthScore.js` | **Серверная логика Health Score** (дублирует клиентскую функцию `clientCalc.calculateHealthScore` из `app.js`, чтобы пайплайн мог записывать готовый `health_score` в БД) | [healthScore.js](../healthScore.js) |
| `ratingCalculator.js` | **Серверная логика Рейтинга** (дублирует клиентскую `clientCalc.calculateRating`). **Обеспечивает симметрию**: формулы на клиенте и сервере обязаны выдавать одинаковые числа при одинаковых входных данных. | [ratingCalculator.js](../ratingCalculator.js) |
| `generate_mock_faucets.js` | **Генерация тестовых данных**: создаёт синтетический `faucets.json` на 50 фейковых кранов для разработки UI без доступа к реальной БД | [generate_mock_faucets.js](../generate_mock_faucets.js) |
| `generate_mock_history.js` | **Генерация тестовой истории**: заполняет `raw_hourly` синтетическими данными за 30 дней | [generate_mock_history.js](../generate_mock_history.js) |

---

## 4. Принцип симметрии клиент/сервер

⚠️ **Критически важное правило архитектуры**:

```
calculateHealthScore(faucetData) на клиенте === calculateHealthScore(faucetData) на сервере
calculateRating(faucetData)      на клиенте === calculateRating(faucetData)      на сервере
```

Если вы меняете формулу в `app.js` (клиент) — СИММЕТРИЧНО меняйте ту же строчку в
`healthScore.js` и `ratingCalculator.js` (серверный пайплайн). Иначе пользователи будут видеть
одни числа в браузере, а в БД запишутся другие.

Подробнее о формулах:
- [Health Score](./Health-FORMULA.md)
- [Rating](./Rating-FORMULA.md)
