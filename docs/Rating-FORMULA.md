# Рейтинг — Формула расчёта (FINAL SPEC, версия v2.5)

**Версия документа: v2.5**  
Действует одновременно на клиенте (`clientCalc.calculateRating` в [app.js](../app.js)) и на сервере (`module.exports.calculateRating` в [ratingCalculator.js](../ratingCalculator.js)).  
Строгая симметрия требуется — клиент и сервер на одинаковых входных данных обязаны выдать тот же 0–100 и букву A–F.

---

## 0. Общая структура рейтинга

Финальный рейтинг крана — взвешенная сумма **4 независимых блоков**.
Каждый блок возвращает оценку **0–100 баллов**, умножается на свой вес, результат нормируется к 0–100 и округляется до 2 знаков.

| № | Блок | Оценка | Вес по умолчанию | Что измеряет |
|:-:|------|:-------:|:---------------:|-------------|
| **1** | **Платёжеспособность** | 0–100 | **70%** | Платит ли кран сейчас? (Суточный объём выплат × здоровье × активность выплат |
| **2** | **Надёжность** | 0–100 | **30%** | Старинный ли кран, тип выплат, сколько шлюзов |
| **3** | **UII** | 0–100 | **20%** | User-Index-Indicator: субъективная оценка модератора (интерфейс/поддержка |
| **4** | **Bonus Points** | 0–100 | **2%** | Положительные бонусы / отрицательные штрафы |

> 💡 Блоки 3 и 4 можно отключить целиком через `config.rating.block_enabled.block_N = false`.

---

## 1. Финальная формула сводки

```
Если блок N включён (block_enabled.block_N = true):
    weighted_N = (score_block_N × weight_N)
Иначе:
    weighted_N = 0

weighted_SUM = weighted_1 + weighted_2 + weighted_3 + weighted_4

denominator =
  (IF block_1_enabled: 100 × w1 ELSE 0) +
  (IF block_2_enabled: 100 × w2 ELSE 0) +
  (IF block_3_enabled: 100 × w3 ELSE 0) +
  (IF block_4_enabled: 100 × w4 ELSE 0)

ФИНАЛЬНЫЙ_РЕЙТИНГ (0–100) = (weighted_SUM / denominator) × 100
```

### Пример расчёта:
Блок1 = 0/100 (платит 0$), Блок2 = 58.3/100 (возраст/шлюзы хорошие), UII и Bonus отключены:
```
weighted_SUM  = 0 × 0.7 + 58.3 × 0.3 = 17.49
denominator   = 100×0.7 + 100×0.3 = 100
FINAL_RATING = (17.49 / 100) × 100 ≈ 17.5  →  буква "D"
```

---

## 2. Блок 1. Платёжеспособность (70% по умолчанию)

Сумма **ТРЁХ подблоков → 0–100 баллов максимум. Каждый подблок имеет свой порог (настраивается в `config.rating.thresholds.*`).

### 2.1. Подблок A. Суточный объём выплат (daily_volume_usd)
1. **Исходные данные:** Берём ТАБЛИЦУ `raw_hourly` → колонки `PAID_TODAY (USD) за каждый день истории → из каждого дня берём ПИК дня (максимальное значение из всех снимков дня) → вычисляем медиану этих пиков → это эталонное число `volRef`.
2. **Формула:** `dailyVolumePts = getPointsFromThresholds(volRef, thresholds.daily_volume_usd)`.

**Пример (кран viefaucet.com):**
- Пики по дням: [$803.75, $606.72, $540.51, $770.19]
- Медиана = (606.72 + 770.19) / 2 = **$688.45**
- Порог daily_volume_usd по умолчанию: ≥ $100 → 50 баллов.
- → `dailyVolumePts = 50 баллов.

### 2.2. Подблок B. Баллы за здоровье (health_score)
1. **Исходные данные:** Таблица `raw_hourly` → колонка **«Медиана HS»** последнего снимка (медиана пиков Health Score по всем дням истории).
2. **Формула:** `healthPts = getPointsFromThresholds(medianHS, thresholds.health_score)`.

**Пример viefaucet**: medianHS = 78 → порог 60–80 → **20 баллов.

### 2.3. Подблок C. Активность выплат (payout_activity_hours)
Сколько часов прошло с момента последней реальной выплаты крана.

**Алгоритм расчёта `payout_activity_hours`:**
1. Берём колонку `TOTAL_USERS_PAID` из raw_hourly. Идём по снимкам назад по времени:
   - Цикл 1 дня (текущий день): сравниваем текущий N с предыдущим, пока N не уменьшится. Количество итераций = часов.
   - Если не нашли уменьшения за 1 день → Цикл 2 (предыдущий день): берём последний N того дня и сравниваем с позапрошлым днём. И так до 8 дней.
   - Сумма итераций всех циклов = `activityRef` (в часах).
2. **Формула:** `activityPts = getPointsFromThresholds(activityRef, thresholds.payout_activity_hours)`.

**Краевой случай 1 (самый частый):**
```
Если текущий TOTAL_USERS_PAID == 0:
  сразу ставим activityPts = 0 (крайний случай 1: 169 часов = 0 баллов).
```

**Краевой случай 2 (сегодня все выплаты одинаковые):**
Идём в предыдущие дни пока не найдём уменьшения. Если за 8 дней не нашли → 169.

### 2.4. Итоговый балл Блока 1 (Суммирование и деление на 3?):
```
block_1 = round( (dailyVolumePts + healthPts + activityPts) / 3 )
(но см АНТИНАКРУТКЕ, раздел 6).
```
Пример viefaucet: 50 + 20 + 20 = 90 → **Блок 1 = 90 баллов**.

---

## 3. Блок2. Надёжность (30% по умолчанию)

| Подблок | Макс баллов | Пороги |
|---------|:-----------:|--------|
| **Возраст крана age_months** | 50 | age_months | 24 мес = 50, 12–24 = 40, 6–12 = 30, 1–6 = 15, 0–1 = 0 |
| **Тип выплаты payout_type** |35| Auto = 35, Mixed = 20, Manual = 5, None = 0 |
| **Количество шлюзов gateways_count** |15| ≥10 = 15, 5–10 = 10, 2–5 = 5, 0–2 = 0 |

```
block_2 = agePts + payoutTypePts + gatewaysPts
(Максимум 50 + 35 + 15 = 100 балов)
```

---

## 4. Блок 3. UII (20% по умолчанию)

- Целое число **0–100**, вводится вручную модератором в админке. Сохраняется в `targets_moderation.uii_points.
Порогов нет. Назначается субъективно по критериям:
 - UI / UX интерфейса,
- Скорость ответа поддержки,
- Наличие / отсутствие жалоб пользователей,
- Честность рекламных сетей.

block_3 = uii_points.

---

## 5. Блок 4. Bonus Points (2% по умолчанию)

- Значение из `targets_moderation.bonus_points`.
- Может быть **отрицательным** (штраф за накрутку, за SCAM и т.д.).
- При расчёте итоговый score_block_4 = clamp(bonus_points, 0, 100).

block_4 = max(0, min(100, bonus_points)).

---

## 6. ⚠️ Антинакрутка 7-уровневая (v 2.4+, самая важная часть спецификации)

Краны накручивают счётчик «Количество выплат» миллионами микротранзакций, чтобы получить `total_users_paid >0 при `paid_today = $0. Для борьбы существует ТРОЙНАЯ ЗАЩИТА (3 триггера CHEAT_DETECTED) + ЖЁСТКИЙ POST-PROCESSING OVERRIDE (ПОСЛЕ calculateRating), 100% гарантия.

### 6.1. Триггеры (ЛЮБОЙ из = CHEAT_DETECTED=true:
```
paidTodayRaw = paid_today
totalPaidRaw = total_users_paid

triggerA = !isFinite(paidTodayRaw) OR paidTodayRaw <= 0
triggerB = isFinite(totalPaidRaw) AND totalPaidRaw > 0 AND triggerA
triggerC = volRef <= 0 AND activityRef == 0

CHEAT_DETECTED = triggerA OR triggerB OR triggerC
```

### 6.2. Действие триггера:
```
ЕСЛИ CHEAT_DETECTED:
    dailyVolumePts = 0
    healthPts       = 0
    activityPts     = 0
    → block_1 = (0 + 0 + 0) / 3 = 0 баллов.
```

### 6.3. Жёсткий POST-PROCESSING OVERRIDE (ГАРАНТИЯ 100%, НЕ ЗАВИСИМОЙcalculateRating):
Даже если все 3 триггера по какой-то причине не сработали:
```
ЕСЛИ paid_today <= 0:
    block_1 = 0 (вручную пересчитываем финальный рейтинг по весам block_2/3/4 только,
    ratingRes.final_rating = (0 * w1 + block_2*w2 + block_3*w3 + block_4*w4) / denominator * 100
    ratingRes.grade = gradeFor(newFinal)
```
Это реализовано:
- На клиенте: computeReal → ratingRes POST-PROCESSING в app.js.
- На сервере: enrichFaucets → POST-PROCESSING override в build_faucets.js.

### 6.4. Пример для крана 123bit.com:
paid_today = $0 → triggerA=true → CHEAT_DETECTED → triggerC тоже volRef=0 activityRef=0
dailyVolumePts=0 activityPts=0 → Блок1=0
→ paid_today=0 trigger POST-PROCESSING OVERRIDE: final_rating = (58.3 * 0.30)/100 * 100 = 17.5 (это честный 17.5 из Блок2, без примеси накрученного Блока1).

### 6.5. Дополнительная защита на уровне записи:
На уровне пайплайна build_faucets.js writeFaucetsToTurso:
ЕСЛИpaid_today == 0: → объект r.paid_today / r.total_users_paid ПАТЧАТСЯ перед записью raw_json и отдельных колонок faucets → ГАРАНТИЯ, что dirty-значения никогда не попадут в БД.

---

##7. Пороги буквенных оценок rating grade_thresholds

ПоУмолчанию:
```
A+ >= 95
A  >= 85
B  >= 70
C  >= 55
D  >= 35
F  >= 0   (остальное)
```

rating >= 95.5 → `A+`
rating = 17.5 → `F`.
rating = 17.5 при пороге D >= 35? → 17.5 < 35 → буква `F`.

---

## 8. Конфигурируемость формулы без кода

Всевеса, пороги, grade_thresholds — всё это лежит в config.rating.mode=prod в БД Turso. См. полный JSON в [документе конфигурации](CONFIG.md#1-общая-структура-объекта-config).

---

## 9. История версий

| Версия | Дата | Изменения |
|--------|------|-----------|
| v1.0 | 2026-08-15 | 3 блока (платежеспособность/возраст/UII, веса 50/30/20 |
| v2.0 | 2026-09-01 | Добавлен Блок4 Bonus, веса 70/30/20/2 |
| v2.1 | 2026-09-15 | Добавлена тройная А/B/C |
| v2.2 | 2026-09-28 | Добавлен POST-PROCESSING OVERRIDE paid_today=0 гарантия 100%, патчинг на запись writeFaucetsToTurso |
| v2.3 | 2026-09-29 | Добавлен пример 123bit.com, уточнены краевые случаи hours_since_last_payout, тройная защита на всех уровнях |
| v2.4 | 2026-09-29 | Финальная спецификация, симметрия client/server |
| v2.5 | 2026-10-01 | Финальная версия документа с примерами и всеми триггерами |

---

## 10. Проверка симметрии

Команда разработчикам:

```cmd
node build_faucets.js --dry-run --mock-prices
```
Сравните столбец rating из вывода с рейтингами в браузере. Дельта >0.01 на 99% кранов. При несовпадении — ищите ошибку в одном из 4 файлов (app.js/ratingCalculator.js/build_faucets.js/config.rating JSON).
