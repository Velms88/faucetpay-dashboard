# Deployment на GitHub Pages

Проект создан для статического хостинга GitHub Pages. Никакого Node.js-бэкенда на сервере не требуется.
Всё, что нужно — закоммитить HTML/JS/CSS в главную ветку.

---

## 1. Предварительные требования

1. **Аккаунт GitHub** с созданным репозиторием (public или private).
2. Ветка `main` содержит все файлы проекта (`index.html`, `app.js`, `style.css`, т. д.).
3. (Опционально) Купленный домен для Custom Domain.

---

## 2. Шаг за шагом: Включить Pages

1. Откройте **Settings** вашего репозитория на GitHub (вкладка справа сверху).
2. Прокрутите вниз до раздела **Pages** (в левом меню — раздел *Code and automation*).
3. **Source**: выберите `Deploy from a branch` (а не GitHub Actions).
4. **Branch**:
   - Branch: `main`
   - Folder: `/ (root)` (корень репозитория, не docs/!)
5. Нажмите **Save**.
6. GitHub запустит билд Pages. Подождите 1–3 минуты.
7. Готово! Теперь ваш сайт доступен по адресу:

   ```
   https://<your-github-username>.github.io/faucetpay-dashboard/
   ```

> ✅ Первый деплой может занять 2–5 минут. Статус виден на вкладке **Actions → pages build and deployment**.

---

## 3. Custom Domain (свой домен)

Если хотите открывать дашборд по `https://faucets.example.com`, а не `github.io`:

1. Купите домен у регистратора (Reg.ru, Namecheap, GoDaddy и т. д.).
2. В DNS-панели регистратора создайте 4 записи:

   | Тип | Host | Value | TTL |
   |-----|------|-------|-----|
   | A | `@` | `185.199.108.153` | 300 |
   | A | `@` | `185.199.109.153` | 300 |
   | A | `@` | `185.199.110.153` | 300 |
   | A | `@` | `185.199.111.153` | 300 |
   | CNAME | `www` | `<your-username>.github.io.` | 300 |

   *(4 IP — актуальные адреса GitHub Pages на 2025–2026 год, см. [docs.github.com](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site))*

3. В корне репозитория создайте файл `CNAME` (без расширения) с одной строкой:
   ```
   faucets.example.com
   ```
   Закоммитьте и запушьте.

4. Вернитесь в **Settings → Pages** → поле **Custom domain**: введите `faucets.example.com` → **Save**.
5. Подождите 5–10 мин пока DNS распространится. GitHub автоматически выпустит Let's Encrypt-сертификат.
6. Обязательно поставьте галочку **Enforce HTTPS** (появится, когда сертификат будет выпущен).

---

## 4. Чек-лист перед каждым деплоем

✅ **Всегда** прогоняйте этот чек-лист перед `git push`. Это экономит часы отладки на проде.

| № | Проверка | Как сделать |
|--:|----------|-------------|
| 1 | **Cache-buster?** Увеличены суффиксы `?v=XX` для всех изменённых JS/CSS-файлов в `index.html` | Откройте [index.html](../index.html#L7-L55). Для `style.css`, `cryptoPrices.js`, `app.js` — если файлы менялись → `v+1`. |
| 2 | **Синтаксис JS?** Все три .js-файла парсятся Node.js | `node --check app.js && node --check build_faucets.js && node --check ratingCalculator.js` — exit 0 ✅ |
| 3 | **Секреты не утекли?** В выводе `git status` нет `Turso_DB_Connection.md`, а в `git diff` WRITE токен нигде не вшит | `git status` → `Turso_DB_Connection.md` должен быть `ignored`. `git diff` не должен содержать строк `TURSO_TOKEN = eyJ…`. |
| 4 | **Workflow green?** Последний запуск `Fetch Faucets` — зелёный ✅ | Откройте вкладку **Actions** репозитория. |
| 5 | **faucets.json актуален?** Файл faucets.json был закоммичен после последнего пайплайна (не пустой, >1000 записей) | `git log --oneline -5` — последнее сообщение должно быть «chore(data): hourly update [skip ci]». |
| 6 | **READ-ONLY токен актуален?** `TURSO_READONLY_TOKEN` в app.js ещё живой и не был отозван в Turso Dashboard | Запустите локально, откройте DevTools Network → Turso `execute` → статус 200 ✅, не 401 ❌ |
| 7 | **Пароль админпанели соответствует политике?** (опционально) Пароль UI != «admin123». | Отредактируйте `auth_config.js` перед деплоем. |

---

## 5. Типичные ошибки деплоя и решения

| Проблема после деплоя | Причина | Решение |
|------------------------|---------|---------|
| 🔴 Открывается **белая страница**, в Console ошибка `Failed to fetch` + `file://` | Пользователи открывают файл напрямую без http://. Это не ошибка деплоя. | Скажите пользователям открывать URL с `https://`. |
| 🟡 В таблице **0 записей**, DevTools → Turso → HTTP 401 Unauthorized | `TURSO_READONLY_TOKEN` в app.js истёк или был отозван. | Выпустите новый READ-ONLY токен в Turso Dashboard, замените в app.js, bump v=XX → redeploy. |
| 🟡 Цвета и стили **не обновились**, всё выглядит как в старой версии | Дисковый HTTP-кэш браузера со старым `style.css?v=5`. | Забыли сделать п.1 чек-листа (cache-buster). Вернитесь, увеличьте `?v=XX` для style.css в index.html, redeploy. |
| 🟡 Рейтинг у кранов **считается по старой формуле** (вы меняли config → rating вчера, но ничего не изменилось) | Пользовательский браузер держит старый IndexedDB `real-v3` из кэша. | Попросите пользователя нажать кнопку **«⟳ Обновить»** на дашборде (она сбрасывает кэш). Или в следующем апдейте bump-ните номер ключа в строке `const CACHE_KEY = 'real-v3'`. |
| 🟡 Custom Domain → **ERR_CONNECTION_REFUSED / 404 There isn't a GitHub Pages site here** | DNS-записи не успели распространиться или CNAME-файл неправильный. | 1) Проверьте `dig faucets.example.com` → указывает на 4 IP GitHub. 2) В `CNAME` в корне нет HTTPS:// и слэшей в конце. 3) Подождите ещё 10 минут. |
| 🔴 **GitHub Pages HTTPS не работает**, выдаёт небезопасное соединение | Let's Encrypt выпустил сертификат, но галка Enforce HTTPS не стоит, или DNS-пропагация ещё не закончилась. | Подождите 1 час. Если не поможет → удалите Custom Domain из настроек, сохраните, добавьте заново. |
| 🔴 Workflow Actions падает с `TURSO_TOKEN required but not set` | Забыли добавить секрет `TURSO_TOKEN` в Repository Secrets. | **Settings → Secrets → Actions → New secret → TURSO_TOKEN → вставьте значение.** |

---

## 6. Откат на предыдущую версию (revert deployment)

Если после деплоя всё сломалось и нужно быстро вернуть сайт:

```cmd
:: 1. Найдите хеш последнего «хорошего» коммита
git log --oneline -20

:: 2. Временный откат (не создавайте новых коммитов)
git reset --hard <good-commit-sha>

:: 3. Форсированный push на main
git push --force origin main
```

GitHub Pages автоматически пересоберёт сайт за 2 минуты.

---

## 7. Рекомендуемая стратегия релизов (best practices)

1. **Не пушьте правки формул в пятницу вечером.** Если что-то сломается — не успеете пофиксить до понедельника, а пользователи будут видеть сломанные рейтинги.
2. Для крупных правок формул используйте **feature branch + Pull Request**:
   ```cmd
   git checkout -b feature/weight-tune
   :: правите ratingCalculator.js
   git commit -m "feat(rating): rebalance weights block 1/2"
   git push --set-upstream origin feature/weight-tune
   ```
   Создавайте PR. После ревью мерджите → Pages сам передеплоится.
3. **Делайте бэкап config.mode='prod' JSON раз в месяц** через админпанель → **📤 Экспорт JSON**. Сохраняйте в password manager.
4. **Записывайте бэкап Turso** раз в неделю командой turso-cli: `turso db shell faucet-db ".dump" > dump_2026_09_29.sql`.
