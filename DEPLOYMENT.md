# 真实 AI 后端部署

## 上线需要的实际配置

1. 所选模型服务的 API Key。当前已适配阿里云百炼 qwen3.8-flash，也保留 OpenAI Responses 接入。
2. 一个可运行 Node.js 24.18.x 或 Docker 的后端位置，带**持久化磁盘**。
3. 后端的 HTTPS 根地址。后端会同时提供前端界面和 API，避免跨站 cookie 问题。

当前公开地址是 GitHub Pages 展示站。本仓库不包含实际模型密钥，也没有替用户购买服务器或创建付费部署。

## 本机启动

```sh
cp .env.example .env
```

在本机编辑 `.env`：

```dotenv
AI_PROVIDER=aliyun
DASHSCOPE_API_KEY=在本机填写真实密钥
DASHSCOPE_MODEL=qwen3.8-flash
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_BUDGET_CNY=10
AI_BUDGET_MAX_CALLS=24
AI_BUDGET_PATH=./data/aliyun-budget.sqlite
NODE_ENV=development
HOST=127.0.0.1
PORT=4173
PUBLIC_ORIGIN=http://localhost:4173
DATABASE_PATH=./data/qiban.sqlite
```

然后运行 `npm start`，打开 `http://localhost:4173`。如果修改端口，同步修改 `PORT` 和 `PUBLIC_ORIGIN`。密钥和密码不要发到聊天、写进网页、提交 Git 或放进 GitHub Pages 的环境配置。

## Docker 单实例

在服务器克隆仓库并创建 `.env`。生产配置至少包括：

```dotenv
AI_PROVIDER=aliyun
DASHSCOPE_API_KEY=在服务器环境中填写
DASHSCOPE_MODEL=qwen3.8-flash
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_BUDGET_CNY=10
AI_BUDGET_MAX_CALLS=24
PUBLIC_ORIGIN=https://你的陪伴服务域名
REGISTRATION_CODE=生成一个足够长的随机邀请码
AI_USER_DAILY_LIMIT=60
AI_GLOBAL_DAILY_LIMIT=300
```

```sh
docker compose up -d --build
```

Compose 只将服务绑定到服务器回环地址 `127.0.0.1:4173`。在 HTTPS 反向代理上将你的域名转发到这个地址。必须使用与 `PUBLIC_ORIGIN` 完全一致的 HTTPS 地址登录；生产 cookie 只通过 HTTPS 发送。生产启动缺少 HTTPS 配置或邀请码时会拒绝运行。

`qiban-data` Docker 卷保存 SQLite 及其 WAL 文件。不要删除这个卷，也不要让多台机器或多个副本共享同一个 SQLite 文件。若使用其他托管平台，将 `DATABASE_PATH` 指向它的持久化磁盘；不能使用每次发布就清空的临时文件系统。

部署后先访问 `/api/config`：

```json
{"backend":true,"aiReady":true,"model":"你选择的模型","registrationRequiresCode":true}
```

`aiReady` 代表服务器有模型和密钥配置，不代表配额、网络或模型权限已通过真实请求验证。接着用一个测试账号完成真实对话、记忆确认、刷新召回与计划采用，才算模型上线验证完成。

## 前端入口

在 GitHub Pages 展示站点击「连接 AI」，填写后端 HTTPS 根地址。浏览器会打开该服务，由用户在这个地址注册/登录。不要向浏览器提供 API Key。

## 本轮真实测试

只有显式授权真实费用后才运行：

```sh
QIBAN_RUN_LIVE_TESTS=1 node --use-env-proxy --env-file=.env scripts/live-test.mjs
```

该脚本创建合成测试账号、使用临时测试数据，并生成 `reports/日期-aliyun-live.md` 和 JSON。测试HTTP访问使用专用本地连接，外部模型访问可遵循系统代理。固定预算账本跨所有测试进程和重启累加；不要删除或更换账本来绕过本轮10元限制。Windows 可以先在终端设置对应环境变量再运行同一Node命令。

仅补测上一轮失败项可设置 `QIBAN_RETRY_FAILED=1`，会保留已有成功证据，避免重复付费。未实现的摄像头、语音、推送与原生安装包在报告中单独标记，不冒充已通过。

## 更新与备份

```sh
git pull --ff-only
docker compose up -d --build
```

上面的更新保留持久化数据卷。备份 SQLite 时使用在线备份 API，或停止实例后完整备份数据目录；运行时只复制主 `.sqlite` 文件可能遗漏 WAL 中的数据。备份包含私人记忆与对话，需要与服务数据库同等保护。

服务端每分钟检查一次到期步骤，也会在用户打开空间时补做检查；已读提醒不会在当天重复生成。它不会在没有新事项时不断调用模型，也不会发送外部消息。系统通知推送是后续功能。

## 验证范围

`npm test` 使用独立临时数据库和模型替身验证账号隔离、记忆召回、忘记后的上下文清理、临时对话、计划过期冲突、重启持久化、请求去重、并发上下文失效、到期提醒与 OpenAI 请求结构。

前端同步测试另行模拟回复与保存同时返回的情况，验证新目标不会被旧回复覆盖、新回复不会被旧保存结果清除，以及忘记上下文会清理临时消息。

本地未配置真实模型密钥时，不能宣称真实模型已联通。Docker 环境需要在安装了 Docker 的实际主机上额外验证。

参考：[OpenAI 结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)、[GitHub Pages 的静态托管范围](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)。
