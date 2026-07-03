# AI Booklist Assistant

Ting Reader JavaScript 插件，用于在客户端插件面板里和书库对话、生成个人书单、保存推荐理由，并导出 Markdown/JSON。

## 安装

从 GitHub Releases 下载 `ai-booklist-assistant-1.0.1.tr`，在 Ting Reader 插件管理页上传安装。

## 能力

- `ui_extension`: 全局悬浮入口、书籍详情入口、阅读器侧边栏入口、插件偏好表单。
- `tool_provider`: `assistant.chat`、`assistant.load_conversation`、`books.recommend`、`booklist.create`、`booklist.add_book`、`booklist.list`、`booklist.export`。
- `http_route`: `POST /api/v1/plugin-routes/assistant/chat`，走登录态保护。
- `HostGateway`: 通过 `books.*`、`playlists.*`、`cache.*` 等受控宿主能力读取授权资源、保存对话并创建 Ting Reader 播放列表。

## 配置

在插件管理页配置：

- `api_base_url`: OpenAI 兼容 `chat/completions` 地址。
- `api_key`: 加密保存。留空时插件不联网，使用本地规则按馆藏和最近播放生成建议。
- `model`: 默认 `gpt-4.1-mini`。
- `system_prompt`: 可覆盖内置书单助手提示词。

插件 manifest 当前声明了 `network_access: "*"`，方便适配不同 OpenAI 兼容服务。正式分发时可以改成固定域名来收窄权限。

## 对话记录如何保存

插件不直接访问 Ting Reader 主数据库。对话通过 HostGateway 的插件隔离缓存保存，书单通过 Ting Reader 播放列表能力保存：

- 服务端根目录：`<storage.data_dir>/plugin-cache`，默认是 `./data/plugin-cache`。
- 每条缓存是 JSON 文件，路径按 `plugin_id` 和 `key` 做 SHA-256 哈希，避免暴露原始 key。
- 本插件额外在 key 中加入当前用户 ID 的哈希，例如 `ai-booklist-assistant:user:<hash>:conversation-index`，避免多账号共享同一份插件缓存。
- 单条缓存记录最大约 1 MB；插件会限制历史消息、书单数量和书单条目数量。

主要缓存 key：

- `conversation-index`: 当前用户的对话摘要列表。
- `conversation:<id>`: 某个对话的消息。
- `settings`: 当前用户在插件设置入口里保存的偏好。

如果卸载插件源码不会自动清理这些缓存文件；需要清理时可删除 `data/plugin-cache` 下对应哈希目录，或后续补一个专用清理工具能力。

## 自动打包

仓库内置 GitHub Actions 工作流：

- push / pull request: 校验 `plugin.yml` 并构建 `.tr` artifact。
- tag `v*`: 构建并发布 GitHub Release。

公开发布时建议在仓库 Secret 中配置 `TRPACK_PRIVATE_KEY_JSON`，内容为 `trpack keygen` 生成的 Ed25519 private key JSON。未配置时 workflow 会使用 trpack 的临时签名，适合测试包，但不适合长期升级。
