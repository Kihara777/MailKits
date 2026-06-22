# MailKits

[中文](README.md) | [English](docs/README.en.md) | [日本語](docs/README.ja.md)

基于 Cloudflare Email Workers + Resend 的零成本透明邮件代理系统。

## 架构

```
A（外部发件人） → <WORKER_ADDRESS> → Email Routing → mail-worker
                                                  ├─ A ≠ B → [FWD] 打包转发给 B
                                                  └─ A = B → 含 meta → REPLY
                                                           → ---\nto: → SEND
```

## 模式

| 模式 | 触发 | 动作 |
|------|------|------|
| 转发 | 非 B 发来 | 嵌入元数据 → 发送可回复邮件给 B |
| 回复 | B 回复可回复邮件 | 解包元数据 → 以 worker 名义回复 A |
| 发送 | B 发送 `---\nto:...` | 去头 → 代理发送给目标 |

## 组件

| 模块 | 文件 | 说明 |
|------|------|------|
| 入口 | `src/worker.js` | 邮件分发、模式路由 |
| 元数据 | `src/worker.js` | JSON → base64 编解码、三层嵌入 |
| 发送 | `src/worker.js` | Resend API 封装 |
| 转发 | `src/worker.js` | A→B 封装、附件透传 |
| 回复 | `src/worker.js` | B→A 解包、双向可回复 |
| 发送模式 | `src/worker.js` | `---` 元数据解析、代理发送 |

## 部署

```bash
cd MailKits
npm install
# cp .env.example .env && vim .env  # 填写你的配置
npm run setup                       # 自动配置 Email Routing 规则
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy \
  --var WORKER_DOMAIN:your.domain \
  --var WORKER_ALIAS:worker \
  --var MY_ADDRESS:you@example.com \
  --var FROM_NAME:YourName
```

> **前置**：Cloudflare Email Routing 已配置、Resend 域名已验证。

## 配置

| 变量 | 说明 |
|------|------|
| `WORKER_DOMAIN` | 域名（构造 `alias@domain`） |
| `WORKER_ALIAS` | Worker 前缀（构造 `alias@domain`） |
| `MY_ADDRESS` | B 地址（你的邮箱） |
| `FROM_NAME` | 发件人显示名称 |
| `RESEND_API_KEY` | Resend API 密钥（secret） |

## 元数据

三层冗余嵌入，优先级：邮件头 `X-GR-Meta` > HTML `<!-- GR-META: -->` > 文本 `[GR-META:]`。

转发邮件头部块格式（与发送模式统一）：

```
---
from: a@example.com
date: 2026-06-20T...
to: b@example.com
subject: 原始主题
meta: eyJ2IjoxLC...
---
```

JSON 结构：

| 字段 | 说明 |
|------|------|
| `v` | 版本（1） |
| `from` | 原始发件人 |
| `msgid` | 原始 Message-ID |
| `subj` | 原始主题 |
| `tid` | 线程 UUID |
| `ts` | Unix 时间戳 |

## 使用

### 转发

任何人向 Worker 地址发邮件，B 收到 `[FWD]` 主题的可回复邮件。

### 回复

直接回复转发邮件。Worker 透明代理，A/B 双方均感知为与 Worker 地址通信。

### 发送

正文**开头**：

```
---
to: someone@example.com,another@example.com
cc: cc@example.com
bcc: bcc@example.com
subject: 自定义主题
---
邮件正文…
```

| 字段 | 必需 |
|------|------|
| `to` | ✅ |
| `cc` | 选填 |
| `bcc` | 选填 |
| `subject` | 选填（默认继承） |
| `from_name` | 选填（默认全局 FROM_NAME） |
| `noreply` | 选填（`true` 时以 `noreply@domain` 发出） |

## 附件

- 转发/回复均保留附件
- 最大 10 MB/个（超出跳过）
- MIME 解析（postal-mime）

## 安全

| 场景 | 行为 |
|------|------|
| 非 B 伪造发送头 | 转发给 B（不中继） |
| B 回复 + 发送头 | 回复优先于发送 |
| B 纯发送头 | 正常代理发送 |
| 发送头含 Worker/B 地址 | 自动过滤，跳过 |

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行 | Cloudflare Email Workers |
| 出站 | Resend API（100 封/天免费） |
| 入站 | Cloudflare Email Routing |
| MIME | postal-mime |
| 存储 | 无（元数据嵌入邮件） |

## 作者

- **狐莉 (キツのり)** — 创建和维护
- **小爪 (キツのめ)** — 开发 feat. DeepSeek V4 Pro (Max)

## 许可

[MIT](LICENSE)