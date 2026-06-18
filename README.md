# 个人导航首页

一个带账号登录、快捷搜索、导航链接管理和自定义背景的个人首页。

## 功能

- 账号密码登录，使用服务端 httpOnly session 保持登录状态
- 链接新增、编辑、删除和拖拽排序
- 自定义搜索引擎，支持 `{query}` 搜索词模板
- 布局列数和编辑模式持久化保存
- 背景图片支持上传文件或填写图片链接
- SQLite 保存用户设置和链接数据
- 上传的背景图片保存到服务器 `uploads/backgrounds/`，数据库只保存图片路径

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
SESSION_SECRET=换成一串足够长的随机字符串
SESSION_COOKIE_SECURE=false
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=./data/my-home.sqlite
TRUST_PROXY=false
LOGIN_MAX_FAILED_ATTEMPTS=5
LOGIN_WINDOW_MS=900000
LOGIN_LOCKOUT_MS=900000
```

4. 启动服务

```bash
npm start
```

5. 浏览器访问

```text
http://localhost:3000
```

## 容器运行

项目已经可以直接打包成 Docker 镜像。推荐用 `docker compose` 启动，这样 `data/` 和 `uploads/` 会自动持久化到卷里。

1. 准备环境变量

```bash
cp .env.example .env
```

按需修改 `.env`，至少保证这几个值可用：

```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成你的强密码
SESSION_SECRET=换成一串足够长的随机字符串
SESSION_COOKIE_SECURE=false
```

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

然后手动运行：

```bash
docker run -d \
	--name my-home \
	--env-file .env \
	-e HOST=0.0.0.0 \
	-e DATABASE_PATH=/app/data/my-home.sqlite \
	-p 3000:3000 \
	-v my-home-data:/app/data \
	-v my-home-uploads:/app/uploads \
	my-home:latest
```

## 数据保存位置

- SQLite 数据库：默认 `data/my-home.sqlite`
- 背景图片文件：默认 `uploads/backgrounds/`
- 自定义搜索引擎保存在 SQLite 中
- 数据库不会保存图片二进制或 base64，只保存背景图片路径或外部图片 URL

## 目录结构

```text
.
├── index.html
├── script.js
├── style.css
├── server.js
├── package.json
├── .env.example
├── data/                 # 运行时生成，已忽略
└── uploads/              # 运行时生成，已忽略
```

## 注意

- 第一次启动会根据 `.env` 创建单个管理员账号。
- 后续修改 `.env` 里的账号或密码并重启服务，会更新管理员账号。
- 旧版浏览器 `localStorage` 里的链接和背景不会自动迁移。
- 登录防爆破默认规则：15 分钟内同一 IP + 用户名失败 5 次后锁定 15 分钟。
- 生产环境请使用 HTTPS，设置足够强的 `SESSION_SECRET` 和管理员密码，并把 `SESSION_COOKIE_SECURE` 设为 `true`。
- 容器里如果要换端口，只改 `docker-compose.yml` 的端口映射和 `PORT` 环境变量即可。
