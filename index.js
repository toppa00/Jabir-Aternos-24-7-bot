const mineflayer = require("mineflayer");
const express = require("express");
const http = require("http");
const https = require("https");

const config = require("./settings.json");

let bot = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let intentionalStop = false;
let startTime = Date.now();
let activityTimer = null;
let lookTimer = null;
let chatTimer = null;
let positionTimer = null;

const app = express();
const PORT = Number(process.env.PORT || 5000);

const state = {
  connected: false,
  lastActivity: Date.now(),
  lastError: null
};

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function clearBotTimers() {
  for (const timer of [activityTimer, lookTimer, chatTimer, positionTimer]) {
    if (timer) clearInterval(timer);
  }
  activityTimer = null;
  lookTimer = null;
  chatTimer = null;
  positionTimer = null;
}

function scheduleReconnect() {
  if (intentionalStop || reconnectTimer) return;

  reconnectAttempts += 1;

  const base = Number(config.utils?.["auto-reconnect-delay"] || 5000);
  const max = Number(config.utils?.["max-reconnect-delay"] || 30000);
  const delay = Math.min(base + (reconnectAttempts - 1) * 1000, max);

  log(`Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);
}

function discordWebhook(message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  try {
    const parsed = new URL(url);
    const payload = JSON.stringify({ content: message });

    const request = (parsed.protocol === "https:" ? https : http).request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        res.resume();
      }
    );

    request.on("error", (err) => log(`[Discord] ${err.message}`));
    request.write(payload);
    request.end();
  } catch (err) {
    log(`[Discord] Invalid webhook URL: ${err.message}`);
  }
}

function sendChatMessages() {
  if (!bot || !state.connected) return;

  const messages = config.utils?.["chat-messages"]?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  let index = 0;

  const sendOne = () => {
    if (!bot || !state.connected) return;
    const message = messages[index % messages.length];
    index += 1;

    try {
      bot.chat(String(message));
      state.lastActivity = Date.now();
    } catch (err) {
      log(`[Chat] ${err.message}`);
    }
  };

  sendOne();

  if (config.utils?.["chat-messages"]?.repeat) {
    const delay = Math.max(
      10000,
      Number(config.utils?.["chat-messages"]?.["repeat-delay"] || 60000)
    );
    chatTimer = setInterval(sendOne, delay);
  }
}

function startAntiAfk() {
  if (!config.utils?.["anti-afk"]?.enabled) return;

  activityTimer = setInterval(() => {
    if (!bot || !state.connected) return;

    try {
      bot.setControlState("jump", true);

      setTimeout(() => {
        if (bot) {
          try {
            bot.setControlState("jump", false);
          } catch (_) {}
        }
      }, 250);

      if (config.utils["anti-afk"].sneak) {
        bot.setControlState("sneak", true);
        setTimeout(() => {
          if (bot) {
            try {
              bot.setControlState("sneak", false);
            } catch (_) {}
          }
        }, 500);
      }

      state.lastActivity = Date.now();
    } catch (err) {
      log(`[Anti-AFK] ${err.message}`);
    }
  }, 30000);
}

function startMovement() {
  if (!config.movement?.enabled) return;

  const circle = config.movement["circle-walk"];
  if (circle?.enabled) {
    let direction = 0;

    positionTimer = setInterval(() => {
      if (!bot || !state.connected) return;

      try {
        const directions = ["forward", "left", "back", "right"];
        const current = directions[direction % directions.length];
        direction += 1;

        bot.clearControlStates();
        bot.setControlState(current, true);

        setTimeout(() => {
          if (bot) {
            try {
              bot.clearControlStates();
            } catch (_) {}
          }
        }, Math.max(500, Math.min(Number(circle.speed || 3000), 5000)));

        state.lastActivity = Date.now();
      } catch (err) {
        log(`[Movement] ${err.message}`);
      }
    }, Math.max(1000, Number(circle.speed || 3000)));
  }

  const look = config.movement["look-around"];
  if (look?.enabled) {
    lookTimer = setInterval(() => {
      if (!bot || !state.connected) return;

      try {
        const yaw = Math.random() * Math.PI * 2 - Math.PI;
        const pitch = (Math.random() - 0.5) * 0.6;
        bot.look(yaw, pitch, true).catch(() => {});
        state.lastActivity = Date.now();
      } catch (err) {
        log(`[Look] ${err.message}`);
      }
    }, Math.max(2000, Number(look.interval || 5000)));
  }

  const jump = config.movement["random-jump"];
  if (jump?.enabled && !activityTimer) {
    activityTimer = setInterval(() => {
      if (!bot || !state.connected) return;
      try {
        bot.setControlState("jump", true);
        setTimeout(() => {
          if (bot) {
            try {
              bot.setControlState("jump", false);
            } catch (_) {}
          }
        }, 250);
        state.lastActivity = Date.now();
      } catch (_) {}
    }, Math.max(3000, Number(jump.interval || 10000)));
  }
}

function setupAuth() {
  if (!config.utils?.["auto-auth"]?.enabled) return;

  let handled = false;

  const onMessage = (message) => {
    if (handled || !bot || !state.connected) return;

    const text = String(message).toLowerCase();
    const password = config.utils["auto-auth"].password;

    try {
      if (text.includes("register") || text.includes("/register")) {
        handled = true;
        bot.chat(`/register ${password} ${password}`);
        log("[Auth] Register command sent.");
      } else if (text.includes("login") || text.includes("/login")) {
        handled = true;
        bot.chat(`/login ${password}`);
        log("[Auth] Login command sent.");
      }
    } catch (err) {
      log(`[Auth] ${err.message}`);
    }
  };

  bot.on("messagestr", onMessage);
}

function createBot() {
  if (intentionalStop || bot) return;

  const account = config["bot-account"] || {};
  const server = config.server || {};

  log(`Connecting to ${server.ip}:${server.port} as ${account.username}`);

  try {
    bot = mineflayer.createBot({
      username: account.username,
      password: account.password || undefined,
      auth: account.type || "offline",
      host: server.ip,
      port: Number(server.port),
      version: server.version || false,
      hideErrors: false,
      checkTimeoutInterval: 120000
    });

    bot.once("spawn", () => {
      state.connected = true;
      state.lastActivity = Date.now();
      reconnectAttempts = 0;

      log("[Bot] Connected and spawned.");
      discordWebhook(`[+] Connected to ${server.ip}:${server.port}`);

      setupAuth();
      startAntiAfk();
      startMovement();
      sendChatMessages();
    });

    bot.on("chat", (username, message) => {
      state.lastActivity = Date.now();

      if (
        config.chat?.respond &&
        username !== bot.username &&
        typeof message === "string"
      ) {
        if (message.toLowerCase().includes(bot.username.toLowerCase())) {
          bot.chat(`Hello ${username}!`);
        }
      }

      if (config.utils?.["chat-log"]) {
        log(`[Chat] <${username}> ${message}`);
      }
    });

    bot.on("messagestr", (message) => {
      if (config.utils?.["chat-log"]) {
        log(`[Server] ${message}`);
      }
    });

    bot.on("kicked", (reason) => {
      log(`[Bot] Kicked: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`);
    });

    bot.on("error", (err) => {
      state.lastError = err.message;
      log(`[Bot] Error: ${err.message}`);
    });

    bot.on("end", (reason) => {
      state.connected = false;
      clearBotTimers();

      log(`[Bot] Disconnected: ${reason || "unknown reason"}`);
      discordWebhook(`[-] Disconnected: ${reason || "unknown reason"}`);

      bot = null;

      if (config.utils?.["auto-reconnect"] && !intentionalStop) {
        scheduleReconnect();
      }
    });
  } catch (err) {
    state.lastError = err.message;
    log(`[Bot] Creation failed: ${err.message}`);
    bot = null;
    scheduleReconnect();
  }
}

function stopBot() {
  intentionalStop = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  clearBotTimers();

  if (bot) {
    try {
      bot.clearControlStates();
      bot.quit("Stopped");
    } catch (_) {}

    bot = null;
  }

  state.connected = false;
}

function restartBot() {
  stopBot();
  intentionalStop = false;
  reconnectAttempts = 0;

  setTimeout(createBot, 1000);
}

app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.name || "AFK Bot")}</title>
<style>
body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{width:min(90%,520px);background:#1e293b;padding:28px;border-radius:18px;box-shadow:0 10px 40px #0005}
h1{margin-top:0;color:#5eead4}
.row{padding:12px;margin:10px 0;background:#0f172a;border-radius:10px}
button{padding:10px 14px;margin:5px;border:0;border-radius:8px;cursor:pointer}
</style>
</head>
<body>
<div class="card">
<h1>${escapeHtml(config.name || "AFK Bot")}</h1>
<div class="row">Status: <b id="status">Loading...</b></div>
<div class="row">Uptime: <b id="uptime">0s</b></div>
<div class="row">Server: <b>${escapeHtml(String(config.server?.ip || ""))}:${escapeHtml(String(config.server?.port || ""))}</b></div>
<div class="row">Last activity: <b id="activity">-</b></div>
<button onclick="fetch('/start',{method:'POST'})">Start</button>
<button onclick="fetch('/stop',{method:'POST'})">Stop</button>
<button onclick="fetch('/restart',{method:'POST'})">Reconnect</button>
</div>
<script>
async function update(){
 try{
  const r=await fetch('/health');
  const d=await r.json();
  document.getElementById('status').textContent=d.status;
  document.getElementById('uptime').textContent=d.uptime+'s';
  document.getElementById('activity').textContent=new Date(d.lastActivity).toLocaleTimeString();
 }catch(e){}
}
setInterval(update,1000); update();
</script>
</body>
</html>`);
});

app.get("/health", (req, res) => {
  res.json({
    status: state.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastActivity: state.lastActivity,
    reconnectAttempts,
    username: bot?.username || null,
    position: bot?.entity?.position || null,
    lastError: state.lastError
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.post("/start", (req, res) => {
  intentionalStop = false;
  createBot();
  res.json({ ok: true });
});

app.post("/stop", (req, res) => {
  stopBot();
  res.json({ ok: true });
});

app.post("/restart", (req, res) => {
  restartBot();
  res.json({ ok: true });
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.listen(PORT, "0.0.0.0", () => {
  log(`Web server listening on port ${PORT}`);
  createBot();
});

process.on("SIGTERM", () => {
  log("SIGTERM received.");
  stopBot();
  process.exit(0);
});

process.on("SIGINT", () => {
  log("SIGINT received.");
  stopBot();
  process.exit(0);
});
           
