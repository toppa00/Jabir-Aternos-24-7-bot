# Fixed Aternos AFK Bot

This is a cleaned replacement for the broken `index.js` shown in the Railway logs.

## Railway

- Build command: `npm install`
- Start command: `npm start`
- No custom PORT is required; Railway supplies `PORT`.

## Configure

Edit `settings.json`:

- `bot-account.username`
- `server.ip`
- `server.port`
- `server.version`
- `utils.auto-auth.password`

For Discord notifications, set the Railway variable:

`DISCORD_WEBHOOK_URL`

Do not put a Discord webhook URL directly in GitHub.

## Important

The bot uses `auth: "offline"`, so it is intended for a server configured to allow offline/cracked accounts. An online-mode server requires a different authentication setup.

The dashboard is available at `/` and the health endpoint at `/health`.
