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

## Доступные инструменты (MCP Tools)

| Инструмент | Описание |
|------------|----------|
| `puppeteer_navigate` | Перейти по URL (ожидание `networkidle2`) |
| `puppeteer_screenshot` | Сделать скриншот текущей страницы (base64 PNG) |
| `puppeteer_click` | Кликнуть по элементу по CSS-селектору |
| `puppeteer_fill` | Ввести текст в поле ввода по CSS-селектору |
| `puppeteer_evaluate` | Выполнить произвольный JavaScript на странице |
| `puppeteer_content` | Получить текстовое содержимое `document.body` |

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

## Подключение Antigravity (Windows)

### Требования
- Python 3.10+ с пакетом `mcp` (`pip install mcp`)

### Конфигурация

Отредактируйте файл `mcp_config.json` Antigravity:

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

`sse-bridge.py` открывает SSE-соединение к удалённому серверу и выставляет локальный stdio-транспорт. Antigravity видит его как обычный MCP-сервер, а все команды прозрачно проксируются на VPS.

## Обновление на сервере

```bash
cd ~/mcp_browser
git pull
npm run build
fuser -k 8000/tcp    # остановить текущий процесс
nohup node build/index.js > /tmp/mcp-proxy.log 2>&1 &
```

Или через systemd:
```bash
sudo systemctl restart mcp-proxy
```
