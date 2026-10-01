# CI/CD — Автоматическое обновление данных (GitHub Actions)

За автоматический сбор данных отвечает один воркфлоу:  
**`.github/workflows/fetch-faucets.yml`**

---

## 1. Расписание запусков

```yaml
on:
  schedule:
    - cron: '13 * * * *'   # Каждый час в 13 минут
  workflow_dispatch:       # Ручной запуск через UI GitHub
  push:
    branches: [main]
    paths: ['build_faucets.js', 'init_db.js', '*.yml']
```

**Почему именно 13 минут, а не 00?**  
Многие проекты используют cron `0 * * * *` (ровно в :00), что создаёт «пик на :00» на стороне
FaucetPay API и Turso. Мы сдвигаемся на 13 минут, чтобы разгрузить API и уменьшить таймауты.

**Ручной запуск** можно вызвать в любое время:  
`Actions → Fetch Faucets → Run workflow`

---

## 2. Пошаговая схема пайплайна

```
  Шаг 0.  Checkout репозитория (actions/checkout@v4)
            ↓
  Шаг 1.  Setup Node.js 20.x (actions/setup-node@v4)
            ↓
  Шаг 2.  npm ci (установка @libsql/client)
            ↓
  Шаг 3.  📥 Скачать список кранов
             URL:    https://faucetpay.io/api/listv1/faucetlist
             Header: X-API-KEY = ${{ secrets.FAUCETPAY_API_KEY }} (опционально)
             Сохранить в ./faucets.json
             ↓
  Шаг 4.  ✅ Валидация ответа
              HTTP 200?  +  body.status == 'OK'?  +  body.data.length > 0
             В случае ошибки → немедленный exit 1 (❌ fail workflow)
            ↓
  Шаг 5.  📦 Оборачиваем в { fetched_at, data } и пишем на диск
            ↓
  Шаг 6.  🧠 node build_faucets.js --fetch-prices
            ├─ Запрос курсов CoinGecko (секрет COINGECKO_API)
            ├─ Расчёт TOTAL_BALANCE / CURRENT_HEALTH / MEDIAN_HS
            ├─ Расчёт PAID_TODAY USD + антинакрутка
            ├─ Расчёт payout_activity_hours (поиск последней выплаты)
            ├─ Расчёт Health Score (healthScore.js)
            ├─ Расчёт Rating (ratingCalculator.js)
            └─ 📥 INSERT / UPDATE в Turso (secrets.TURSO_URL + TURSO_TOKEN)
                 ├─ Таблица faucets          (строка = 1 кран)
                 └─ Таблица raw_hourly       (строка = 1 снимок)
            ↓
  Шаг 7.  💾 git commit faucets.json
            Сообщение: chore(data): hourly update [skip ci]
            [skip ci] в конце сообщает GitHub НЕ ЗАПУСКАТЬ этот же workflow ещё раз
            (иначе получится бесконечный цикл commit → push → run → commit → …)
            ↓
  Шаг 8.  ✅ Готово
```

---

## 3. Используемые GitHub Actions Secrets

Всего **4 секрета**. Имена чувствительны к регистру.

| Секрет | Назначение | Обязательно? | Пример значения |
|--------|-----------|:----------:|-----------------|
| **`TURSO_URL`** | URL к БД Turso (libsql://…) | ✅ ДА | `libsql://my-faucet-db-myorg.turso.io` |
| **`TURSO_TOKEN`** | **WRITE-READ** JWT-ключ Turso. **НИКОГДА НЕ ПУБЛИКОВАТЬ.** | ✅ ДА |  |
| `FAUCETPAY_API_KEY` | Ключ FaucetPay Dashboard → Settings → API. Увеличивает лимиты запросов. | ❌ Нет | `fp_live_xxxxxxxxxxxxxx…` |
| `COINGECKO_API` | CoinGecko Demo/Pro API-ключ (x-cg-demo-api-key / x-cg-pro-api-key). Без него курс берётся из `cryptoPrices.js` fallback или бесплатный публичный endpoint. | ❌ Нет | `CG-xxxxxxxxxxxxxxxxxxxxxxxx` |

### Как добавить секрет в репозиторий:

1. Откройте **Settings** вашего репозитория.
2. В левом меню → **Secrets and variables → Actions**.
3. Кнопка **New repository secret**.
4. Введите имя (ровно как в таблице выше) и значение.
5. Нажмите **Add secret**.

---

## 4. Флаги запуска build_faucets.js

| Флаг | Что делает |
|------|-----------|
| `--fetch-prices` | Запросить курсы у CoinGecko перед расчётом. Используется в проде. |
| `--mock-prices` | Использовать только `cryptoPrices.js` (без запроса к CoinGecko). Полезно для локальной отладки. |
| `--dry-run` | Посчитать всё, но **НЕ** писать в БД Turso и **НЕ** коммитить faucets.json. Выводит stats в stdout. |
| `--min-valid-captures 10` | Минимальное кол-во снимков в истории, чтобы кран попал в рейтинг (по умолчанию = 0). |

Пример локальной отладки:

```cmd
node build_faucets.js --dry-run --mock-prices
```

---

## 5. Антинакрутка на уровне пайплайна

Начиная с версии `v31` пайплайн `build_faucets.js` имеет 5-уровневую защиту от кранов,
накручивающих счётчик `total_users_paid` микровыплатами с нулевым объёмом. Подробно
механизм описан в [Rating-FORMULA](./Rating-FORMULA.md).

**Правило:**  
если `paid_today (USD) == 0` → считать `total_users_paid = 0`,  
→ обнуляются `daily_volume_pts`, `payout_activity_pts`, `health_pts` (Блок1 = 0).

---

## 6. Мониторинг и алерты

Если workflow завершился ❌ `fail`:

1. Откройте лог запуска.
2. Самые частые причины:
   - ❌ **Ошибка 401/403 Turso**: Токен `TURSO_TOKEN` истёк → обновите секрет.
   - ❌ **Ошибка 429 Too Many Requests CoinGecko**: Купите Pro-ключ или временно запустите с `--mock-prices`.
   - ❌ **FaucetPay API вернул 500**: Повторите запуск через 10 минут (FaucetPay периодически лежит).
   - ❌ **Git push — nothing to commit**: нормально, если данные не менялись. Workflow всё равно зелёный.

Если проблема не решается — сделайте `Run workflow` снова.
