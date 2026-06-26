# 个人导航首页

一个带账号登录、快捷搜索、导航链接管理和自定义背景的个人首页。

> 重要：当前版本重建了服务端目录和 SQLite 初始化逻辑。旧版 `data/my-home.sqlite` 没有自动迁移保证；首次启动如果检测不到新 schema 版本，会重建应用表。升级前请先备份 `data/`，从旧版升级时也建议备份旧的 `uploads/`。

## 功能

- 账号密码登录，使用服务端 httpOnly session 保持登录状态
- 链接新增、编辑、删除和拖拽排序
- 自定义搜索引擎，支持 `{query}` 搜索词模板
- 布局列数和编辑模式持久化保存
- 背景图片支持上传文件或填写图片链接
- SQLite 保存用户设置和链接数据
- 上传的背景图片保存到服务器 `data/uploads/backgrounds/`，数据库只保存图片路径
- 邮箱入口使用默认图标；其他链接图标统一由服务器获取
- 自动 favicon 抓取由服务端完成，带登录鉴权、协议/凭据校验、重定向次数、响应大小和文件类型限制

## 运行方式

这个项目现在需要通过 Node 服务访问，不能再直接双击打开 `index.html`。

1. 安装 Node.js

需要 Node.js 22.5 或更新版本。当前实现使用 Node 自带的 `node:sqlite`，不需要额外编译 SQLite 原生依赖。

2. 安装依赖

```bash
npm install
```

3. 创建环境变量

```bash
cp .env.example .env
```

然后编辑 `.env`：

```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成你的强密码
SESSION_COOKIE_SECURE=false
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=./data/my-home.sqlite
TRUST_PROXY=false
LOGIN_MAX_FAILED_ATTEMPTS=5
LOGIN_WINDOW_MS=900000
LOGIN_LOCKOUT_MS=900000
ICON_FETCH_LOG=false
#ICON_FETCH_PROXY=http://127.0.0.1:7890
```

`SESSION_SECRET` 可以不填；服务端会自动生成并复用 `data/session-secret`。如需使用外部密钥管理，可手动设置 `SESSION_SECRET` 或 `SESSION_SECRET_FILE`。

如果 Google、X 等站点无法直连，给服务端图标抓取配置代理。图标请求默认先直连，直连失败或拿不到可用图标时再使用代理。**每个图标资源（即使来自 HTML 解析的 `<link>` 或 CDN）都会独立进行「直连优先 + 失败回退代理」尝试**，而非完全跟随发现 HTML 时的模式。解析图标时会先把网址归到主域名根路径，例如 `search.bilibili.com` 先尝试 `bilibili.com`；主域名失败后再尝试 `www.` 主域名。图标来源优先使用 HTML 里声明的 favicon；如果 HTML 没有声明图标，只兜底尝试同源 `/favicon.ico`，不会请求 manifest 或其他常规猜测路径。`ICON_FETCH_PROXY` 会同时用于 HTTP/HTTPS 图标请求；也兼容 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`。`ICON_FETCH_NO_PROXY` 或 `NO_PROXY` 可指定不走代理的地址，默认已绕过 localhost 和常见内网网段。Docker 部署时，代理地址必须是容器内可访问的地址。

需要排查图标获取时，可设置 `ICON_FETCH_LOG=true`。服务端会向标准输出打印 `[icon-fetch] https://example.com/ | direct | request:start phase=html` 这类抓取日志；第一段是目标网址，第二段是直连/代理，第三段是处理事件和参数。代理请求会显示 `proxy=...`。`request:connect:fail` 表示连接失败（代理/网络/DNS 等没有拿到响应），`request:timeout` 表示请求超过超时时间，`request:access:fail` 表示访问失败（拿到 HTTP 响应但状态不可用），并会尽量带上 `durationMs`、`timeoutMs`、`errorCode`、`errorCause`。HTML 页面获取会显示 `html:fetch:success/fail`，图标链接解析会显示 `html:parse:success/fail`。代理请求会至少等待 10 秒；如果需要更久，可调大 `ICON_FETCH_TIMEOUT_MS`。在支持颜色的终端中，URL、请求、成功、失败和回退状态会用不同颜色区分。

4. 启动服务

```bash
npm start
```

运行测试：

```bash
npm test
```

5. 浏览器访问

```text
http://localhost:3000
```

## 容器运行

项目已经可以直接打包成 Docker 镜像。推荐用 `docker compose` 启动，这样 `data/` 会自动持久化到宿主目录里。镜像使用非 root 用户运行。

1. 准备环境变量

```bash
cp .env.example .env
```

按需修改 `.env`，至少保证这几个值可用：

```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成你的强密码
SESSION_COOKIE_SECURE=false
```

`SESSION_SECRET` 默认自动生成到 `data/session-secret`；如果你希望固定为外部提供的值，可以在 `.env` 中显式设置。

如果通过 HTTPS 域名和反向代理访问容器，把 `SESSION_COOKIE_SECURE=true`，并按需设置 `TRUST_PROXY=true`。如果直接用 `http://localhost:3000` 或 `http://服务器IP:3000` 访问，保持 `SESSION_COOKIE_SECURE=false`，否则浏览器不会保存登录 Cookie。

2. 构建并启动

```bash
docker compose up -d --build
```

3. 访问服务

```text
http://localhost:3000
```

4. 查看日志

```bash
docker compose logs -f
```

如果你想只构建镜像，不启动容器：

```bash
docker build -t my-home:latest .
```

在容器里运行测试：

```bash
docker compose build
docker compose run --rm my-home npm test
```

然后手动运行：

```bash
docker run -d \
	--name my-home \
	--env-file .env \
	-e HOST=0.0.0.0 \
	-e DATABASE_PATH=/app/data/my-home.sqlite \
	-p 3000:3000 \
	-v my-home-data:/app/data \
	my-home:latest
```

## 数据保存位置

- SQLite 数据库：默认 `data/my-home.sqlite`
- 背景图片文件：默认 `data/uploads/backgrounds/`，访问路径仍为 `/uploads/backgrounds/...`
- favicon 缓存：默认 `data/icon-cache-v2/`
- 自定义搜索引擎保存在 SQLite 中
- 数据库不会保存图片二进制或 base64，只保存背景图片路径、外部图片 URL 和图标版本信息

旧版默认保存在项目根目录 `uploads/backgrounds/` 的背景图片，启动时会自动复制到 `data/uploads/backgrounds/`。如果显式设置了 `UPLOADS_DIR`，则按该目录保存，不执行默认目录迁移。

## 目录结构

```text
.
├── public/
│   ├── index.html
│   ├── login.html
│   ├── style.css
│   ├── login.js
│   └── js/
│       ├── main.js
│       ├── api.js
│       ├── state.js
│       ├── icons.js
│       ├── links.js
│       ├── search.js
│       └── settings.js
├── src/server/
│   ├── app.js
│   ├── config.js
│   ├── db/
│   ├── middleware/
│   ├── routes/
│   └── services/
├── server.js
├── test/
├── package.json
├── .env.example
└── data/                 # 运行时生成，已忽略，包含 SQLite、图标缓存和上传背景
```

## 注意

- 第一次启动会根据 `.env` 创建单个管理员账号。
- 后续修改 `.env` 里的账号或密码并重启服务，会更新管理员账号。
- 当前 schema 版本不匹配时会重建应用表；升级前务必备份 `data/my-home.sqlite`。
- 旧版浏览器 `localStorage` 里的链接和背景不会自动迁移。
- 登录防爆破默认规则：15 分钟内同一 IP + 用户名失败 5 次后锁定 15 分钟。
- 生产环境请使用 HTTPS，设置强管理员密码，并把 `SESSION_COOKIE_SECURE` 设为 `true`。默认生成的 `data/session-secret` 需要随数据目录一起持久化。
- 容器里如果要换端口，只改 `docker-compose.yml` 的端口映射和 `PORT` 环境变量即可。
