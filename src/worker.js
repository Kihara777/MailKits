// ============================================================
// Mail Worker — 收发分离的可回复域名邮箱
// ============================================================

import PostalMime from 'postal-mime';

// ── 常量 ──────────────────────────────────────────────────────
const RESEND_API = 'https://api.resend.com/emails';
const META_VERSION = 1;
const META_HEADER = 'X-GR-Meta';
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
const SEND_META_REGEX = /^---\s*\n([\s\S]*?)\n---/;

// ── 元数据编解码 ────────────────────────────────────────────────
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64) {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return null; }
}

function buildMeta({ from, messageId, subject, threadId }) {
  return {
    v: META_VERSION,
    from,
    msgid: messageId || '',
    subj: subject || '',
    tid: threadId || crypto.randomUUID(),
    ts: Math.floor(Date.now() / 1000),
  };
}

function encodeMeta(meta) { return toBase64(JSON.stringify(meta)); }

function decodeMeta(base64) {
  const json = fromBase64(base64);
  if (!json) return null;
  try {
    const meta = JSON.parse(json);
    return meta.v === META_VERSION ? meta : null;
  } catch { return null; }
}

function extractMetaFromText(text) {
  if (!text) return null;
  // 新格式: meta: <base64>（支持引用前缀 >，大小写不敏感）
  const mn = text.match(/^(?:> ?)*meta:\s*([A-Za-z0-9+/=]+)\s*$/mi);
  if (mn) { const d = decodeMeta(mn[1]); if (d) return d; }
  // 旧格式兼容: [GR-META: <base64>]
  const mo = text.match(/\[GR-META:\s*([A-Za-z0-9+/=]+)\]/);
  return mo ? decodeMeta(mo[1]) : null;
}

function extractMetaFromHtml(html) {
  if (!html) return null;
  // 新格式: meta: <base64>（转发头部块，可能在 <strong>meta:</strong> 之后）
  const mn = html.match(/meta:<\/strong>\s*([A-Za-z0-9+/=]+)/i);
  if (mn) { const d = decodeMeta(mn[1]); if (d) return d; }
  // 旧格式兼容: <!-- GR-META: <base64> -->
  const m = html.match(/<!--\s*GR-META:\s*([A-Za-z0-9+/=]+)\s*-->/);
  return m ? decodeMeta(m[1]) : null;
}

function extractMetaFromHeaders(headers) {
  const v = headers.get(META_HEADER);
  return v ? decodeMeta(v.trim()) : null;
}

function extractMeta({ text, html, headers }) {
  return extractMetaFromHeaders(headers)
    || extractMetaFromHtml(html)
    || extractMetaFromText(text);
}

function embedMetaInHtml(html, meta) {
  const marker = `\n<!-- GR-META: ${encodeMeta(meta)} -->`;
  return html.includes('</body>')
    ? html.replace('</body>', `${marker}\n</body>`)
    : html + marker;
}

function embedMetaInText(text, meta) {
  return `${text}\n\n[GR-META: ${encodeMeta(meta)}]`;
}

function embedMetaInHeaders(hdrs, meta) {
  return { ...hdrs, [META_HEADER]: encodeMeta(meta) };
}

// ── 工具函数 ────────────────────────────────────────────────────
function isAddressB(addr, myAddr) {
  return !!(addr && myAddr && addr.toLowerCase().trim() === myAddr.toLowerCase().trim());
}

function extractRawAddress(raw) {
  if (!raw) return '';
  const m = raw.match(/<([^>]+)>/);
  return m ? m[1].trim() : raw.trim();
}

// ── RFC 2047 解码（邮件头编码：=?charset?B?base64?= 等）──
function decodeRfc2047(text) {
  if (!text) return '';
  return text.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (match, charset, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === 'B'
        ? Uint8Array.from(atob(data), c => c.charCodeAt(0))
        : Uint8Array.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), c => c.charCodeAt(0));
      return new TextDecoder(charset).decode(bytes);
    } catch { return match; }
  });
}

function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n').replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function plainTextToHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 自动检测 URL 转为可点击链接
    .replace(/(https?:\/\/[^\s<>")\]]+)/g, '<a href="$1">$1</a>')
    .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')
    .replace(/^/, '<html><body><p>').replace(/$/, '</p></body></html>');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractReplyContent(text) {
  if (!text) return '';
  const patterns = [
    /\n> /, /\nOn .+ wrote:/i, /\n在 .+写道：/i,
    /\n--Original Message--/i, /\n---Original Message---/i,
    /\n-----Original Message-----/i, /\nFrom: .+\nSent: /i,
    /\nAm .+ schrieb /i,
  ];
  let bestIdx = text.length;
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m.index < bestIdx) bestIdx = m.index;
  }
  return bestIdx < text.length ? text.substring(0, bestIdx).trim() : text.trim();
}

function cleanMetaFromText(text) {
  return text ? text.replace(/\n*\[GR-META: [A-Za-z0-9+/=]+\]\n*/g, '').trim() : '';
}

function cleanMetaFromHtml(html) {
  return html ? html.replace(/\n*<!-- GR-META: [A-Za-z0-9+/=]+ -->\n*/g, '').trim() : '';
}

async function streamToArrayBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return result.buffer;
}

function uint8ToBase64(uint8) {
  // 兼容 Uint8Array 和 ArrayBuffer
  const arr = uint8 instanceof Uint8Array ? uint8 : new Uint8Array(uint8);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < arr.length; i += CHUNK)
    binary += String.fromCharCode(...arr.subarray(i, Math.min(i + CHUNK, arr.length)));
  return btoa(binary);
}

function arrayBufferToBase64(buffer) {
  return uint8ToBase64(new Uint8Array(buffer));
}

function parseSendMeta(text) {
  if (!text) return null;
  const m = text.match(SEND_META_REGEX);
  if (!m) return null;
  const result = {};
  for (const line of m[1].split('\n')) {
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const key = line.substring(0, ci).trim().toLowerCase();
    const value = line.substring(ci + 1).trim();
    if (key === 'to' || key === 'cc' || key === 'bcc')
      result[key] = value.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'subject') result.subject = value;
    else if (key === 'from_name') result.from_name = value;
    else if (key === 'noreply') result.noreply = /^(?:true|yes|1)$/i.test(value);
  }
  return result.to?.length ? result : null;
}

function stripSendMeta(text) {
  return text.replace(SEND_META_REGEX, '').trimStart();
}

// ── Resend 发送 ───────────────────────────────────────────────
async function sendEmail(env, params) {
  const {
    to, from, fromName, subject,
    textBody, htmlBody, replyTo, inReplyTo, references,
    extraHeaders = {}, cc, bcc, attachments = [],
  } = params;
  const apiKey = env.RESEND_API_KEY || '';

  const toList = Array.isArray(to) ? to : [to];

  // Resend API payload format
  const payload = {
    from: fromName ? `${fromName} <${from}>` : from,
    to: toList,
    subject,
  };

  if (textBody) payload.text = textBody;
  if (htmlBody) payload.html = htmlBody;

  if (cc?.length) payload.cc = Array.isArray(cc) ? cc : [cc];
  if (bcc?.length) payload.bcc = Array.isArray(bcc) ? bcc : [bcc];
  if (replyTo) payload.reply_to = replyTo;

  // Headers
  const headers = { ...extraHeaders };
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references) headers['References'] = references;
  if (Object.keys(headers).length) payload.headers = headers;

  // Attachments
  if (attachments.length) {
    payload.attachments = attachments.map(a => ({
      filename: a.name,
      content: a.content,
      content_type: a.type || 'application/octet-stream',
    }));
  }

  console.log(`[Resend] To: ${toList.join(', ')}`);

  const resp = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '(unable to read error)');
    console.error(`[Resend] FAIL ${resp.status}:`, errBody);
    throw new Error(`Resend HTTP ${resp.status}: ${errBody}`);
  }
  console.log(`[Resend] OK ${resp.status}`);
  return resp;
}

// ── 附件读取 ────────────────────────────────────────────────────
async function readAttachments(attachments, tag) {
  if (!attachments?.length) return [];
  const result = [];
  for (const att of attachments) {
    try {
      if (att.size > MAX_ATTACHMENT_SIZE) {
        console.warn(`[${tag}] Skip large attachment: ${att.name}`);
        continue;
      }
      const buffer = await streamToArrayBuffer(att.content);
      result.push({ name: att.name, type: att.type, content: arrayBufferToBase64(buffer) });
    } catch (err) {
      console.error(`[${tag}] Failed to read attachment ${att.name}:`, err);
    }
  }
  return result;
}

// ── 统一 MIME 解析 ────────────────────────────────────────────────
async function parseRawMessage(message) {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await new PostalMime().parse(rawBuffer);

  const atts = (parsed.attachments || []).map(a => {
    let b64;
    if (typeof a.content === 'string') b64 = a.content;
    else if (a.content instanceof Uint8Array) b64 = uint8ToBase64(a.content);
    else if (a.content instanceof ArrayBuffer) b64 = uint8ToBase64(new Uint8Array(a.content));
    else b64 = '';
    return {
      name: a.filename || 'attachment',
      type: a.mimeType || 'application/octet-stream',
      content: b64,
    };
  });

  console.log(`[MIME] text=${parsed.text?.length || 0}, html=${parsed.html?.length || 0}, attachments=${atts.length}`);
  return { text: parsed.text || null, html: parsed.html || null, attachments: atts };
}

// 向后兼容别名
async function parseAttachmentsFromRaw(message) {
  return (await parseRawMessage(message)).attachments;
}

// ── 地址构造 ──────────────────────────────────────────────────
function workerAddr(env) { return env.WORKER_ALIAS + '@' + env.WORKER_DOMAIN; }

// ── 转发模式 ────────────────────────────────────────────────────
async function handleForward(message, env) {
  const workerAddress = workerAddr(env);
  const myAddress = env.MY_ADDRESS;
  const from = message.from || '';
  const rawSubject = message.headers.get('subject') || '(无主题)';
  const subject = decodeRfc2047(rawSubject);
  const messageId = message.headers.get('message-id') || '';

  console.log(`[Forward] From: ${from}, Subject: ${subject}`);

  // 统一从原始 MIME 解析正文和附件
  const { text: textBody, html: htmlBody, attachments } = await parseRawMessage(message);

  const meta = buildMeta({ from, messageId, subject, threadId: crypto.randomUUID() });
  const dateStr = new Date().toISOString();
  const encodedMeta = encodeMeta(meta);
  // 新格式：--- 开头，英文字段名，Meta 嵌入
  const headerBlock = `---\nfrom: ${from}\ndate: ${dateStr}\nto: ${myAddress}\nsubject: ${subject}\nmeta: ${encodedMeta}\n---`;

  let forwardTextBody, forwardHtmlBody;

  if (textBody) forwardTextBody = `${headerBlock}\n\n${textBody}`;
  else if (htmlBody) forwardTextBody = `${headerBlock}\n\n${htmlToPlainText(htmlBody)}`;
  else forwardTextBody = `${headerBlock}\n\n(无正文)`;

  if (htmlBody) {
    forwardHtmlBody = `<html><body>
<div style="background:#f0f0f0;padding:12px;border-radius:4px;margin-bottom:16px;font-family:monospace;font-size:13px">
<strong>from:</strong> ${escapeHtml(from)}<br>
<strong>date:</strong> ${dateStr}<br>
<strong>to:</strong> ${escapeHtml(myAddress)}<br>
<strong>subject:</strong> ${escapeHtml(subject)}<br>
<strong>meta:</strong> <span style="color:#999;font-size:11px">${encodedMeta}</span>
</div>
<hr><blockquote>${htmlBody}</blockquote></body></html>`;
  } else if (textBody) {
    forwardHtmlBody = plainTextToHtml(forwardTextBody);
  }

  const extraHeaders = embedMetaInHeaders({}, meta);

  await sendEmail(env, {
    to: myAddress, from: workerAddress, fromName: env.FROM_NAME,
    subject: `[FWD] ${subject}`,
    textBody: forwardTextBody, htmlBody: forwardHtmlBody,
    replyTo: workerAddress, extraHeaders, attachments,
  });
  console.log(`[Forward] Sent to B: ${subject}`);
}

  // ── 回复模式 ────────────────────────────────────────────────────
async function handleReply(message, env, meta, preParsed) {
  const workerAddress = workerAddr(env);
  const myAddress = env.MY_ADDRESS;

  console.log(`[Reply] To: ${meta.from}, thread: ${meta.tid}`);

  // 复用 handleMailFromB 已解析的数据，避免重复读取 ReadableStream
  const data = preParsed || await parseRawMessage(message);
  const textBody = data.text, htmlBody = data.html, attachments = data.attachments;

  let replyText, replyHtml;
  if (textBody) {
    const cleaned = cleanMetaFromText(textBody);
    console.log(`[Reply] cleaned(${cleaned.length}): ${cleaned.substring(0, 200)}`);
    replyText = extractReplyContent(cleaned);
    console.log(`[Reply] extracted(${replyText.length}): ${replyText.substring(0, 200)}`);
  }
  if (htmlBody) {
    const cleaned = cleanMetaFromHtml(htmlBody);
    const idx = cleaned.search(/<blockquote/i);
    replyHtml = idx !== -1 ? cleaned.substring(0, idx).trim() : cleaned;
  }
  if (!replyText && replyHtml) replyText = htmlToPlainText(replyHtml);
  if (!replyText) replyText = '(EMPTY)';

  let subject = meta.subj || '(无主题)';
  if (!subject.toLowerCase().startsWith('re:')) subject = `Re: ${subject}`;

  const newMeta = buildMeta({
    from: myAddress, messageId: '', subject, threadId: meta.tid,
  });

  const finalText = embedMetaInText(replyText, newMeta);
  const finalHtml = embedMetaInHtml(replyHtml || plainTextToHtml(replyText), newMeta);
  const extraHeaders = embedMetaInHeaders({}, newMeta);

  const origRefs = message.headers.get('references') || '';
  const references = origRefs ? `${origRefs} ${meta.msgid}` : meta.msgid;

  await sendEmail(env, {
    to: meta.from, from: workerAddress, fromName: env.FROM_NAME, subject,
    textBody: finalText, htmlBody: finalHtml,
    replyTo: workerAddress, inReplyTo: meta.msgid, references,
    extraHeaders, attachments,
  });
  console.log(`[Reply] Sent to A: ${meta.from}`);
}

  // ── 发送模式 ────────────────────────────────────────────────────
async function handleSend(message, env, preParsed) {
  const workerAddress = workerAddr(env);

  const data = preParsed || await parseRawMessage(message);
  const textBody = data.text, htmlBody = data.html, attachments = data.attachments;

  let sendMeta = null, isHtml = false, bodyToProcess = null;

  if (textBody) { sendMeta = parseSendMeta(textBody); if (sendMeta) bodyToProcess = textBody; }
  if (!sendMeta && htmlBody) {
    sendMeta = parseSendMeta(htmlToPlainText(htmlBody));
    if (sendMeta) { bodyToProcess = htmlBody; isHtml = true; }
  }
  if (!sendMeta) { console.log('[Send] No metadata'); return null; }

  console.log(`[Send] To: ${sendMeta.to.join(', ')}`);

  // 安全防护：过滤 Worker 自身和 B 地址，防止自指发送
  const myAddress = env.MY_ADDRESS;
  const filtered = (list) => (list || []).filter(a => a !== workerAddr(env) && a !== myAddress);
  sendMeta.to = filtered(sendMeta.to);
  if (sendMeta.cc) sendMeta.cc = filtered(sendMeta.cc);
  if (sendMeta.bcc) sendMeta.bcc = filtered(sendMeta.bcc);
  if (!sendMeta.to.length) {
    console.log('[Send] All recipients filtered — skipping');
    return null;
  }

  let finalTextBody = null, finalHtmlBody = null;
  if (isHtml) {
    finalHtmlBody = cleanMetaFromHtml(stripSendMeta(bodyToProcess));
    finalTextBody = htmlToPlainText(finalHtmlBody);
  } else {
    finalTextBody = cleanMetaFromText(stripSendMeta(bodyToProcess));
    // 从 HTML 中剥离 ---...--- 元数据块，保留原始格式
    if (htmlBody) {
      finalHtmlBody = htmlBody.replace(/^[\s\S]*?---[\s\S]*?---\s*(?:<br\s*\/?>\s*)?/i, '').trim();
      if (/^<\s*\//.test(finalHtmlBody)) finalHtmlBody = `<html><body>${finalHtmlBody}</body></html>`;
      if (!finalHtmlBody || finalHtmlBody.length < 10) finalHtmlBody = plainTextToHtml(finalTextBody);
    } else {
      finalHtmlBody = plainTextToHtml(finalTextBody);
    }
  }

  const subject = sendMeta.subject || message.headers.get('subject') || '(无主题)';

  await sendEmail(env, {
    to: sendMeta.to,
    from: sendMeta.noreply ? 'noreply@' + env.WORKER_DOMAIN : workerAddress,
    fromName: sendMeta.from_name || env.FROM_NAME,
    subject,
    textBody: finalTextBody, htmlBody: finalHtmlBody,
    cc: sendMeta.cc, bcc: sendMeta.bcc,
    attachments, replyTo: workerAddress,
  });
  console.log(`[Send] OK → ${sendMeta.to.join(', ')}`);
}

// ── 辅助：判断发送模式 ──────────────────────────────────────────
function isSendMode(textBody, htmlBody) {
  const P = /^---\s*\nto:/;
  if (textBody && P.test(textBody)) return true;
  if (htmlBody) { const plain = htmlToPlainText(htmlBody); if (P.test(plain)) return true; }
  return false;
}

// ── 处理来自 B 的邮件 ────────────────────────────────────────────
async function handleMailFromB(message, env) {
  const parsed = await parseRawMessage(message);
  const { text: textBody, html: htmlBody } = parsed;

  // 优先级：REPLY > SEND，避免回复中误触发送头
  const meta = extractMeta({ text: textBody, html: htmlBody, headers: message.headers });
  if (meta) {
    console.log(`[Worker] Mode: REPLY → ${meta.from}`);
    return await handleReply(message, env, meta, parsed);
  }

  if (isSendMode(textBody, htmlBody)) {
    console.log('[Worker] Mode: SEND');
    return await handleSend(message, env, parsed);
  }

  console.log('[Worker] Mode: FALLBACK — no meta, dropping');
  console.log(`[Debug] X-GR-Meta header: ${message.headers.get(META_HEADER) || '(absent)'}`);
  console.log(`[Debug] text(${textBody?.length || 0}): ${textBody?.substring(0, 300) || '(null)'}`);
  console.log(`[Debug] html(${htmlBody?.length || 0}): ${htmlBody?.substring(0, 300) || '(null)'}`);
}

// ============================================================
// Email Worker 入口 (Cloudflare 通过 export default 检测)
// ============================================================
export default {
  async email(message, env, ctx) {
    const fromEmail = extractRawAddress(message.from || '');

    console.log(`[Worker] Incoming: ${fromEmail} → ${message.to}`);

    if (isAddressB(fromEmail, env.MY_ADDRESS)) {
      await handleMailFromB(message, env);
    } else {
      console.log('[Worker] Mode: FORWARD');
      try {
        await handleForward(message, env);
      } catch (err) {
        console.error('[Worker] Forward failed:', err);
      }
    }
  },
};