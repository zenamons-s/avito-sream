# avito-stream (Nest.js + Puppeteer + WebSocket)

Что делает сервис:
- Запускает Chromium через Puppeteer и открывает Avito Messenger
- Открывает чат с TARGET_CONTACT (через поиск/сетевые ответы/скан+скролл)
- Транслирует новые сообщения на фронтенд в реальном времени через WebSocket `/ws`
- Показывает простой фронтенд на `/` (статик из `src/public`)

Ссылка на CloudPub туннель: https://<ваш-cloudpub-URL>/

## Архитектура и подход

- **Nest.js модуль и API**: `AppModule` подключает контроллеры (`HealthController`, `BindController`), шлюз (`WsGateway`) и сервисы (`AvitoWatcherService`, `TunnelService`, `CloudpubService`).
- **Браузерная автоматизация**: `AvitoWatcherService` управляет Puppeteer, открывает Avito Messenger, держит сессию и следит за новыми сообщениями.
- **Событийная шина**: `EventBus` используется для отправки статусов и событий между сервисами и WS.
- **WebSocket + фронт**: `WsGateway` публикует события на фронтенд, а статические файлы UI лежат в `src/public`.
- **Туннель наружу**: `CloudpubService` (или универсальный `TunnelService`) поднимает внешний URL для доступа к UI/WS.

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

#### Автоматизация авторизации (headless)
Если нужно без UI, можно передать cookies через переменные окружения. **Автоматизация логина без хранения пароля реализуется только через cookies.**
```
AVITO_COOKIES_PATH=/path/to/cookies.json
# или
AVITO_COOKIES_JSON='[{"name":"sid","value":"...","domain":".avito.ru","path":"/"}]'
# или base64
AVITO_COOKIES_B64=eyJuYW1lIjoic2lkIiwidmFsdWUiOiIuLi4ifQ==
```
Cookies можно экспортировать из браузера любым cookie-exporter расширением. После загрузки cookies watcher попытается открыть мессенджер без ручного логина.

Если вы готовы хранить пароль, можно задать:
```
AVITO_LOGIN=...
AVITO_PASSWORD=...
```
При необходимости подтверждения (2FA) сервис будет ждать завершения авторизации (по умолчанию 120с, настраивается через `AVITO_2FA_TIMEOUT_MS`).

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
Если cloudpub не установлен, установи по инструкции: https://cloudpub.ru/ (CLI).

### Ручной запуск CloudPub + PUBLIC_URL
Если ты поднимаешь CloudPub вручную (например, в Windows), запусти:
```bash
clo publish http 3000
```
Затем пропиши публичный URL в окружении:
```bash
PUBLIC_URL=https://<ваш-cloudpub-URL>
```
После этого на странице в блоке **Public URL** всегда будет показываться этот адрес.

### Автозапуск туннеля и health-check
Можно запускать туннель вместе с сервисом и смотреть его статус в WS:
```
TUNNEL_COMMAND="cloudpub http 3000"
TUNNEL_HEALTH_URL=https://<ваш-URL>/
TUNNEL_HEALTH_INTERVAL_MS=30000
TUNNEL_HEALTH_TIMEOUT_MS=5000
```

## Отладка
Если watcher падает, он сохраняет:
- `debug/*.png` — скриншот страницы
- `debug/*.html` — HTML страницы
- иногда `debug/*.json` — сниффер сетевых ответов

Это помогает быстро подогнать селекторы/поиск под текущую верстку Avito.

## Надёжная фиксация чата
Чтобы стабильно открывать нужный диалог в виртуализированном списке:
1. Запусти сервис с `HEADLESS=false`.
2. В окне Puppeteer вручную открой чат.
3. В интерфейсе нажми **Bind current chat** или отправь `POST /bind/current`.
4. Для автофиксации можно включить `AUTO_BIND_ON_OPEN=true`, тогда URL чата сохранится автоматически при успешном открытии.

## Переменные окружения
Смотри `.env.example`.
