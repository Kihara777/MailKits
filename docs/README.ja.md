# MailKits

[中文](../README.md) | [English](README.en.md) | [日本語](README.ja.md)

Cloudflare Email Workers + Resend によるゼロコスト透過メールプロキシ。

## アーキテクチャ

```
A（外部） → <WORKER_ADDRESS> → Email Routing → mail-worker
                                            ├─ A ≠ B → [FWD] Bへ転送
                                            └─ A = B → meta 有 → REPLY
                                                     → ---\nto: → SEND
```

## モード

| モード | トリガー | 動作 |
|--------|----------|------|
| 転送 | B 以外から | メタデータ埋込 → Bへ返信可能メール送信 |
| 返信 | B が返信可能メールに返信 | メタデータ展開 → Worker名義でAに返信 |
| 送信 | B が `---\nto:...` を送信 | ヘッダ除去 → 対象へプロキシ送信 |

## コンポーネント

| モジュール | ファイル | 説明 |
|------------|----------|------|
| エントリ | `src/worker.js` | メール振分、モードルーティング |
| メタデータ | `src/worker.js` | JSON → base64 コーデック、三重埋込 |
| 送信 | `src/worker.js` | Resend API ラッパー |
| 転送 | `src/worker.js` | A→B ラップ、添付ファイル透過 |
| 返信 | `src/worker.js` | B→A 展開、双方向返信 |
| 送信モード | `src/worker.js` | `---` メタデータ解析、プロキシ送信 |

## デプロイ

```bash
cd MailKits
npm install
# wrangler.toml を編集して WORKER_ADDRESS と MY_ADDRESS を設定
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

> **前提**：Cloudflare Email Routing 設定済、Resend ドメイン検証済。

## 設定

| 変数 | 説明 |
|------|------|
| `WORKER_DOMAIN` | ドメイン（`alias@domain` 構築） |
| `WORKER_ALIAS` | Worker 接頭辞（`alias@domain` 構築） |
| `MY_ADDRESS` | B アドレス（あなたのメール） |
| `FROM_NAME` | 送信者表示名 |
| `RESEND_API_KEY` | Resend API キー（secret） |

## メタデータ

三重冗長埋込、優先順位：ヘッダ `X-GR-Meta` > HTML `<!-- GR-META: -->` > テキスト `[GR-META:]`。

転送メールのヘッダブロック形式（送信モードと統一）：

```
---
from: a@example.com
date: 2026-06-20T...
to: b@example.com
subject: 元の件名
meta: eyJ2IjoxLC...
---
```

JSON 構造：

| フィールド | 説明 |
|------------|------|
| `v` | バージョン（1） |
| `from` | 元の送信者 |
| `msgid` | 元の Message-ID |
| `subj` | 元の件名 |
| `tid` | スレッド UUID |
| `ts` | Unix タイムスタンプ |

## 使い方

### 転送

誰かが Worker アドレスにメール → B が `[FWD]` 件名の返信可能メールを受信。

### 返信

転送メールに直接返信。Worker が透過的にプロキシ。

### 送信

本文の**先頭**に：

```
---
to: someone@example.com,another@example.com
cc: cc@example.com
bcc: bcc@example.com
subject: カスタム件名
---
本文…
```

| フィールド | 必須 |
|------------|------|
| `to` | ✅ |
| `cc` | 任意 |
| `bcc` | 任意 |
| `subject` | 任意（継承） |
| `from_name` | 任意（グローバル FROM_NAME にフォールバック） |
| `noreply` | 任意（`true` で `noreply@domain` から送信） |

## 添付ファイル

- 転送・返信で保持
- 最大 10 MB/個（超過時スキップ）
- MIME 解析（postal-mime）

## セキュリティ

| シナリオ | 動作 |
|----------|------|
| B 以外が送信ヘッダ偽装 | B へ転送（中継しない） |
| B の返信 + 送信ヘッダ | 返信が優先 |
| B の純粋な送信ヘッダ | 通常のプロキシ送信 |
| Worker/B アドレスへの送信 | 自動除去、スキップ |

## 技術スタック

| コンポーネント | 技術 |
|----------------|------|
| ランタイム | Cloudflare Email Workers |
| 送信 | Resend API（100通/日 無料） |
| 受信 | Cloudflare Email Routing |
| MIME | postal-mime |
| ストレージ | なし（メタデータはメールに埋込） |

## 作者

- **狐莉 (キツのり)** — 作成・保守
- **小爪 (キツのめ)** — 開発 feat. DeepSeek V4 Pro (Max)

## ライセンス

[MIT](../LICENSE)
