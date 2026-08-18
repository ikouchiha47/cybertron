import { subscribe } from "./events";
import { config } from "./devices";
import type { SimDevice } from "./server";

const DASHBOARD_PORT = 9100;

function html(devices: SimDevice[], stateMap: Map<string, Record<string, unknown>>): string {
  const devicesMeta = devices.map((d) => ({
    id: d.id, name: d.name, category: d.category, port: d.port,
    icon: config[d.category]?.icon ?? "📦",
    controls: config[d.category]?.controls ?? [],
  }));

  const cards = devices.map((d) => {
    const state = stateMap.get(d.id) ?? {};
    const icon = config[d.category]?.icon ?? "📦";
    const rows = Object.entries(state)
      .map(([k, v]) => `<tr><td class="key">${k}</td><td class="val">${JSON.stringify(v)}</td></tr>`)
      .join("");
    return `
      <div class="card" id="card-${d.id}" onclick="openPanel('${d.id}')" role="button" tabindex="0">
        <div class="card-header">
          <span class="icon">${icon}</span>
          <div class="card-info">
            <div class="device-name">${d.name}</div>
            <div class="device-meta">${d.category} · port ${d.port}</div>
            <div class="device-id">${d.id}</div>
          </div>
          <span class="open-hint">controls →</span>
        </div>
        <table class="state-table" id="state-${d.id}">${rows}</table>
      </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Device Simulator</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #f0f0f0; color: #1a1a1a; min-height: 100vh; }

  header { background: #fff; border-bottom: 1px solid #ddd; padding: 14px 24px;
           display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 17px; font-weight: 700; letter-spacing: -.3px; }
  .badge { background: #e8f4fd; color: #0070c9; border-radius: 20px;
           padding: 2px 10px; font-size: 12px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #34c759; flex-shrink: 0; }

  .devices { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
             gap: 14px; padding: 20px 24px; }
  .card { background: #fff; border-radius: 14px; border: 1px solid #e0e0e0;
          padding: 16px; cursor: pointer; transition: box-shadow .15s, border-color .15s; }
  .card:hover { box-shadow: 0 4px 18px rgba(0,0,0,.1); border-color: #b0c8e8; }
  .card:focus { outline: 2px solid #0070c9; }
  .card-header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
  .icon { font-size: 26px; line-height: 1.1; flex-shrink: 0; }
  .card-info { flex: 1; min-width: 0; }
  .device-name { font-weight: 600; font-size: 14px; }
  .device-meta { font-size: 12px; color: #666; margin-top: 2px; }
  .device-id  { font-size: 10px; color: #bbb; font-family: monospace; margin-top: 2px; }
  .open-hint { font-size: 11px; color: #aaa; flex-shrink: 0; align-self: center; white-space: nowrap; }
  .card:hover .open-hint { color: #0070c9; }
  .state-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .state-table tr { border-top: 1px solid #f2f2f2; }
  .state-table .key { color: #666; padding: 3px 0; width: 42%; }
  .state-table .val { font-family: monospace; color: #0070c9; font-weight: 600; }
  .flash { animation: flash .35s ease; }
  @keyframes flash { 0%,100%{background:#fff} 50%{background:#fff9e6} }

  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.25);
             opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 100; }
  .overlay.open { opacity: 1; pointer-events: all; }
  .panel { position: fixed; top: 0; right: -420px; width: 380px; max-width: 95vw;
           height: 100vh; background: #fff; box-shadow: -4px 0 24px rgba(0,0,0,.12);
           display: flex; flex-direction: column; transition: right .22s ease; z-index: 101; overflow: hidden; }
  .panel.open { right: 0; }
  .panel-header { padding: 18px 20px 14px; border-bottom: 1px solid #eee;
                  display: flex; align-items: center; gap: 12px; }
  .panel-icon { font-size: 28px; }
  .panel-title { flex: 1; }
  .panel-title h2 { font-size: 16px; font-weight: 700; }
  .panel-title p { font-size: 12px; color: #888; margin-top: 2px; }
  .close-btn { background: #f0f0f0; border: none; border-radius: 50%; width: 30px; height: 30px;
               cursor: pointer; font-size: 16px; display: flex; align-items: center;
               justify-content: center; color: #555; flex-shrink: 0; }
  .close-btn:hover { background: #e0e0e0; }
  .panel-body { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 4px; }

  .panel-state { background: #f8f8f8; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
  .panel-state h3 { font-size: 11px; font-weight: 700; color: #999; text-transform: uppercase;
                    letter-spacing: .5px; margin-bottom: 8px; }
  .panel-state table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .panel-state td { padding: 3px 0; }
  .panel-state .key { color: #555; width: 42%; }
  .panel-state .val { font-family: monospace; color: #0070c9; font-weight: 600; }

  .ctrl-label { display: block; font-size: 11px; font-weight: 700; color: #999;
                text-transform: uppercase; letter-spacing: .5px; margin: 14px 0 8px; }
  .ctrl-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .slider-row input[type=range] { flex: 1; accent-color: #0070c9; }
  .slider-val { font-size: 12px; color: #555; min-width: 38px; text-align: right; }
  input[type=range].hue-slider {
    background: linear-gradient(to right,
      hsl(0,90%,55%), hsl(60,90%,50%), hsl(120,90%,45%),
      hsl(180,90%,45%), hsl(240,90%,55%), hsl(300,90%,55%), hsl(360,90%,55%));
    border-radius: 4px; height: 8px; appearance: none; -webkit-appearance: none;
  }
  .btn-power { padding: 8px 18px; border-radius: 8px; border: none; font-size: 13px;
               font-weight: 600; cursor: pointer; background: #34c759; color: #fff; }
  .btn-power.off { background: #ff3b30; }
  .btn-power:hover { filter: brightness(1.08); }
  .btn-action { padding: 8px 14px; border-radius: 8px; border: 1.5px solid #ddd;
                font-size: 13px; cursor: pointer; background: #fff; color: #1a1a1a;
                display: flex; align-items: center; gap: 6px; }
  .btn-action:hover { background: #f0f0f0; border-color: #bbb; }
  .btn-pill { padding: 6px 12px; border-radius: 20px; border: 1.5px solid #ddd;
              font-size: 12px; cursor: pointer; background: #fff; text-transform: capitalize; }
  .btn-pill:hover { background: #e8f4fd; border-color: #0070c9; color: #0070c9; }
  .btn-pill.active { background: #0070c9; border-color: #0070c9; color: #fff; }

  .dpad { display: grid; width: 144px;
          grid-template-areas: ". up ." "left center right" ". down .";
          grid-template-columns: 44px 44px 44px;
          grid-template-rows: 44px 44px 44px;
          gap: 4px; margin: 4px 0 8px; }
  .dpad-btn { border: 1.5px solid #ddd; background: #fff; border-radius: 8px;
              font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .dpad-btn:hover { background: #f0f0f0; }
  .dpad-btn:active { background: #e0e0e0; }
  .dpad-btn.enter { background: #0070c9; border-color: #0070c9; color: #fff;
                    font-size: 12px; font-weight: 700; border-radius: 50%; }
  .dpad-btn.enter:hover { background: #005fa3; }
  .back-btn { padding: 6px 14px; border-radius: 8px; border: 1.5px solid #ddd;
              font-size: 13px; cursor: pointer; background: #fff; }
  .back-btn:hover { background: #f0f0f0; }

  .kbd { background: #f0f0f0; border: 1px solid #ccc; border-radius: 4px;
         padding: 1px 5px; font-size: 11px; font-family: monospace; color: #555; }

  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px);
           background: #1a1a1a; color: #fff; padding: 8px 16px; border-radius: 20px;
           font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s;
           z-index: 200; white-space: nowrap; max-width: 90vw; overflow: hidden; text-overflow: ellipsis; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  .log-section { padding: 0 24px 28px; }
  .log-section h2 { font-size: 13px; font-weight: 700; color: #555; margin-bottom: 8px;
                    text-transform: uppercase; letter-spacing: .4px; }
  #log { background: #fff; border: 1px solid #ddd; border-radius: 12px;
         height: 220px; overflow-y: auto; padding: 12px; font-family: monospace;
         font-size: 12px; display: flex; flex-direction: column; gap: 3px; }
  .log-entry { display: flex; gap: 10px; line-height: 1.5; }
  .log-ts  { color: #bbb; flex-shrink: 0; }
  .log-cat { font-weight: 700; flex-shrink: 0; min-width: 56px; }
  .log-cat.bulb    { color: #d97c00; }
  .log-cat.fan     { color: #0080c0; }
  .log-cat.tv      { color: #7b5cf0; }
  .log-cat.monitor { color: #28a745; }
  .log-msg { color: #444; }
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <h1>Device Simulator</h1>
  <span class="badge">${devices.length} device${devices.length !== 1 ? "s" : ""}</span>
</header>

<div class="devices">${cards}</div>

<div class="log-section">
  <h2>Signal Log</h2>
  <div id="log"><span style="color:#ccc;font-family:sans-serif">Waiting for signals…</span></div>
</div>

<div class="overlay" id="overlay" onclick="closePanel()"></div>
<div class="panel" id="panel">
  <div class="panel-header">
    <span class="panel-icon" id="panel-icon"></span>
    <div class="panel-title">
      <h2 id="panel-name"></h2>
      <p id="panel-meta"></p>
    </div>
    <button class="close-btn" onclick="closePanel()">✕</button>
  </div>
  <div class="panel-body" id="panel-body"></div>
</div>

<div class="toast" id="toast"></div>

<script>
const DEVICES = ${JSON.stringify(devicesMeta)};
const states  = ${JSON.stringify(Object.fromEntries(stateMap))};
let panelDeviceId = null;

// ── Control renderers ────────────────────────────────────────────────────────
function renderControl(ctrl, port) {
  const t = ctrl.type;

  if (t === "power") {
    return \`<div class="ctrl-row">
      <button class="btn-power"     onclick="send(\${port},'\${ctrl.onPath}',\${JSON.stringify(ctrl.onBody)})">Turn On</button>
      <button class="btn-power off" onclick="send(\${port},'\${ctrl.onPath}',\${JSON.stringify(ctrl.offBody)})">Turn Off</button>
    </div>\`;
  }

  if (t === "slider") {
    const cls = ctrl.style === "hue" ? " hue-slider" : "";
    return \`<label class="ctrl-label">\${ctrl.label}\${ctrl.style === "hue" ? ' <span style="font-size:11px;color:#aaa">(0–359°)</span>' : ''}</label>
    <div class="ctrl-row slider-row">
      <input type="range" min="\${ctrl.min}" max="\${ctrl.max}" value="\${ctrl.min}" class="\${cls.trim()}"
        oninput="this.nextElementSibling.textContent=this.value+'\${ctrl.unit}'"
        onchange="send(\${port},'\${ctrl.path}',{[\'\${ctrl.field}\']: +this.value})">
      <span class="slider-val">\${ctrl.min}\${ctrl.unit}</span>
    </div>\`;
  }

  if (t === "buttons") {
    const btns = ctrl.items.map(item => {
      const hint = item.hint ? \` <span class="kbd">\${item.hint}</span>\` : "";
      return \`<button class="btn-action" onclick="send(\${port},'\${item.path}',\${JSON.stringify(item.body)})">\${item.label}\${hint}</button>\`;
    }).join("");
    return \`<label class="ctrl-label">\${ctrl.label}</label><div class="ctrl-row">\${btns}</div>\`;
  }

  if (t === "pills") {
    const pills = ctrl.options.map(opt =>
      \`<button class="btn-pill" onclick="send(\${port},'\${ctrl.path}',{[\'\${ctrl.field}\']: '\${opt}'})">\${opt}</button>\`
    ).join("");
    return \`<label class="ctrl-label">\${ctrl.label}</label><div class="ctrl-row">\${pills}</div>\`;
  }

  if (t === "dpad") {
    const a = ctrl.actions;
    const btn = (area, label, action, extra="") =>
      \`<button class="dpad-btn \${extra}" style="grid-area:\${area}"
         onclick="send(\${port},'\${ctrl.path}',{[\'\${ctrl.field}\']: '\${action}'})">\${label}</button>\`;
    return \`<label class="ctrl-label">\${ctrl.label}</label>
    <div class="dpad">
      \${btn("up",     "▲", a.up)}
      \${btn("left",   "◀", a.left)}
      \${btn("center", "OK", a.center, "enter")}
      \${btn("right",  "▶", a.right)}
      \${btn("down",   "▼", a.down)}
    </div>
    <div class="ctrl-row">
      <button class="back-btn" onclick="send(\${port},'\${ctrl.path}',{[\'\${ctrl.field}\']: '\${a.back}'})">← Back</button>
    </div>\`;
  }

  return "";
}

function stateRows(id) {
  return Object.entries(states[id] ?? {})
    .map(([k,v]) => \`<tr><td class="key">\${k}</td><td class="val">\${JSON.stringify(v)}</td></tr>\`)
    .join("");
}

function openPanel(id) {
  const d = DEVICES.find(x => x.id === id);
  if (!d) return;
  panelDeviceId = id;

  document.getElementById("panel-icon").textContent = d.icon;
  document.getElementById("panel-name").textContent = d.name;
  document.getElementById("panel-meta").textContent = d.category + " · port " + d.port + " · " + d.id;

  const ctrlHtml = (d.controls ?? []).map(c => renderControl(c, d.port)).join("\\n");
  document.getElementById("panel-body").innerHTML = \`
    <div class="panel-state">
      <h3>Current State</h3>
      <table><tbody id="panel-state-body">\${stateRows(id)}</tbody></table>
    </div>
    \${ctrlHtml}\`;

  document.getElementById("overlay").classList.add("open");
  document.getElementById("panel").classList.add("open");
}

function closePanel() {
  panelDeviceId = null;
  document.getElementById("overlay").classList.remove("open");
  document.getElementById("panel").classList.remove("open");
}

document.addEventListener("keydown", e => { if (e.key === "Escape") closePanel(); });

async function send(port, path, body) {
  try {
    const res = await fetch(\`http://localhost:\${port}\${path}\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    showToast("✓ " + path + " → " + JSON.stringify(data));
  } catch(e) {
    showToast("✗ " + e.message, true);
  }
}

let toastTimer;
function showToast(msg, err=false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.background = err ? "#ff3b30" : "#1a1a1a";
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ── SSE updates ──────────────────────────────────────────────────────────────
const es = new EventSource("/events");

es.addEventListener("state", e => {
  const { id, state } = JSON.parse(e.data);
  states[id] = state;

  const table = document.getElementById("state-" + id);
  const card  = document.getElementById("card-"  + id);
  if (table) {
    table.innerHTML = Object.entries(state)
      .map(([k,v]) => \`<tr><td class="key">\${k}</td><td class="val">\${JSON.stringify(v)}</td></tr>\`)
      .join("");
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
  }

  if (panelDeviceId === id) {
    const pb = document.getElementById("panel-state-body");
    if (pb) pb.innerHTML = stateRows(id);
  }
});

es.addEventListener("log", e => {
  const { ts, category, msg } = JSON.parse(e.data);
  const log = document.getElementById("log");
  const empty = log.querySelector("span");
  if (empty) empty.remove();
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = \`<span class="log-ts">\${ts.slice(11,19)}</span><span class="log-cat \${category}">\${category}</span><span class="log-msg">\${msg}</span>\`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
  if (log.children.length > 200) log.firstChild.remove();
});
</script>
</body>
</html>`;
}

export function startDashboard(devices: SimDevice[], stateMap: Map<string, Record<string, unknown>>) {
  const sseClients = new Set<ReadableStreamDefaultController>();
  const encoder = new TextEncoder();

  subscribe((data) => {
    for (const ctrl of sseClients) {
      try {
        const parsed = JSON.parse(data) as { event: string; payload: unknown };
        ctrl.enqueue(encoder.encode(`event: ${parsed.event}\ndata: ${JSON.stringify(parsed.payload)}\n\n`));
      } catch {
        sseClients.delete(ctrl);
      }
    }
  });

  Bun.serve({
    port: DASHBOARD_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/events") {
        let ctrl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctrl = c;
            sseClients.add(ctrl);
            for (const d of devices) {
              const state = stateMap.get(d.id) ?? {};
              ctrl.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify({ id: d.id, state })}\n\n`));
            }
          },
          cancel() { sseClients.delete(ctrl); },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }

      return new Response(html(devices, stateMap), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  console.log(`Dashboard → http://localhost:${DASHBOARD_PORT}`);
}
