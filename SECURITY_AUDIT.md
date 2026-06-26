# 安全说明

最后更新：2026-06-18

## 当前架构

- 前端通过同源 API 读取和保存数据，不再把链接和背景设置写入 `localStorage`。
- 单管理员账号由 `.env` 配置，服务启动时写入 SQLite。
- 密码使用 bcrypt 哈希保存，数据库不保存明文密码。
- 登录状态使用 httpOnly session cookie。
- 登录接口按 IP + 用户名做失败次数限制，超过阈值会临时锁定。
- 背景图片文件保存到 `data/uploads/backgrounds/`，SQLite 只保存图片路径或外部图片 URL。

## 已实现的保护

- API 均要求登录，除了 `POST /api/login` 和 `GET /api/me`。
- `POST /api/login` 默认 15 分钟内失败 5 次后返回 429，并带 `Retry-After`。
- 链接 URL 只允许 `http://` 和 `https://`。
- 自定义搜索引擎 URL 只允许 `http://` 和 `https://`。
- 背景 URL 只允许 `http://`、`https://` 或 `/uploads/backgrounds/` 路径。
- 上传背景限制为 JPG、PNG、WebP、GIF，大小上限 5MB。
- 上传文件使用随机文件名，不信任原始文件名。
- 静态文件不直接暴露项目根目录，只显式提供页面、样式、脚本和 `/uploads` 路径。
- CSP 限制默认资源来源，图片允许 `blob:` 用于本地上传预览。

## 部署注意

- 生产环境必须使用 HTTPS。
- `.env` 不要提交到仓库。
- `SESSION_SECRET` 默认自动生成到 `data/session-secret`；生产环境需要持久化 `data/`，或显式设置外部 secret。
- `ADMIN_PASSWORD` 应使用强密码。
- `data/` 是运行时数据目录，需要纳入服务器备份策略。

## 建议测试

- 未登录访问 `/api/settings`、`/api/links`、`/api/background` 应返回 401。
- 错误账号密码应无法登录。
- 连续错误登录超过阈值后应返回 429。
- 刷新页面后 session 应保持登录。
- 上传超过 5MB 的图片应被拒绝。
- 上传非图片文件应被拒绝。
- 删除或替换背景后，数据库中应只保留新的路径或空字符串。
