# Конфигурация формул (Health Score + Rating)

Веса, пороги и шкалы рейтинга НЕ захардкожены в код. Все они хранятся в одной строке
таблицы `config` в БД Turso с `mode='prod'`. Это позволяет менять формулы через админпанель
**без коммита и передеплоя**.

---

## 1. Общая структура объекта config

```sql
SELECT rating FROM config WHERE mode='prod';
```

Возвращает JSON такого вида:

```json
{
  "weights": {
    "block_1": 0.70,
    "block_2": 0.30,
    "block_3": 0.20,
    "block_4": 0.02
  },
  "block_enabled": {
    "block_1": true,
    "block_2": true,
    "block_3": false,
    "block_4": true
  },
  "thresholds": {
    "daily_volume_usd": [
      { "min": 100.0, "max": null, "points": 50 },
      { "min": 50.0,  "max": 100.0, "points": 40 },
      { "min": 10.0,  "max": 50.0,  "points": 35 },
      { "min": 5.0,   "max": 10.0,  "points": 30 },
      { "min": 1.0,   "max": 5.0,   "points": 20 },
      { "min": 0.2,   "max": 1.0,   "points": 10 },
      { "min": 0,     "max": 0.2,   "points": 0 }
    ],
    "health_score": [
      { "min": 80, "max": 100, "points": 25 },
      { "min": 60, "max": 80,  "points": 20 },
      { "min": 40, "max": 60,  "points": 15 },
      { "min": 20, "max": 40,  "points": 10 },
      { "min": 0,  "max": 20,  "points": 0 }
    ],
    "payout_activity_hours": [
      { "min": 0,  "max": 1,    "points": 25 },
      { "min": 1,  "max": 3,    "points": 20 },
      { "min": 3,  "max": 6,    "points": 15 },
      { "min": 6,  "max": 24,   "points": 10 },
      { "min": 24, "max": 72,   "points": 5 },
      { "min": 72, "max": 168,  "points": 2 },
      { "min": 168,"max": null, "points": 0 }
    ],
    "age_months": [
      { "min": 24, "max": null, "points": 50 },
      { "min": 12, "max": 24,   "points": 40 },
      { "min": 6,  "max": 12,   "points": 30 },
      { "min": 1,  "max": 6,    "points": 15 },
      { "min": 0,  "max": 1,    "points": 0 }
    ],
    "payout_type_map": {
      "Auto":   35,
      "Mixed":  20,
      "Manual": 5,
      "None":   0
    },
    "gateways_count": [
      { "min": 10, "max": null, "points": 15 },
      { "min": 5,  "max": 10,   "points": 10 },
      { "min": 2,  "max": 5,    "points": 5 },
      { "min": 0,  "max": 2,    "points": 0 }
    ],
    "grade_thresholds": {
      "A+": 95, "A": 85, "B": 70, "C": 55, "D": 35, "F": 0
    }
  }
}
```

---

## 2. Веса блоков (weights)

| Блок | Параметр | Вес по умолчанию | Описание |
|:----:|----------|:----------------:|----------|
| **1** | `weights.block_1` | `0.70` (70%) | **Платёжеспособность** (daily_volume + health + payout_activity) |
| **2** | `weights.block_2` | `0.30` (30%) | **Надёжность** (возраст + тип выплат + шлюзы) |
| **3** | `weights.block_3` | `0.20` (20%) | **UII** (модераторская оценка пользовательского опыта) |
| **4** | `weights.block_4` | `0.02` (2%) | **Bonus Points** (бонусные баллы / штрафы) |

> ✅ Полезное правило: если вы меняете вес Блока 1 с 0.7 → 0.5 — **всегда пропорционально поднимайте веса остальных**, иначе финальный рейтинг умножится на 0.9.

---

## 3. Включение / выключение блоков (block_enabled)

Любой из 4 блоков можно **полностью выключить** из формулы:

```json
"block_enabled": {
  "block_3": false
}
```

Если `block_3 = false`:
- Веса `weights.block_3` игнорируются.
- UII таргеты модерации не влияют на рейтинг.
- Колонка «Блок 3» в таблице не рисуется (или рисуется как `—`).

Часто используется при запуске MVP, когда ещё нет модератора, который расставил UII для всех 2000 кранов.

---

## 4. Пороги шкал (thresholds)

Каждый порог — это массив интервалов. Функция `getPointsFromThresholds(value, arr)` работает по принципу:
1. Выбирает первый интервал `{min, max}`, где `min ≤ value < max` (если `max = null`, то бесконечность).
2. Возвращает количество баллов `points` из этого интервала.

| Порог | Единицы | Макс баллов по умолчанию |
|-------|---------|:------------------------:|
| `thresholds.daily_volume_usd` | USD $ в сутки | **50** |
| `thresholds.health_score` | Health Score 0–100 | **25** |
| `thresholds.payout_activity_hours` | Часы с момента последней выплаты | **25** |
| `thresholds.age_months` | Возраст сайта в месяцах | **50** |
| `thresholds.payout_type_map` | Enum: Auto / Mixed / Manual / None | **35** |
| `thresholds.gateways_count` | Количество шлюзов | **15** |
| `thresholds.grade_thresholds` | Рейтинг 0–100 → буква A–F | Сами буквы |

### 4.1 Как добавить новый порог?

Пример: добавить «золотой» уровень «больше $1000/day = 70 баллов»:

```json
"daily_volume_usd": [
  { "min": 1000.0, "max": null, "points": 70 },   // ← НОВЫЙ
  { "min": 100.0,  "max": 1000.0, "points": 50 },
  ...
]
```

Сохраните строку в `config.rating` через админпанель или SQL. Формула применится сразу, без деплоя.

---

## 5. Пороги буквенных оценок (grade_thresholds)

```json
"grade_thresholds": {
  "A+": 95,
  "A":  85,
  "B":  70,
  "C":  55,
  "D":  35,
  "F":  0
}
```

Правило: `if rating >= threshold_min_letter → give the highest matching letter`.

Пример:
- **98.4** → `A+`
- **85.0** → `A`
- **84.9** → `B`
- **0.0** → `F`

---

## 6. Health Score — пороги в конфиге

Помимо рейтинга, в таблице `config` есть колонка `health` с порогами Health Score. Формат такой же, как thresholds выше:

```json
{
  "low_capital_usd": 1.00,      // кран < $1 → HS умножается на max_capital_ratio
  "micro_capital_usd": 0.01,    // кран < 1 цент → HS всегда 0
  "retention_days": 7           // окно для пикового значения capital
}
```

---

## 7. Как применить новый конфиг без деплоя

### Вариант А (админпанель, рекомендуется)
1. Войдите в админпанель.
2. Откройте «⚙️ Настройки формул» (модалка с JSON-редактором).
3. Вставьте изменённый JSON.
4. Нажмите **«💾 Применить к prod»** → выполнится `UPDATE config SET rating='…' WHERE mode='prod'`.
5. Нажмите «⟳ Обновить» на главной — все рейтинги пересчитаются локально мгновенно.

### Вариант Б (SQL)
Если админка недоступна, выполните в SQL-консоли Turso один запрос с вашим JSON:

```sql
UPDATE config
SET rating = '{ ... ваш JSON ... }', updated_at = datetime('now')
WHERE mode = 'prod';
```

---

## 8. Пример быстрых твиков формул

| Задача | Что поменять в config |
|--------|----------------------|
| Сделать «надежность» (Блок2) важнее платёжеспособности | `weights.block_1 = 0.40`, `weights.block_2 = 0.60` |
| Выключить UII (Блок3) полностью | `block_enabled.block_3 = false` |
| Больше ценить авто-выплаты | `thresholds.payout_type_map.Auto = 50` (вместо 35) |
| Сделать «F» самым жёстким (ниже 40 = F) | `grade_thresholds.D = 40`, `grade_thresholds.F = 0` |
| Требовать от кранов минимум $100/day для топ-рейтинга | `thresholds.daily_volume_usd[0] = {min:100, max:null, points:50}` |

Все изменения применяются **моментально** при следующей загрузке страницы всеми пользователями (до 100% coverage за 5 мин).
