// WhatsApp bot controlled from Telegram. One command: /kickall
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Telegraf, Markup } = require('telegraf');
const baileys = require('@whiskeysockets/baileys');

const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser, Browsers } = baileys;

// ================= CONFIG (env vars) =================
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = Number(process.env.TELEGRAM_OWNER_ID || 0);
const KICK_ADMINS = (process.env.KICK_ADMINS || 'true').toLowerCase() === 'true';
const REQUIRE_CONFIRM = (process.env.REQUIRE_CONFIRM || 'true').toLowerCase() === 'true';
// =====================================================

if (!TOKEN || !OWNER_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID. Set them in the panel Startup tab or in a .env file.');
  console.error('Get your numeric Telegram ID from @userinfobot.');
  process.exit(1);
}

const AUTH_DIR = path.join(__dirname, 'scripts', '.whatsapp-auth');
fs.mkdirSync(path.dirname(AUTH_DIR), { recursive: true });

const bot = new Telegraf(TOKEN);
const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notify = (text, extra) => bot.telegram.sendMessage(OWNER_ID, text, extra).catch(() => {});

// state.stage: null | 'number' | 'pick' | 'confirm'
const S = { sock: null, connected: false, canPair: false, kickRunning: false, stage: null, groups: [], chosen: null };

/* ---------------- WhatsApp ---------------- */
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
  });
  S.sock = sock;
  S.canPair = false;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) S.canPair = true; // socket is ready to issue a pairing code
    if (connection === 'open') {
      S.connected = true;
      const num = sock.user?.id?.split(':')[0].split('@')[0];
      console.log('WhatsApp connected as +' + num);
      notify(`✅ WhatsApp connected as +${num}. Send /kickall to begin.`);
    }
    if (connection === 'close') {
      S.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        notify('⚠️ WhatsApp session logged out. Send /kickall to link again.');
        setTimeout(startWA, 1000);
      } else {
        setTimeout(startWA, 3000);
      }
    }
  });
}

const normJid = (j) => jidNormalizedUser(j);
function isMe(p) {
  const u = S.sock?.user || {};
  const mine = [u.id, u.lid].filter(Boolean).map(normJid);
  return [p.id, p.phoneNumber, p.lid].filter(Boolean).some((j) => mine.includes(normJid(j)));
}
const isAdminP = (p) => p.admin === 'admin' || p.admin === 'superadmin';

async function manageableGroups() {
  const all = Object.values(await S.sock.groupFetchAllParticipating());
  return all
    .filter((g) => g.participants.some((p) => isMe(p) && isAdminP(p)))
    .map((g) => ({ id: g.id, name: g.subject || 'Unnamed group', size: g.participants.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function requestPair(number) {
  if (S.sock?.authState?.creds?.registered) throw new Error('Already linked. Wait for it to reconnect.');
  for (let i = 0; i < 20 && !S.canPair; i++) await sleep(500);
  const code = await S.sock.requestPairingCode(number);
  return code.match(/.{1,4}/g).join('-');
}

function chunkLines(lines, max = 3500) {
  const out = []; let cur = '';
  for (const l of lines) {
    if ((cur + '\n' + l).length > max) { out.push(cur); cur = l; } else cur = cur ? cur + '\n' + l : l;
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------------- Telegram ---------------- */
// Only the configured owner can use the bot
bot.use((ctx, next) => (ctx.from?.id === OWNER_ID ? next() : undefined));

bot.command('kickall', async (ctx) => {
  if (S.kickRunning) return ctx.reply('A removal is already running. Please wait.');

  // Not linked yet: this command also handles first-time pairing
  if (!S.connected) {
    if (S.sock?.authState?.creds?.registered) return ctx.reply('⏳ WhatsApp is reconnecting. Try again in a few seconds.');
    S.stage = 'number';
    return ctx.reply('WhatsApp is not linked yet.\n\nSend your WhatsApp number with country code (digits only), e.g. 919876543210.');
  }

  try {
    await ctx.reply('Fetching your groups…');
    const groups = await manageableGroups();
    if (!groups.length) { S.stage = null; return ctx.reply('No groups found where you are an admin.'); }
    S.groups = groups;
    S.stage = 'pick';
    S.chosen = null;
    for (const part of chunkLines(groups.map((g, i) => `${i + 1}. ${g.name} (${g.size})`))) await ctx.reply(part);
    await ctx.reply(`Reply with a number from 1 to ${groups.length} to remove everyone from that group.`);
  } catch (e) {
    ctx.reply('❌ Failed to list groups: ' + e.message);
  }
});

bot.on('text', async (ctx) => {
  const txt = ctx.message.text.trim();

  if (S.stage === 'number') {
    const number = txt.replace(/\D/g, '');
    if (number.length < 7 || number.length > 15) return ctx.reply('That doesn’t look like a valid number. Digits only, with country code.');
    S.stage = null;
    await ctx.reply('Requesting a pairing code…');
    try {
      const code = await requestPair(number);
      return ctx.reply(
        `<b>WhatsApp pairing code:</b>\n<code>${code}</code>\n\n` +
        `On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, then enter the code.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Copy pairing code', copy_text: { text: code } }]] } }
      );
    } catch (e) {
      return ctx.reply('Could not get a pairing code: ' + e.message + '\nSend /kickall to try again.');
    }
  }

  if (S.stage === 'pick') {
    const n = /^\d+$/.test(txt) ? parseInt(txt, 10) : 0;
    if (n < 1 || n > S.groups.length) return ctx.reply(`Send a number between 1 and ${S.groups.length}.`);
    S.chosen = S.groups[n - 1];
    if (!REQUIRE_CONFIRM) return runKick(ctx);
    S.stage = 'confirm';
    return ctx.reply(
      `⚠️ Remove everyone from “${S.chosen.name}”?`,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Yes, kick all', 'kick_yes'),
        Markup.button.callback('✖️ Cancel', 'kick_no'),
      ])
    );
  }
});

bot.action('kick_yes', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (S.stage !== 'confirm' || !S.chosen) return;
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  runKick(ctx);
});

bot.action('kick_no', async (ctx) => {
  await ctx.answerCbQuery('Cancelled').catch(() => {});
  S.stage = null; S.chosen = null;
  ctx.editMessageText('Cancelled.').catch(() => {});
});

async function runKick(ctx) {
  const g = S.chosen;
  S.stage = null; S.chosen = null;
  if (!S.connected) return ctx.reply('WhatsApp is not connected.');
  S.kickRunning = true;
  const chatId = ctx.chat.id;
  const status = await ctx.reply(`🚀 Removing members from “${g.name}”…`);
  let removed = 0, failed = 0, total = 0;
  try {
    // Fetch the member list right now so it is never stale
    const meta = await S.sock.groupMetadata(g.id);
    const targets = meta.participants
      .filter((p) => !isMe(p))
      .filter((p) => p.admin !== 'superadmin') // group creator can't be removed
      .filter((p) => KICK_ADMINS || !isAdminP(p))
      .map((p) => p.id);
    total = targets.length;
    if (!total) return ctx.reply(`✅ Nobody to remove in “${g.name}”.`);

    for (let i = 0; i < total; i += 5) {
      const batch = targets.slice(i, i + 5);
      try {
        const res = await S.sock.groupParticipantsUpdate(g.id, batch, 'remove');
        const ok = Array.isArray(res) ? res.filter((r) => String(r.status) === '200').length : batch.length;
        removed += ok; failed += batch.length - ok;
      } catch { failed += batch.length; }
      if ((i / 5) % 3 === 2) {
        bot.telegram.editMessageText(chatId, status.message_id, undefined, `🚀 ${g.name}: ${removed + failed}/${total} processed…`).catch(() => {});
      }
      await sleep(2000 + Math.random() * 1500); // go slow to reduce ban risk
    }
    await ctx.reply(`✅ Done with “${g.name}”.\nRemoved: ${removed}\nFailed: ${failed} (of ${total})`);
  } catch (e) {
    await ctx.reply(`❌ Failed: ${e.message}\nRemoved before error: ${removed}`);
  } finally {
    S.kickRunning = false;
  }
}

bot.catch((e) => console.error('Telegram error:', e.message));

/* ---------------- Boot ---------------- */
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e?.message || e));
bot.telegram.setMyCommands([{ command: 'kickall', description: 'List groups and remove all members from one' }]).catch(() => {});
startWA();
bot.launch().then(() => console.log('Telegram bot running'));
process.once('SIGINT', () => { bot.stop(); process.exit(0); });
process.once('SIGTERM', () => { bot.stop(); process.exit(0); });
