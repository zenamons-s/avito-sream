# avito-stream (Nest.js + Puppeteer + WebSocket)

Что делает сервис:
- Запускает Chromium через Puppeteer и открывает Avito Messenger
- Открывает чат с TARGET_CONTACT (через поиск/сетевые ответы/скан+скролл)
- Транслирует новые сообщения на фронтенд в реальном времени через WebSocket `/ws`
- Показывает простой фронтенд на `/` (статик из `src/public`)

## Быстрый старт

```bash
npm i
cp .env.example .env
npm run start:dev
```

Открой: `http://localhost:3000/`

### Авторизация
Первый запуск делай с `HEADLESS=false` — откроется окно Chromium. Войди в Avito (смс/2FA).
Сессия сохраняется в `.avito-profile` и в следующих запусках обычно авторизация уже не нужна.

Если Avito плохо работает в headless — для демо лучше запускать так (без видимого окна, но НЕ headless):
```bash
sudo apt update
sudo apt install -y xvfb
HEADLESS=false xvfb-run -a npm run start:dev
```

## CloudPub (туннель наружу)

После запуска сервиса пробрось порт наружу:
```bash
cloudpub http 3000
```

Открой внешний URL от cloudpub — там будет тот же фронт и подключение к WS.

## Отладка
Если watcher падает, он сохраняет:
- `debug/*.png` — скриншот страницы
- `debug/*.html` — HTML страницы
- иногда `debug/*.json` — сниффер сетевых ответов

Это помогает быстро подогнать селекторы/поиск под текущую верстку Avito.

## Переменные окружения
Смотри `.env.example`.
