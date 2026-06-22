# 维护记录

## 2026-06-19 — 初始部署

- 基于 Cloudflare Email Workers 实现三模式邮件代理（转发/回复/发送）
- 元数据三层冗余嵌入（邮件头 + HTML 注释 + 文本标记）
- 出站发送使用 Resend API（替换已终止的 MailChannels 免费服务）
- 附件解析使用 postal-mime（ArrayBuffer 兼容）
- 修复 wrangler non-interactive 部署失败（workers.dev 子域名注册）
- 修复 `export default` esbuild 打包导致 email handler 未被识别
- 修复 `message.text`/`message.html` 属性 vs 方法 API 差异
- 修复 ReadableStream 重复读取（引入统一 `parseRawMessage` 缓存）
- 修复 RFC 2047 编码主题解码（ISO-2022-JP / GB2312）
- 修复附件 base64 编码栈溢出（ArrayBuffer → 分块编码）
- 修复回复模式引用行 `> meta:` 正则匹配
- 修复发送模式 `---` HTML 元数据剥离
- 安全检查：非 B 伪造发送头 → 转发模式（不中继）
- 安全检查：REPLY > SEND 优先级（回复含发送头时不误触）

## 2026-06-20 — 格式优化

- 转发邮件头部块统一为 `---` 格式（与发送模式一致）
- 字段名全小写英文：`from:` / `date:` / `to:` / `subject:` / `meta:`
- 转发标题前缀 `[FWD]`
- Meta 提取正则支持大小写不敏感和引用前缀 `>`
- 文档按 NixKits 风格编写（中英日三语、表驱动）

## 2026-06-22 — 安全加固

- 发送模式过滤 `WORKER_ADDRESS` 和 `MY_ADDRESS`（防止自指发送和回显）
- 开源就绪：去硬编码、创建 `.gitignore` / `.env.example`
- 发布到 GitHub（`Kihara777/MailKits`，MIT 协议）
