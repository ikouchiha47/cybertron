#include "WebPortal.h"
#include "OtaAuth.h"
#include "Config.h"
#include "WatchFaces.h"
#include "Timezones.h"
#include <Preferences.h>
#include <ESPAsyncWebServer.h>
#include <ESPmDNS.h>
#include <Update.h>
#include <mbedtls/sha256.h>

static AsyncWebServer server(80);
static Preferences prefs;

String currentTz = DEFAULT_TZ;
String currentTzLabel = DEFAULT_TZ_LABEL;
String currentTz2 = DEFAULT_TZ2;
String currentTz2Label = DEFAULT_TZ2_LABEL;
String currentFaceId = DEFAULT_FACE_ID;
volatile bool settingsDirty = false;

// Encodes each <option> value as "posix|SHORTLABEL" so a single form field
// carries both the POSIX TZ string and the on-device display label.
// `data-iana` lets client-side JS auto-select the browser's own timezone.
static void appendTzSelect(String &html, const char* fieldName, const String &selectedPosix) {
  html += "<select name='";
  html += fieldName;
  html += "' id='";
  html += fieldName;
  html += "'>";
  for (size_t i = 0; i < kTzOptionCount; i++) {
    html += "<option value='";
    html += kTzOptions[i].posix;
    html += "|";
    html += kTzOptions[i].shortLabel;
    html += "' data-iana='";
    html += kTzOptions[i].iana;
    html += "'";
    if (selectedPosix == kTzOptions[i].posix) html += " selected";
    html += ">";
    html += kTzOptions[i].menuLabel;
    html += "</option>";
  }
  html += "</select>";
}

static String buildIndexHtml() {
  String html;
  html.reserve(3500);
  html += "<!doctype html><html><head><meta charset='utf-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>Clocky Settings</title><style>";
  html += "body{font-family:system-ui,sans-serif;max-width:420px;margin:2rem auto;padding:0 1rem;background:#111;color:#eee}";
  html += "h1{font-size:1.3rem} select,button{width:100%;padding:.6rem;margin:.4rem 0;font-size:1rem;border-radius:6px;border:1px solid #444;background:#222;color:#eee}";
  html += "button{background:#2a7;color:#111;font-weight:bold;border:none;cursor:pointer}";
  html += "label{display:block;margin-top:1rem;font-size:.9rem;opacity:.8}";
  html += "</style></head><body>";
  html += "<h1>Clocky</h1>";
  html += "<form method='POST' action='/save'>";

  html += "<label>Local timezone</label>";
  appendTzSelect(html, "tz", currentTz);
  html += "<div id='tzDetectNote' style='font-size:.8rem;opacity:.6;margin-top:-.2rem'></div>";

  html += "<label>World timezone (shown on dual-time face)</label>";
  appendTzSelect(html, "tz2", currentTz2);

  html += "<label>Watch face</label><select name='face'>";
  for (size_t i = 0; i < kWatchFaceCount; i++) {
    html += "<option value='";
    html += kWatchFaces[i].id;
    html += "'";
    if (currentFaceId == kWatchFaces[i].id) html += " selected";
    html += ">";
    html += kWatchFaces[i].name;
    html += "</option>";
  }
  html += "</select>";

  html += "<button type='submit'>Save</button>";
  html += "</form>";
  html += "<p style='margin-top:1.5rem;text-align:center;font-size:.9rem'><a href='/update' style='color:#2a7'>Firmware update</a></p>";

  // Auto-detect the browser's own timezone (Intl API, no external network
  // call) and pre-select the matching option in the "Local timezone" list.
  // Runs entirely client-side; the ESP32 never sees anything until Save.
  html += "<script>";
  html += "(function(){";
  html += "try{";
  html += "var detected=Intl.DateTimeFormat().resolvedOptions().timeZone;";
  // Some browsers/OSes still report pre-2011 IANA link names instead of the
  // current canonical name (observed: Asia/Calcutta instead of Asia/Kolkata).
  // Normalize the common ones before matching.
  html += "var legacyAliases={";
  html += "'Asia/Calcutta':'Asia/Kolkata',";
  html += "'Asia/Katmandu':'Asia/Kathmandu',";
  html += "'Asia/Dacca':'Asia/Dhaka',";
  html += "'Asia/Rangoon':'Asia/Yangon',";
  html += "'Asia/Saigon':'Asia/Bangkok',";
  html += "'Europe/Kiev':'Europe/Athens'";
  html += "};";
  html += "var normalized=legacyAliases[detected]||detected;";
  html += "var sel=document.getElementById('tz');";
  html += "var note=document.getElementById('tzDetectNote');";
  html += "var opts=sel.options;";
  html += "var matched=false;";
  html += "for(var i=0;i<opts.length;i++){";
  html += "if(opts[i].getAttribute('data-iana')===normalized){opts[i].selected=true;matched=true;break;}";
  html += "}";
  html += "note.textContent=matched?('Auto-detected: '+detected):('Browser reports \\''+detected+'\\' — not in list, please pick manually');";
  html += "}catch(e){}";
  html += "})();";
  html += "</script>";

  html += "</body></html>";
  return html;
}

// Splits an "posix|SHORTLABEL" form value into its two parts.
static void splitTzValue(const String &value, String &posixOut, String &labelOut) {
  int sep = value.indexOf('|');
  if (sep < 0) {
    posixOut = value;
    labelOut = "";
    return;
  }
  posixOut = value.substring(0, sep);
  labelOut = value.substring(sep + 1);
}

static void handleSave(AsyncWebServerRequest *request) {
  if (request->hasParam("tz", true)) {
    String posix, label;
    splitTzValue(request->getParam("tz", true)->value(), posix, label);
    currentTz = posix;
    currentTzLabel = label;
    prefs.putString(KEY_TZ, currentTz);
    prefs.putString(KEY_TZ_LABEL, currentTzLabel);
  }
  if (request->hasParam("tz2", true)) {
    String posix, label;
    splitTzValue(request->getParam("tz2", true)->value(), posix, label);
    currentTz2 = posix;
    currentTz2Label = label;
    prefs.putString(KEY_TZ2, currentTz2);
    prefs.putString(KEY_TZ2_LABEL, currentTz2Label);
  }
  if (request->hasParam("face", true)) {
    currentFaceId = request->getParam("face", true)->value();
    prefs.putString(KEY_FACE, currentFaceId);
  }
  settingsDirty = true;
  request->redirect("/");
}

static String buildUpdateHtml() {
  String html;
  html.reserve(3000);
  html += "<!doctype html><html><head><meta charset='utf-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>Clocky Update</title><style>";
  html += "body{font-family:system-ui,sans-serif;max-width:420px;margin:2rem auto;padding:0 1rem;background:#111;color:#eee}";
  html += "h1{font-size:1.3rem}";
  html += "label{display:block;margin-top:1rem;font-size:.9rem;opacity:.8}";
  html += "input[type=file]{width:100%;margin:.4rem 0;color:#eee}";
  html += "button{width:100%;padding:.6rem;margin-top:1.2rem;font-size:1rem;border-radius:6px;border:none;background:#2a7;color:#111;font-weight:bold;cursor:pointer}";
  html += "button:disabled{opacity:.4;cursor:default}";
  html += "#status{margin-top:1rem;font-size:.9rem;min-height:1.2em}";
  html += ".err{color:#f66} .ok{color:#2a7}";
  html += "</style></head><body>";
  html += "<h1>Firmware Update</h1>";
  html += "<label>Firmware (.bin)</label>";
  html += "<input type='file' id='bin' accept='.bin'>";
  html += "<label>Private key (.pem)</label>";
  html += "<input type='file' id='key' accept='.pem'>";
  html += "<button id='btn' disabled>Sign &amp; Flash</button>";
  html += "<div id='status'></div>";
  html += "<script>";
  // Enable button only when both files selected
  html += "var binFile,keyFile;";
  html += "function check(){document.getElementById('btn').disabled=!(binFile&&keyFile);}";
  html += "document.getElementById('bin').onchange=function(e){binFile=e.target.files[0];check();};";
  html += "document.getElementById('key').onchange=function(e){keyFile=e.target.files[0];check();};";
  html += "function status(msg,cls){var d=document.getElementById('status');d.textContent=msg;d.className=cls||'';}";
  // Main signing + upload
  html += "document.getElementById('btn').onclick=async function(){";
  html += "try{";
  html += "status('Reading files…');";
  html += "var binBuf=await binFile.arrayBuffer();";
  html += "var keyText=await keyFile.text();";
  // Import private key (PKCS#8 PEM)
  html += "var b64=keyText.replace(/-----[^-]+-----/g,'').replace(/\\s/g,'');";
  html += "var der=Uint8Array.from(atob(b64),function(c){return c.charCodeAt(0);});";
  html += "var privKey=await crypto.subtle.importKey('pkcs8',der,{name:'RSA-PSS',hash:'SHA-256'},false,['sign']);";
  // Sign the firmware
  html += "status('Signing…');";
  html += "var sig=await crypto.subtle.sign({name:'RSA-PSS',saltLength:32},privKey,binBuf);";
  html += "var sigB64=btoa(String.fromCharCode.apply(null,new Uint8Array(sig)));";
  // Upload
  html += "status('Uploading…');";
  html += "var fd=new FormData();";
  html += "fd.append('firmware',binFile,'firmware.bin');";
  html += "var resp=await fetch('/update',{method:'POST',headers:{'X-Signature':sigB64},body:fd});";
  html += "var txt=await resp.text();";
  html += "if(resp.ok){status('Done — device rebooting.','ok');}";
  html += "else{status('Failed: '+txt,'err');}";
  html += "}catch(e){status('Error: '+e.message,'err');}";
  html += "};";
  html += "</script></body></html>";
  return html;
}

void webPortalBegin() {
  prefs.begin(PREF_NAMESPACE, false);
  currentTz = prefs.getString(KEY_TZ, DEFAULT_TZ);
  currentTzLabel = prefs.getString(KEY_TZ_LABEL, DEFAULT_TZ_LABEL);
  currentTz2 = prefs.getString(KEY_TZ2, DEFAULT_TZ2);
  currentTz2Label = prefs.getString(KEY_TZ2_LABEL, DEFAULT_TZ2_LABEL);
  currentFaceId = prefs.getString(KEY_FACE, DEFAULT_FACE_ID);

  server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send(200, "text/html", buildIndexHtml());
  });
  server.on("/save", HTTP_POST, handleSave);

  server.on("/update", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send(200, "text/html", buildUpdateHtml());
  });
  server.on("/update", HTTP_POST,
    [](AsyncWebServerRequest *request) {
      bool ok = !Update.hasError();
      AsyncWebServerResponse *r = request->beginResponse(
        ok ? 200 : 403, "text/plain",
        ok ? "OK — rebooting…" : "Signature verification failed");
      r->addHeader("Connection", "close");
      request->send(r);
      if (ok) ESP.restart();
    },
    [](AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final) {
      static mbedtls_sha256_context shaCtx;
      if (index == 0) {
        Update.begin(UPDATE_SIZE_UNKNOWN);
        mbedtls_sha256_init(&shaCtx);
        mbedtls_sha256_starts(&shaCtx, 0);
      }
      mbedtls_sha256_update(&shaCtx, data, len);
      Update.write(data, len);
      if (final) {
        uint8_t hash[32];
        mbedtls_sha256_finish(&shaCtx, hash);
        mbedtls_sha256_free(&shaCtx);

        AsyncWebHeader* sigHeader = request->getHeader("X-Signature");
        bool valid = sigHeader && otaAuthVerify(hash, sigHeader->value().c_str());
        if (valid) {
          Update.end(true);
        } else {
          Update.abort();
          Serial.println("[OTA] Rejected: invalid signature.");
        }
      }
    }
  );

  server.begin();

  if (MDNS.begin(MDNS_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.printf("[BOOT] mDNS started: http://%s.local\n", MDNS_HOSTNAME);
  } else {
    Serial.println("[ERROR] mDNS responder failed to start.");
  }
}

void webPortalLoop() {
  // ESPAsyncWebServer runs in the background; nothing to do here.
}

void persistFaceSelection() {
  prefs.putString(KEY_FACE, currentFaceId);
}
