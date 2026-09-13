import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'cloud-state');
const RECEIPTS = path.join(STATE, 'receipts.json');
const LOCK = path.join(STATE, 'send.lock');
fs.mkdirSync(STATE, { recursive: true });

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${crypto.randomBytes(5).toString('hex')}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
function splitMessage(text, max = 3800) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > max) {
    let end = rest.lastIndexOf('\n', max);
    if (end < max / 2) end = max;
    if (/^[\uDC00-\uDFFF]/.test(rest[end])) end--;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.length <= 1 ? chunks : chunks.map((x, i) => `(${i + 1}/${chunks.length})\n${x}`);
}
async function telegram(token, method, body) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
    });
  } catch (error) { throw new Error('텔레그램 네트워크 요청이 실패했습니다. 중복 발송 전에 수신 여부를 확인하세요.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('텔레그램 응답을 읽지 못했습니다.'); }
  if (!data.ok) throw new Error(`텔레그램 오류 ${data.error_code || response.status}: ${data.description || '설정 확인 필요'}`);
  return data.result;
}

const [fileArg, key] = process.argv.slice(2);
if (!fileArg || !key) throw new Error('사용법: node scripts/cloud_sender.mjs menus/weekly/YYYY-MM-DD.txt week-YYYY-MM-DD');
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
if (!/^\d{5,15}:[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN GitHub Secret을 확인하세요.');
if (!chatId) throw new Error('TELEGRAM_CHAT_ID GitHub Secret을 확인하세요.');
const text = fs.readFileSync(path.resolve(ROOT, fileArg), 'utf8').replace(/^\uFEFF/, '').trim();
if (!text) throw new Error('보낼 식단 파일이 비어 있습니다.');
const parts = splitMessage(text);
let fd;
try { fd = fs.openSync(LOCK, 'wx'); } catch { throw new Error('동시에 발송 중인 작업이 있습니다.'); }
try {
  const receipts = fs.existsSync(RECEIPTS) ? JSON.parse(fs.readFileSync(RECEIPTS, 'utf8')) : {};
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  let receipt = receipts[key];
  if (receipt?.status === 'sent') { console.log(JSON.stringify({ status: 'already_sent', key, messages: receipt.messageIds.length })); process.exit(0); }
  if (receipt?.pending !== undefined) throw new Error('이전 발송 결과가 불확실합니다. 텔레그램 수신 여부를 확인한 뒤 재개하세요.');
  if (receipt && receipt.hash !== hash) throw new Error('같은 주의 식단 내용이 바뀌었습니다. 기존 수신 여부를 먼저 확인하세요.');
  receipt ||= { hash, status: 'sending', messageIds: [], total: parts.length };
  receipts[key] = receipt;
  for (let index = receipt.messageIds.length; index < parts.length; index++) {
    receipt.pending = index;
    atomicWrite(RECEIPTS, JSON.stringify(receipts, null, 2));
    const sent = await telegram(token, 'sendMessage', { chat_id: chatId, text: parts[index], link_preview_options: { is_disabled: true } });
    receipt.messageIds.push(sent.message_id);
    delete receipt.pending;
    receipt.status = index === parts.length - 1 ? 'sent' : 'sending';
    receipt.sentAt = new Date().toISOString();
    atomicWrite(RECEIPTS, JSON.stringify(receipts, null, 2));
  }
  console.log(JSON.stringify({ status: 'sent', key, messages: receipt.messageIds.length }));
} finally { fs.closeSync(fd); try { fs.unlinkSync(LOCK); } catch {} }
