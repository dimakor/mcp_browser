# Geoblock-Bypassing MCP Proxy Server

MCP (Model Context Protocol) сервер с удалённым браузером Puppeteer, работающий через SSE (Server-Sent Events). Предназначен для развёртывания на VPS в нужной геозоне (например, cloud.ru) для обхода геоблокировок при работе с LLM-ассистентами, такими как Google Antigravity.

## Архитектура

```
Antigravity (Windows) ←→ SSE Bridge (Python) ←→ Caddy (HTTPS :9443) ←→ Express+MCP (HTTP :8000) ←→ Puppeteer/Chrome
```

- **SSE Bridge** (`sse-bridge.py`) — локальный мост, который транслирует stdio-сообщения Antigravity в SSE-запросы к удалённому серверу
- **Caddy** — обратный прокси с TLS-терминацией на порту 9443
- **Express + MCP SDK** — сервер, принимающий SSE-соединения и маршрутизирующий команды к Puppeteer
- **Puppeteer/Chrome** — headless-браузер, выполняющий навигацию и извлечение контента

Сервер поддерживает **несколько одновременных SSE-соединений** — каждый клиент получает собственную MCP-сессию, маршрутизируемую по `sessionId`.

## Контракт для MCP-клиентов и агентов

Этот сервер сейчас предоставляет **Standard MCP SSE transport**:

1. Клиент открывает долгоживущее соединение:
   ```http
   GET /mcp/sse
   Authorization: Bearer <API_KEY>
   ```
2. Сервер сам генерирует `sessionId`, регистрирует сессию и отправляет SSE-событие:
   ```text
   event: endpoint
   data: /mcp/messages?sessionId=<server-generated-session-id>
   ```
3. Клиент отправляет JSON-RPC POST только на endpoint, который вернул сервер:
   ```http
   POST /mcp/messages?sessionId=<server-generated-session-id>
   Authorization: Bearer <API_KEY>
   ```
4. HTTP-ответ на POST обычно `202 Accepted` с пустым телом. Это нормально для SSE transport: полноценный JSON-RPC ответ приходит обратно по открытому SSE-стриму.
5. SSE-соединение должно оставаться открытым на время MCP-сессии. Когда SSE закрывается, сервер удаляет session context, и последующие POST на тот же `sessionId` будут получать `400 No active SSE session for this sessionId`.

Важные правила для агентов:

- Не полагайтесь на `sessionId`, переданный клиентом в `GET /mcp/sse?sessionId=...`. Используйте `sessionId` из `event: endpoint`.
- Не пытайтесь парсить тело `202 Accepted` как JSON. JSON-RPC responses передаются через SSE.
- `notifications/initialized` является MCP notification без `id`; обработку выполняет MCP SDK.
- Этот endpoint не является StreamableHTTP endpoint. Если клиент требует StreamableHTTP, нужен отдельный серверный endpoint на `StreamableHTTPServerTransport` или совместимый bridge. Не смешивайте ожидания StreamableHTTP с `/mcp/sse`.
- `400 No active SSE session for this sessionId` означает неверный `sessionId` или уже закрытый SSE-стрим, а не ошибку JSON-RPC handler.

## Доступные инструменты (MCP Tools)

| Инструмент | Описание |
|------------|----------|
| `proxy_fetch` | Забрать HTTP(S)-URL с VPS: HTML/API/JSON/XML/статика; возвращает статус, заголовки и текст или base64 |
| `proxy_read_page` | Открыть страницу в Chromium на VPS и вернуть видимый текст, заголовок и ссылки; подходит для JS-страниц |
| `proxy_find_links` | Найти на странице вероятные ссылки на документацию, API, PDF/DOC/XLS/JSON/XML |
| `proxy_download` | Скачать документ или бинарный файл через VPS и вернуть base64 с метаданными |
| `puppeteer_navigate` | Перейти по URL (ожидание `networkidle2`) |
| `puppeteer_screenshot` | Сделать скриншот текущей страницы (base64 PNG) |
| `puppeteer_click` | Кликнуть по элементу по CSS-селектору |
| `puppeteer_fill` | Ввести текст в поле ввода по CSS-селектору |
| `puppeteer_evaluate` | Выполнить произвольный JavaScript на странице |
| `puppeteer_content` | Получить текстовое содержимое `document.body` |

Для ассистента основными являются `proxy_fetch`, `proxy_read_page` и `proxy_find_links`: они работают как прозрачный web-прокси через российский VPS и удобны для сайтов транспортных компаний, где обычный доступ из другой геозоны недоступен.

## Установка на VPS (Ubuntu)

### 1. Системные зависимости

```bash
sudo apt update
sudo apt install -y curl software-properties-common

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Зависимости Chromium для Puppeteer
sudo apt install -y \
  libgbm1 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
  libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libxshmfence1 \
  libx11-xcb1 libxcursor1 libxi-dev libxtst6 libxss1 \
  libpangocairo-1.0-0 libgtk-3-0

# Caddy (обратный прокси с автоматическим TLS)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### 2. Установка проекта

```bash
git clone https://github.com/dimakor/mcp_browser.git ~/mcp_browser
cd ~/mcp_browser
npm install
npm run build
```

### 3. Конфигурация

1. Скопируйте и отредактируйте `.env`:
   ```bash
   cp .env.example .env
   nano .env  # Установите свой API_KEY
   ```

   Дополнительные переменные прокси:
   - `PROXY_ALLOWED_HOSTS` — опциональный allowlist доменов/TLD. Пустое значение разрешает любые публичные HTTP(S)-хосты. Пример: `ru,xn--p1ai,pecom.ru,tk-kit.ru,dellin.ru,cdek.ru`.
   - `PROXY_BLOCK_PRIVATE_NETWORKS=true` — по умолчанию блокирует `localhost`, private/VPC IP и metadata-hosts, чтобы MCP нельзя было случайно использовать как SSRF-прокси.
   - `PROXY_TIMEOUT_MS`, `PROXY_FETCH_MAX_BYTES`, `PROXY_DOWNLOAD_MAX_BYTES`, `PROXY_MAX_CHARS`, `PROXY_LINK_LIMIT` — лимиты чтения страниц и документов.

2. Настройте `Caddyfile` — замените `yourdomain.com:9443` на IP или домен вашего VPS:
   ```bash
   sudo cp Caddyfile /etc/caddy/Caddyfile
   sudo nano /etc/caddy/Caddyfile
   sudo systemctl restart caddy
   ```
   > При использовании IP-адреса Caddy создаст самоподписанный сертификат.

### 4. Запуск как systemd-сервис

```bash
# Отредактируйте User и WorkingDirectory под свой сервер
nano mcp-proxy.service

sudo cp mcp-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mcp-proxy
sudo systemctl start mcp-proxy
sudo systemctl status mcp-proxy
```

## Подключение MCP-клиента через stdio bridge

### Требования
- Python 3.10+
- Пакеты Python: `mcp` и `httpx`

```bash
pip install mcp httpx
```

### Конфигурация

Для Codex, Antigravity или другого stdio MCP-клиента укажите `sse-bridge.py` как локальный MCP server. Пример:

```json
{
  "mcpServers": {
    "russian-browser-proxy": {
      "command": "python",
      "args": [
        "c:/path/to/mcp_browser/sse-bridge.py"
      ],
      "env": {
        "PROXY_SSE_URL": "https://<VPS_IP>:9443/mcp/sse",
        "API_KEY": "<YOUR_API_KEY>",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

- `PROXY_SSE_URL` — адрес SSE-эндпоинта на VPS
- `API_KEY` — секретный ключ, совпадающий с `.env` на сервере
- `NODE_TLS_REJECT_UNAUTHORIZED=0` — необходимо при использовании самоподписанного сертификата

### Принцип работы bridge

`sse-bridge.py` открывает удалённое MCP-соединение и выставляет локальный stdio-транспорт. MCP-клиент видит bridge как обычный локальный MCP-сервер, а все команды прозрачно проксируются на VPS.

Для текущего сервера используйте URL вида:

```text
https://<VPS_IP>:9443/mcp/sse
```

Bridge умеет auto-detect Standard SSE и StreamableHTTP на стороне удалённого endpoint, но сам `mcp_browser` сейчас публикует именно Standard SSE на `/mcp/sse`.

## Проверка для агентов

Минимальная проверка после деплоя:

```bash
curl -sS http://127.0.0.1:8000/health
npm run build
```

Проверка с клиентской машины:

```bash
python test_sse.py
python test_pecom.py
```

Ожидаемые признаки рабочей установки:

- `/health` возвращает `{"ok":true,...}`.
- `test_sse.py` получает `event: endpoint` и POST на returned endpoint отвечает `202 Accepted`.
- `test_pecom.py` видит MCP tools и получает текст с `https://pecom.ru/`.
- В списке tools должны быть `proxy_fetch`, `proxy_read_page`, `proxy_find_links`, `proxy_download`, а также `puppeteer_*`.

## Диагностика типовых проблем

| Симптом | Вероятная причина | Что проверить |
|---------|-------------------|---------------|
| `400 No active SSE session for this sessionId` | POST отправлен не на returned endpoint или SSE уже закрыт | Держите GET `/mcp/sse` открытым и используйте `sessionId` из `event: endpoint` |
| Клиент падает на пустом `202 Accepted` | Клиент ожидает JSON в теле POST, а не Standard SSE | Используйте SSE MCP client или `sse-bridge.py`; JSON-RPC ответ приходит по SSE |
| `Session terminated` в клиенте, ожидающем StreamableHTTP | Клиент подключается к `/mcp/sse` как к StreamableHTTP | Настройте Standard SSE или добавьте отдельный StreamableHTTP endpoint |
| Tools не видны в Codex/агенте | Конфиг MCP изменён, но клиент не перезапущен | Перезапустите клиент/создайте новую сессию |
| Сайт возвращает `403` | Блокировка конкретного сайта, WAF, cookies/captcha, User-Agent | Сравните `proxy_fetch` и `proxy_read_page`, попробуйте другой `waitUntil`, проверьте headers/cookies |
| `EADDRINUSE :8000` | Старый ручной `node build/index.js` держит порт | Остановите старый процесс и запускайте только systemd-service |

## Обновление на сервере

```bash
cd ~/mcp_browser
git pull
npm install
npm run build
```

Перезапуск через systemd:

```bash
sudo systemctl restart mcp-proxy
sudo systemctl status mcp-proxy --no-pager
```
