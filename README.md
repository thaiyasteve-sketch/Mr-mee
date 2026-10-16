# WhatsApp bot controlled from Telegram: /kickall only

One command, `/kickall`:
1. Not linked yet? It asks for your number and sends a WhatsApp pairing code.
2. Linked? It lists every group where you are admin, numbered.
3. Reply with a number, tap Yes, and everyone is removed from that group.

The group creator and the linked number itself are never removed.

## Settings (env vars or `.env`)
- `TELEGRAM_BOT_TOKEN` (required) from @BotFather
- `TELEGRAM_OWNER_ID` (required) your numeric Telegram ID from @userinfobot. Only this user can use the bot.
- `KICK_ADMINS` (default `true`) set `false` to remove only non-admins
- `REQUIRE_CONFIRM` (default `true`) set `false` to skip the Yes/Cancel step

## Pterodactyl
1. Import `egg-whatsapp-kickall-bot.json` (Nests > Import Egg), create a server with it (Node 20, 512 MB+).
2. Fill in the Startup tab variables.
3. Upload the zip in Files, unarchive, make sure `index.js` and `package.json` sit in `/home/container`.
4. Start. Console shows `Telegram bot running`. Send `/kickall` in Telegram.

## Local
`npm install && npm start` (Node 18+).

The WhatsApp login is stored in `scripts/.whatsapp-auth`; don't delete it unless you want to re-link.
Unofficial WhatsApp protocol: mass removals can get a number flagged or banned. Use on groups you own or admin.
