# MailKits

[中文](../README.md) | [English](README.en.md) | [日本語](README.ja.md)

A zero-cost transparent email proxy built on Cloudflare Email Workers + Resend.

## Architecture

```
A (external) → <WORKER_ADDRESS> → Email Routing → mail-worker
                                              ├─ A ≠ B → [FWD] wrap & forward to B
                                              └─ A = B → has meta → REPLY
                                                       → ---\nto: → SEND
```

## Modes

| Mode | Trigger | Action |
|------|---------|--------|
| Forward | Not from B | Embed metadata → Send reply-able mail to B |
| Reply | B replies to forward | Unpack metadata → Reply to A as worker |
| Send | B sends `---\nto:...` | Strip header → Proxy-send to target |

## Components

| Module | File | Description |
|--------|------|-------------|
| Entry | `src/worker.js` | Mail dispatch, mode routing |
| Metadata | `src/worker.js` | JSON → base64 codec, triple-layer embed |
| Sending | `src/worker.js` | Resend API wrapper |
| Forward | `src/worker.js` | A→B wrapping, attachment passthrough |
| Reply | `src/worker.js` | B→A unpack, bidirectional reply |
| Send mode | `src/worker.js` | `---` metadata parse, proxy send |

## Deploy

```bash
cd MailKits
npm install
# cp .env.example .env && vim .env  # fill in your config
npm run setup                       # auto-configure Email Routing rules
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy \
  --var WORKER_DOMAIN:your.domain \
  --var WORKER_ALIAS:worker \
  --var MY_ADDRESS:you@example.com \
  --var FROM_NAME:YourName
```

> **Prerequisites**: Cloudflare Email Routing configured, Resend domain verified.

## Config

| Variable | Description |
|----------|-------------|
| `WORKER_DOMAIN` | Domain (constructs `alias@domain`) |
| `WORKER_ALIAS` | Worker prefix (constructs `alias@domain`) |
| `MY_ADDRESS` | B address (your mailbox) |
| `FROM_NAME` | Sender display name |
| `RESEND_API_KEY` | Resend API key (secret) |

## Metadata

Triple-layer redundant embedding, priority: header `X-GR-Meta` > HTML `<!-- GR-META: -->` > text `[GR-META:]`.

Forward header block format (unified with send mode):

```
---
from: a@example.com
date: 2026-06-20T...
to: b@example.com
subject: Original Subject
meta: eyJ2IjoxLC...
---
```

JSON structure:

| Field | Description |
|-------|-------------|
| `v` | Version (1) |
| `from` | Original sender |
| `msgid` | Original Message-ID |
| `subj` | Original subject |
| `tid` | Thread UUID |
| `ts` | Unix timestamp |

## Usage

### Forward

Anyone mails the Worker address, B receives a reply-able `[FWD]` mail.

### Reply

Reply directly to forwarded mail. Worker transparently proxies; both A and B perceive communication with the Worker address.

### Send

At the **top** of the body:

```
---
to: someone@example.com,another@example.com
cc: cc@example.com
bcc: bcc@example.com
subject: Custom Subject
---
Body…
```

| Field | Required |
|-------|----------|
| `to` | ✅ |
| `cc` | Optional |
| `bcc` | Optional |
| `subject` | Optional (inherits) |
| `from_name` | Optional (defaults to global FROM_NAME) |
| `noreply` | Optional (`true` sends from `noreply@domain`) |

## Attachments

- Preserved in forward & reply
- Max 10 MB each (skipped if exceeded)
- MIME parsing (postal-mime)

## Security

| Scenario | Behavior |
|----------|----------|
| Non-B forges send header | Forward to B (no relay) |
| B reply + send header | Reply overrides send |
| B pure send header | Normal proxy send |
| Send to Worker/B/noreply address | Auto-filtered, skipped |

## Stack

| Component | Tech |
|-----------|------|
| Runtime | Cloudflare Email Workers |
| Outbound | Resend API (100/day free) |
| Inbound | Cloudflare Email Routing |
| MIME | postal-mime |
| Storage | None (metadata in mail) |

## Authors

- **狐莉 (Kitsunori)** — Creation & maintenance
- **小爪 (Kitsunome)** — Development feat. DeepSeek V4 Pro (Max)

## License

[MIT](../LICENSE)