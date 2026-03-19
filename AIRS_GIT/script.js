/* ============================================================
   AIRS — script.js
   Air Intelligent Response System
   Hardware: ESP32 via Web Serial API (Chrome / Edge only)

   Serial commands sent to ESP32:  "safe" | "mild" | "danger"
   Serial format from ESP32:
     JSON preferred: { "mq135":400, "mq2":300, "temp":25.0, "hum":55,
"flame":false, "risk":0 } Fallback text:  "MQ135: 400  MQ2: 300  Temp: 25.0
Humidity: 55  Flame: NO"

   Power constants mirror Arduino sketch (V=5.0 V):
     I_IDLE   = 0.18 A  (green LED only)
     I_WARN   = 0.38 A  (servo @ 40° + yellow LED)
     I_DANGER = 0.83 A  (servo @ 90° + buzzer + red LED + relay)
============================================================ */

/* ── Hardware & thresholds ────────────────────────────────
   ADC range: 0–4095 (12-bit ESP32 ADC)
   MQ_WARN   : ADC value above which the system enters WARNING state
   MQ_DANGER : ADC value above which the system enters DANGER state
   Both can be overridden at runtime from the Settings panel.
──────────────────────────────────────────────────────── */
const CFG = {
  BAUD: 115200,
  MAX_HISTORY: 300,  // data points kept per sensor channel
  MAX_LOG: 120,      // serial log lines retained in DOM
  VOLTAGE: 5.0,
  I_IDLE: 0.18,
  I_WARN: 0.38,
  I_DANGER: 0.83,
};

const THRESHOLDS = {
  warn: 800,
  danger: 1200
};
let maxHistory = CFG.MAX_HISTORY;

/* ── Historical data buffers ──────────────────────────── */
const hist = {
  mq135: [],
  mq2: [],
  mq5sim: [],
  temp: [],
  hum: []
};

/* ── Serial state ─────────────────────────────────────── */
const serial = {
  port: null,
  reader: null,
  keepReading: false,
  connected: false
};

/* ── Chart state ──────────────────────────────────────── */
let chart = null;
let activeKey = null;
let chartLive = true;
let chartWindowMin = 10;

/* ── Control state ────────────────────────────────────── */
let autoMode = true;

/* ── Last-known readings (for AQI when only partial updates arrive) */
let lastReading = {mq135: 0, mq2: 0, mq5sim: 0, temp: 0, hum: 0};

/* ── Chart display metadata ───────────────────────────── */
const CLRS = {
  mq135: '#00d2ff',
  mq2: '#ff9100',
  mq5sim: '#69ff47',
  temp: '#ff6e40',
  hum: '#40c4ff',
};
const LBLS = {
  mq135: 'Air Quality (MQ135)',
  mq2: 'Smoke / LPG (MQ2)',
  mq5sim: 'Natural Gas — Sim (MQ5)',
  temp: 'Temperature (°C)',
  hum: 'Humidity (%)',
};
const GAS_KEYS = new Set(['mq135', 'mq2', 'mq5sim']);

/* ============================================================
   TOAST HELPER
============================================================ */
let toastTimer = null;
function showToast(msg, type = 'info', duration = 4000) {
  const t = document.getElementById('toast');
  const ti = document.getElementById('toast-icon');
  const tm = document.getElementById('toast-msg');
  const icons = {
    success: 'fa-circle-check',
    error: 'fa-circle-xmark',
    info: 'fa-circle-info',
    warn: 'fa-triangle-exclamation',
  };
  t.className = `toast ${type}`;
  ti.className = `fas ${icons[type] || 'fa-circle-info'}`;
  tm.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

/* ============================================================
   EMAIL NOTIFICATION  (EmailJS — no backend required)

   Keys are entered by the user in Settings and stored in
   localStorage.  Nothing is hard-coded here.
   See .env.example for the variable names used if you adapt
   this to a Node/server environment.
============================================================ */
const EMAIL = {
  pubKey: '',
  serviceId: '',
  templateId: '',
  recipient: '',
  notifyWarn: true,
  notifyDanger: true,
  notifyAutoDanger: true,
  ready: false,
  lastAlertType: null,
  lastAlertTime: 0,
  COOLDOWN_MS: 60_000,  // minimum 60 s between same-type emails
};

function emailSave() {
  EMAIL.pubKey = document.getElementById('ejs-pubkey').value.trim();
  EMAIL.serviceId = document.getElementById('ejs-service').value.trim();
  EMAIL.templateId = document.getElementById('ejs-template').value.trim();
  EMAIL.recipient = document.getElementById('ejs-recipient').value.trim();
  EMAIL.notifyWarn = document.getElementById('notify-warn').checked;
  EMAIL.notifyDanger = document.getElementById('notify-danger').checked;
  EMAIL.notifyAutoDanger =
      document.getElementById('notify-auto-danger').checked;

  if (!EMAIL.pubKey || !EMAIL.serviceId || !EMAIL.templateId ||
      !EMAIL.recipient) {
    showToast(
        'Fill in all 4 EmailJS fields to activate notifications.', 'warn');
    return;
  }
  try {
    emailjs.init({publicKey: EMAIL.pubKey});
    EMAIL.ready = true;
    const badge = document.getElementById('email-badge');
    badge.classList.add('configured');
    badge.innerHTML = `<span class="dot"></span> ${EMAIL.recipient}`;
    showToast('Email notifications activated!', 'success');
    log(`✉ Email notifications active → ${EMAIL.recipient}`, 'info');
    localStorage.setItem('airs-email', JSON.stringify({
      pubKey: EMAIL.pubKey,
      serviceId: EMAIL.serviceId,
      templateId: EMAIL.templateId,
      recipient: EMAIL.recipient,
      notifyWarn: EMAIL.notifyWarn,
      notifyDanger: EMAIL.notifyDanger,
      notifyAutoDanger: EMAIL.notifyAutoDanger,
    }));
  } catch (e) {
    showToast('EmailJS init failed: ' + e.message, 'error');
  }
}

function emailLoad() {
  const saved = localStorage.getItem('airs-email');
  if (!saved) return;
  try {
    const s = JSON.parse(saved);
    EMAIL.pubKey = s.pubKey || '';
    EMAIL.serviceId = s.serviceId || '';
    EMAIL.templateId = s.templateId || '';
    EMAIL.recipient = s.recipient || '';
    EMAIL.notifyWarn = s.notifyWarn !== false;
    EMAIL.notifyDanger = s.notifyDanger !== false;
    EMAIL.notifyAutoDanger = s.notifyAutoDanger !== false;

    document.getElementById('ejs-pubkey').value = EMAIL.pubKey;
    document.getElementById('ejs-service').value = EMAIL.serviceId;
    document.getElementById('ejs-template').value = EMAIL.templateId;
    document.getElementById('ejs-recipient').value = EMAIL.recipient;
    document.getElementById('notify-warn').checked = EMAIL.notifyWarn;
    document.getElementById('notify-danger').checked = EMAIL.notifyDanger;
    document.getElementById('notify-auto-danger').checked =
        EMAIL.notifyAutoDanger;

    if (EMAIL.pubKey && EMAIL.serviceId && EMAIL.templateId &&
        EMAIL.recipient) {
      emailjs.init({publicKey: EMAIL.pubKey});
      EMAIL.ready = true;
      const badge = document.getElementById('email-badge');
      badge.classList.add('configured');
      badge.innerHTML = `<span class="dot"></span> ${EMAIL.recipient}`;
    }
  } catch (e) {
    console.warn('Could not restore email config:', e);
  }
}

async function sendEmail(alertType, isForced = false) {
  if (!EMAIL.ready) return;
  if (alertType === 'WARNING' && !EMAIL.notifyWarn) return;
  if (alertType === 'DANGER' && isForced && !EMAIL.notifyDanger) return;
  if (alertType === 'DANGER' && !isForced && !EMAIL.notifyAutoDanger) return;

  const now = Date.now();
  if (EMAIL.lastAlertType === alertType &&
      (now - EMAIL.lastAlertTime) < EMAIL.COOLDOWN_MS) {
    log(`✉ Email skipped (cooldown — last sent ${
            Math.round((now - EMAIL.lastAlertTime) / 1000)}s ago)`,
        'info');
    return;
  }
  EMAIL.lastAlertType = alertType;
  EMAIL.lastAlertTime = now;

  const params = {
    alert_type: alertType,
    mq135: lastReading.mq135,
    mq2: lastReading.mq2,
    temperature:
        lastReading.temp !== null ? lastReading.temp.toFixed(1) + '°C' : '--',
    humidity: lastReading.hum !== null ? lastReading.hum.toFixed(0) + '%' :
                                         '--',
    timestamp: new Date().toLocaleString(),
    to_email: EMAIL.recipient,
    forced: isForced ? 'Manual override from dashboard' :
                       'Auto-detected by sensors',
  };

  log(`✉ Sending "${alertType}" email to ${EMAIL.recipient}…`, 'info');
  showToast('Sending alert email…', 'info', 3000);
  try {
    await emailjs.send(EMAIL.serviceId, EMAIL.templateId, params);
    log(`✉ Email sent successfully (${alertType})`, 'safe');
    showToast(`Alert email sent to ${EMAIL.recipient}`, 'success');
  } catch (e) {
    log(`✉ Email failed: ${e.text || e.message}`, 'danger');
    showToast('Email send failed: ' + (e.text || e.message), 'error', 6000);
  }
}

/* ============================================================
   INTRO ANIMATION
============================================================ */
(function intro() {
  const layer = document.getElementById('intro-layer');
  const cont = document.getElementById('intro-content');
  const anim = document.getElementById('intro-text-anim');
  const dash = document.getElementById('app-dashboard');
  const logo = document.getElementById('header-text-logo');

  setTimeout(() => cont.classList.add('animate-in'), 50);
  setTimeout(() => {
    cont.style.opacity = '0';
  }, 1200);
  setTimeout(() => {
    cont.style.display = 'none';
    anim.style.display = 'flex';
    setTimeout(() => {
      anim.style.opacity = '1';
    }, 50);
  }, 1700);
  setTimeout(() => anim.classList.add('collapsed'), 3000);
  setTimeout(() => {
    dash.classList.add('visible');
    layer.style.backgroundColor = 'transparent';
    const s = anim.getBoundingClientRect();
    const t = logo.getBoundingClientRect();
    anim.style.cssText += `;position:fixed;left:${s.left}px;top:${
        s.top}px;margin:0;transform:none;`;
    void anim.offsetWidth;
    anim.classList.add('flying');
    anim.style.left = t.left + 'px';
    anim.style.top = t.top + 'px';
    anim.style.fontSize = '1.65rem';
    setTimeout(() => {
      logo.style.opacity = '1';
      layer.style.opacity = '0';
      setTimeout(() => layer.remove(), 500);
    }, 1000);
  }, 4000);
})();

/* ============================================================
   WEB SERIAL  (Chrome / Edge only)
============================================================ */
async function connectSerial() {
  if (!('serial' in navigator)) {
    log('⚠ Web Serial not supported — use Chrome or Edge', 'warn');
    alert(
        'Web Serial API not supported.\nUse Google Chrome or Microsoft Edge.');
    return;
  }
  try {
    serial.port = await navigator.serial.requestPort();
    await serial.port.open({baudRate: CFG.BAUD});
    serial.connected = serial.keepReading = true;
    onConnChange(true);
    log(`✔ Connected at ${CFG.BAUD} baud`, 'info');
    readLoop();
  } catch (e) {
    log(`✘ ${e.message}`, 'danger');
  }
}

async function disconnectSerial() {
  serial.keepReading = false;
  try {
    if (serial.reader) {
      await serial.reader.cancel();
      serial.reader = null;
    }
    if (serial.port) {
      await serial.port.close();
      serial.port = null;
    }
  } catch (_) {
  }
  serial.connected = false;
  onConnChange(false);
  log('Port disconnected', 'warn');
}

async function readLoop() {
  const dec = new TextDecoder();
  let buf = '';
  while (serial.port?.readable && serial.keepReading) {
    serial.reader = serial.port.readable.getReader();
    try {
      while (true) {
        const {value, done} = await serial.reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          const t = l.trim();
          if (t) parseLine(t);
        }
      }
    } catch (e) {
      if (serial.keepReading) log(`Read error: ${e.message}`, 'danger');
    } finally {
      serial.reader.releaseLock();
    }
  }
}

/* Parses a line from the ESP32.
   Preferred format: JSON  { "mq135":400, "mq2":300, "temp":25.0, "hum":55,
   "flame":false, "risk":0 } Fallback:         key:value text  "MQ135: 400  MQ2:
   300  Temp: 25.0  Humidity: 55  Flame: NO"
*/
function parseLine(line) {
  if (line.startsWith('{')) {
    try {
      const d = JSON.parse(line);
      log(line, riskCls(d.risk));
      ingest(d);
      return;
    } catch (_) {
    }
  }
  log(line, '');
  const d = {};
  const r135 = line.match(/MQ135:\s*(\d+)/i);
  const r2 = line.match(/MQ2:\s*(\d+)/i);
  const rT = line.match(/Temp:\s*([\d.]+)/i);
  const rH = line.match(/Hum(?:idity)?:\s*([\d.]+)/i);
  const rF = line.match(/Flame:\s*(\w+)/i);

  if (r135) d.mq135 = parseInt(r135[1]);
  if (r2) d.mq2 = parseInt(r2[1]);
  if (rT) d.temp = parseFloat(rT[1]);
  if (rH) d.hum = parseFloat(rH[1]);
  if (rF) d.flame = rF[1].toUpperCase() === 'YES';

  if (Object.keys(d).length > 0) {
    const v135 = d.mq135 || 0;
    const v2 = d.mq2 || 0;
    const flameYes = rF && rF[1].toUpperCase() === 'YES';

    if (autoMode) {
      if (flameYes || v135 > MQ_DANGER || v2 > MQ_DANGER) {
        d.risk = 2;
      } else if (v135 > MQ_WARN || v2 > MQ_WARN) {
        d.risk = 1;
      } else {
        d.risk = 0;
      }
    }

    d.current = d.risk === 2 ? CFG.I_DANGER :
        d.risk === 1         ? CFG.I_WARN :
                               CFG.I_IDLE;
    d.power = +(CFG.VOLTAGE * d.current).toFixed(2);
    ingest(d);
  }
}

async function sendCmd(cmd) {
  if (!serial.connected || !serial.port?.writable) {
    log('⚠ Not connected — connect ESP32 first', 'warn');
    return;
  }
  const w = serial.port.writable.getWriter();
  try {
    await w.write(new TextEncoder().encode(cmd + '\n'));
    log(`→ Sent: "${cmd}"`, 'info');
  } catch (e) {
    log(`Send error: ${e.message}`, 'danger');
  } finally {
    w.releaseLock();
  }
}

if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', () => {
    if (serial.connected) {
      serial.connected = false;
      onConnChange(false);
      log('Device disconnected', 'warn');
    }
  });
}

/* ============================================================
   DATA INGESTION
   Called for every new reading (real serial or test injection).
============================================================ */
function ingest(d) {
  const now = new Date();

  function upd(id, v, dec) {
    if (v == null) return;
    const e = document.getElementById(id);
    if (e) e.textContent = dec != null ? v.toFixed(dec) : v;
  }
  function push(k, v) {
    if (v == null) return;
    hist[k].push({x: now, y: v});
    while (hist[k].length > maxHistory) hist[k].shift();
  }

  upd('val-act-mq135', d.mq135);
  push('mq135', d.mq135);
  upd('val-act-mq2', d.mq2);
  push('mq2', d.mq2);
  upd('val-act-temp', d.temp, 1);
  push('temp', d.temp);
  upd('val-act-hum', d.hum, 1);
  push('hum', d.hum);

  /* Simulated MQ5 — no dedicated hardware sensor.
     Derived as the mean of MQ135 and MQ2, giving a rough proxy
     for natural-gas / LPG that includes both broad-spectrum (MQ135)
     and combustible-gas (MQ2) signal. */
  const v135sim = d.mq135 ?? lastReading.mq135 ?? 0;
  const v2sim = d.mq2 ?? lastReading.mq2 ?? 0;
  if (d.mq135 != null || d.mq2 != null) {
    d.mq5sim = Math.round((v135sim + v2sim) / 2);
    upd('val-act-mq5sim', d.mq5sim);
    push('mq5sim', d.mq5sim);
    lastReading.mq5sim = d.mq5sim;
  }

  if (d.mq135 != null) lastReading.mq135 = d.mq135;
  if (d.mq2 != null) lastReading.mq2 = d.mq2;
  if (d.temp != null) lastReading.temp = d.temp;
  if (d.hum != null) lastReading.hum = d.hum;
  if (d.flame != null) lastReading.flame = d.flame;

  const ts = now.toLocaleTimeString();
  const tsEl = document.getElementById('val-timestamp');
  if (tsEl) tsEl.textContent = ts;

  if (d.current != null) upd('val-current', d.current, 2);
  if (d.power != null) upd('val-power', d.power, 2);

  if (d.risk != null && autoMode) {
    setSystemState(d.risk);
    if (d.risk === 2) sendEmail('DANGER', false);
  }

  updateGlance(d);
  if (d.mq135 != null || d.mq2 != null) updateAQI(d);
  if (chart && activeKey) chart.update();
}

/* ============================================================
   QUICK GLANCE UPDATER
============================================================ */
function updateGlance(d) {
  const ts = document.getElementById('glance-ts');
  if (ts) ts.textContent = new Date().toLocaleTimeString();

  function setGlanceCard(gcId, gvId, val) {
    const gc = document.getElementById(gcId);
    const gv = document.getElementById(gvId);
    if (!gc || !gv || val == null) return;
    gv.textContent = typeof val === 'number' && !Number.isInteger(val) ?
        val.toFixed(1) :
        val;
    if (['gc-mq135', 'gc-mq2', 'gc-mq5sim'].includes(gcId)) {
      gc.classList.remove('state-safe', 'state-warn', 'state-danger');
      if (val > MQ_DANGER)
        gc.classList.add('state-danger');
      else if (val > MQ_WARN)
        gc.classList.add('state-warn');
      else
        gc.classList.add('state-safe');
    }
  }

  setGlanceCard('gc-mq135', 'gv-mq135', d.mq135);
  setGlanceCard('gc-mq2', 'gv-mq2', d.mq2);
  setGlanceCard('gc-mq5sim', 'gv-mq5sim', d.mq5sim);
  setGlanceCard('gc-temp', 'gv-temp', d.temp);
  setGlanceCard('gc-hum', 'gv-hum', d.hum);

  const flameEl = document.getElementById('gv-flame');
  if (flameEl && d.flame !== undefined) {
    if (d.flame) {
      flameEl.className = 'glance-card-flame-yes';
      flameEl.textContent = 'YES!';
    } else {
      flameEl.className = 'glance-card-flame-no';
      flameEl.textContent = 'NO';
    }
  }
}

/* ============================================================
   AQI CALCULATOR
   ─────────────────────────────────────────────────────────────
   Formula:
     S_x  = max(0, (V_x − B) / B)          normalised deviation
     AQI  = 100 × (0.5·S₁₃₅ + 0.3·S₂ + 0.2·S₅)

   Sensor weights:
     MQ135  50% — broadest gas coverage (CO, NH₃, benzene, smoke)
     MQ2    30% — LPG / butane / smoke; most relevant for kitchen leaks
     MQ5    20% — simulated (no hardware); fills in natural-gas signal

   Baseline (B):
     Set to MQ_WARN (default 800 ADC).  Values below baseline produce
     S=0 (clean air); values above it scale proportionally.
     This means AQI > 0 only when at least one sensor reads above the
     warning threshold, avoiding false positives during normal operation.

   MQ5 simulation:
     V₅ = (MQ135 + MQ2) / 2   — average of the two real sensors.
     This is a rough proxy; replace with real MQ5 data if hardware is added.
   ─────────────────────────────────────────────────────────────
   AQI scale (mirrors US EPA breakpoints, adapted for raw ADC domain):
     0–50    Good
     51–100  Moderate
     101–150 Unhealthy for Sensitive Groups
     151–200 Unhealthy
     201–300 Very Unhealthy
     300+    Hazardous
============================================================ */
function updateAQI(d) {
  const B = MQ_WARN;  // baseline = warning threshold

  const v135 = d.mq135 ?? lastReading.mq135 ?? 0;
  const v2 = d.mq2 ?? lastReading.mq2 ?? 0;
  const v5 = d.mq5sim ?? lastReading.mq5sim ?? Math.round((v135 + v2) / 2);

  const s135 = Math.max(0, (v135 - B) / B);
  const s2 = Math.max(0, (v2 - B) / B);
  const s5 = Math.max(0, (v5 - B) / B);

  const aqi = Math.round(100 * (0.5 * s135 + 0.3 * s2 + 0.2 * s5));

  const set = (id, v) => {
    const e = document.getElementById(id);
    if (e) e.textContent = v;
  };
  set('aqi-r135', v135);
  set('aqi-b135', B);
  set('aqi-r2', v2);
  set('aqi-b2', B);
  set('aqi-r5', v5);
  set('aqi-b5', B);
  set('aqi-s135', 'S=' + s135.toFixed(3));
  set('aqi-s2', 'S=' + s2.toFixed(3));
  set('aqi-s5', 'S=' + s5.toFixed(3));
  set('aqi-total', aqi);
  set('aqi-number', aqi);

  let cat, arcColor, catCls;
  if (aqi <= 50) {
    cat = 'Good';
    arcColor = '#00e676';
    catCls = 'aqi-good';
  } else if (aqi <= 100) {
    cat = 'Moderate';
    arcColor = '#ffea00';
    catCls = 'aqi-moderate';
  } else if (aqi <= 150) {
    cat = 'Unhealthy for SG';
    arcColor = '#ff9100';
    catCls = 'aqi-unhealthy-sg';
  } else if (aqi <= 200) {
    cat = 'Unhealthy';
    arcColor = '#ff5252';
    catCls = 'aqi-unhealthy';
  } else if (aqi <= 300) {
    cat = 'Very Unhealthy';
    arcColor = '#ff1744';
    catCls = 'aqi-very-unhealthy';
  } else {
    cat = 'Hazardous';
    arcColor = '#b71c1c';
    catCls = 'aqi-hazardous';
  }

  set('aqi-category', cat);
  const catEl = document.getElementById('aqi-category');
  if (catEl) catEl.className = 'aqi-category ' + catCls;
  const numEl = document.getElementById('aqi-number');
  if (numEl) numEl.style.color = arcColor;
  const totEl = document.getElementById('aqi-total');
  if (totEl) totEl.style.color = arcColor;

  // SVG arc dial (circumference = 502, sweep = 376.5 for 270° arc)
  const arc = document.getElementById('aqi-arc');
  if (arc) {
    const CIRC = 502;
    const SWEEP = 376.5;
    const pct = Math.min(aqi / 400, 1);
    arc.style.strokeDashoffset = CIRC - (SWEEP * pct);
    arc.style.stroke = arcColor;
  }

  // Quick Glance mini card
  const mini = document.getElementById('gv-aqi-mini');
  const miniGc = document.getElementById('gc-aqi-mini');
  if (mini) {
    mini.textContent = aqi;
    mini.style.color = arcColor;
  }
  if (miniGc) {
    miniGc.classList.remove('state-safe', 'state-warn', 'state-danger');
    if (aqi > 150)
      miniGc.classList.add('state-danger');
    else if (aqi > 50)
      miniGc.classList.add('state-warn');
    else
      miniGc.classList.add('state-safe');

    let miniCat = document.getElementById('gc-aqi-cat');
    if (!miniCat) {
      miniCat = document.createElement('div');
      miniCat.id = 'gc-aqi-cat';
      miniCat.style.cssText =
          'font-size:.65rem;margin-top:5px;font-weight:700;font-family:Poppins,sans-serif;letter-spacing:.05em;';
      miniGc.appendChild(miniCat);
    }
    miniCat.textContent = cat;
    miniCat.style.color = arcColor;
  }
}

/* ============================================================
   SYSTEM STATE
   Mirrors the Arduino triggerSafeMode / triggerWarningMode /
   triggerDangerMode functions.  UI-only — actual hardware is
   driven by the ESP32 reacting to the serial commands we send.
============================================================ */
function setSystemState(risk) {
  ['led-green', 'led-yellow', 'led-red', 'led-blue'].forEach(
      id => document.getElementById(id).classList.remove('active'));

  const iconBuz = document.getElementById('icon-buzzer');
  iconBuz.classList.remove('ringing');
  iconBuz.style.color = 'var(--text-secondary)';
  document.getElementById('alert-banner').classList.add('hidden');

  switch (risk) {
    case 0:  // SAFE — green LED, servo 0°
      document.getElementById('led-green').classList.add('active');
      setVentAngle(0);
      document.getElementById('stat-servo').textContent = 'CLOSED';
      document.getElementById('stat-servo').style.color = 'var(--color-safe)';
      document.getElementById('stat-servo-angle').textContent = 'Servo: 0°';
      document.getElementById('stat-buzzer').textContent = 'INACTIVE';
      document.getElementById('stat-buzzer').style.color =
          'var(--text-secondary)';
      document.getElementById('val-current').textContent =
          CFG.I_IDLE.toFixed(2);
      document.getElementById('val-power').textContent =
          (CFG.VOLTAGE * CFG.I_IDLE).toFixed(2);
      break;

    case 1:  // WARNING — yellow LED, servo 40°
      document.getElementById('led-yellow').classList.add('active');
      setVentAngle(40);
      document.getElementById('stat-servo').textContent = 'PARTIAL OPEN';
      document.getElementById('stat-servo').style.color = 'var(--color-low)';
      document.getElementById('stat-servo-angle').textContent = 'Servo: 40°';
      document.getElementById('stat-buzzer').textContent = 'INACTIVE';
      document.getElementById('stat-buzzer').style.color =
          'var(--text-secondary)';
      document.getElementById('val-current').textContent =
          CFG.I_WARN.toFixed(2);
      document.getElementById('val-power').textContent =
          (CFG.VOLTAGE * CFG.I_WARN).toFixed(2);
      break;

    case 2:  // DANGER — red LED, servo 90°, buzzer on, relay on
      document.getElementById('led-red').classList.add('active');
      setVentAngle(90);
      document.getElementById('stat-servo').textContent = 'FULLY OPEN';
      document.getElementById('stat-servo').style.color = 'var(--color-unsafe)';
      document.getElementById('stat-servo-angle').textContent = 'Servo: 90°';
      document.getElementById('stat-buzzer').textContent = 'SOUNDING';
      document.getElementById('stat-buzzer').style.color =
          'var(--color-unsafe)';
      iconBuz.classList.add('ringing');
      iconBuz.style.color = 'var(--color-unsafe)';
      document.getElementById('alert-banner').classList.remove('hidden');
      document.getElementById('val-current').textContent =
          CFG.I_DANGER.toFixed(2);
      document.getElementById('val-power').textContent =
          (CFG.VOLTAGE * CFG.I_DANGER).toFixed(2);
      break;

    default:  // WAITING — blue LED, everything off
      document.getElementById('led-blue').classList.add('active');
      setVentAngle(0);
      document.getElementById('stat-servo').textContent = 'CLOSED';
      document.getElementById('stat-servo').style.color =
          'var(--text-secondary)';
      document.getElementById('stat-servo-angle').textContent = 'Servo: 0°';
      document.getElementById('stat-buzzer').textContent = 'INACTIVE';
      document.getElementById('stat-buzzer').style.color =
          'var(--text-secondary)';
      document.getElementById('val-current').textContent =
          CFG.I_IDLE.toFixed(2);
      document.getElementById('val-power').textContent =
          (CFG.VOLTAGE * CFG.I_IDLE).toFixed(2);
      break;
  }
}

/* Maps servo angle → louver CSS class for the SVG vent visual */
function setVentAngle(deg) {
  const louvers = ['louver-tl', 'louver-tr', 'louver-bl', 'louver-br'];
  const cls = deg >= 80 ? 'open' : deg >= 30 ? 'mild' : 'closed';
  louvers.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('closed', 'mild', 'open');
    el.classList.add(cls);
  });
}

/* ============================================================
   SERIAL LOG
============================================================ */
let logN = 0;
function log(text, cls = '') {
  const box = document.getElementById('serial-log');
  const noMsg = document.getElementById('no-serial-msg');
  if (noMsg) noMsg.remove();
  const el = document.createElement('div');
  el.className = `log-line ${cls}`;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  box.appendChild(el);
  if (++logN > CFG.MAX_LOG) {
    box.removeChild(box.firstChild);
    logN--;
  }
  box.scrollTop = box.scrollHeight;
}
function riskCls(r) {
  return r === 2 ? 'danger' : r === 1 ? 'warn' : r === 0 ? 'safe' : '';
}

/* ============================================================
   CONNECTION STATUS UI
============================================================ */
function onConnChange(conn) {
  const pill = document.getElementById('serial-status-pill');
  const txt = document.getElementById('header-active-text');
  const btn = document.getElementById('btn-connect-esp32');
  const sD = document.getElementById('sidebar-dot');
  const sT = document.getElementById('sidebar-conn-text');
  if (conn) {
    pill.classList.add('active');
    txt.textContent = 'Active';
    btn.innerHTML = '<i class="fas fa-link-slash"></i> Disconnect';
    btn.classList.add('connected');
    sD.style.color = 'var(--color-safe)';
    sT.textContent = 'Serial Connected';
  } else {
    pill.classList.remove('active');
    txt.textContent = 'Inactive';
    btn.innerHTML = '<i class="fas fa-plug"></i> Connect ESP32';
    btn.classList.remove('connected');
    sD.style.color = '#444';
    sT.textContent = 'Serial Disconnected';
    setSystemState(-1);
  }
}

/* ============================================================
   CHART  (Chart.js + chartjs-plugin-zoom)
   Per-point colour coding:  green = safe / yellow = warn / red = danger
   Background bands:  coloured regions behind the chart area
   Live cursor:       dashed "NOW" line tracks current time
   Zone labels:       SAFE / WARNING / DANGER printed in band corners
============================================================ */
function buildChart(key) {
  if (chart) {
    if (chart._slideTimer) clearInterval(chart._slideTimer);
    chart.destroy();
    chart = null;
  }
  chartLive = true;

  const ctx = document.getElementById('sensor-chart').getContext('2d');
  const c = CLRS[key] || '#00d2ff';
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const grd = light ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.08)';
  const tck = light ? '#374151' : '#94a3b8';
  const isGas = GAS_KEYS.has(key);

  const grad = ctx.createLinearGradient(0, 0, 0, 420);
  grad.addColorStop(0, c + '55');
  grad.addColorStop(0.55, c + '18');
  grad.addColorStop(1, c + '00');

  const ptColor = ctx2 => {
    if (!isGas) return c;
    const v = ctx2.raw?.y ?? 0;
    return v > MQ_DANGER ? '#ff1744' : v > MQ_WARN ? '#ffea00' : c;
  };
  const ptRadius = ctx2 => {
    if (!isGas) return 2;
    const v = ctx2.raw?.y ?? 0;
    return v > MQ_DANGER ? 8 : v > MQ_WARN ? 6 : 2;
  };

  const datasets = [{
    label: LBLS[key] || key,
    data: hist[key] || [],
    borderColor: c,
    backgroundColor: grad,
    borderWidth: 2.5,
    tension: 0.3,
    fill: true,
    segment: {
      borderColor: ctx2 => {
        if (!isGas) return c;
        const mx = Math.max(ctx2.p0.parsed.y, ctx2.p1.parsed.y);
        return mx > MQ_DANGER ? 'rgba(255,23,68,.95)' :
            mx > MQ_WARN      ? 'rgba(255,234,0,.95)' :
                                c;
      },
    },
    pointBackgroundColor: ptColor,
    pointBorderColor: '#fff',
    pointBorderWidth: 1.5,
    pointRadius: ptRadius,
    pointHoverRadius: ctx2 => (ptRadius(ctx2) || 2) + 4,
    order: 1,
    clip: false,
  }];

  if (isGas) {
    datasets.push(
        {
          label: `⚠ Warning — ${MQ_WARN}`,
          data: [],
          borderColor: 'rgba(255,234,0,.85)',
          borderWidth: 1.5,
          borderDash: [8, 5],
          pointRadius: 0,
          fill: false,
          tension: 0,
          order: 2
        },
        {
          label: `✖ Danger — ${MQ_DANGER}`,
          data: [],
          borderColor: 'rgba(255,23,68,.85)',
          borderWidth: 1.5,
          borderDash: [8, 5],
          pointRadius: 0,
          fill: false,
          tension: 0,
          order: 3
        });
  }

  /* "NOW" vertical cursor */
  const nowPlugin = {
    id: 'nowCursor',
    afterDraw(ci) {
      if (!chartLive) return;
      const {ctx: c2, chartArea: {top, bottom}, scales: {x}} = ci;
      const nx = x.getPixelForValue(Date.now());
      if (nx < ci.chartArea.left || nx > ci.chartArea.right) return;
      c2.save();
      c2.beginPath();
      c2.setLineDash([4, 3]);
      c2.strokeStyle = 'rgba(255,255,255,.3)';
      c2.lineWidth = 1.5;
      c2.moveTo(nx, top);
      c2.lineTo(nx, bottom);
      c2.stroke();
      c2.setLineDash([]);
      c2.fillStyle = 'rgba(0,230,118,.25)';
      c2.fillRect(nx - 17, top, 34, 16);
      c2.fillStyle = 'rgba(0,230,118,.9)';
      c2.font = 'bold 9px Inter,sans-serif';
      c2.textAlign = 'center';
      c2.fillText('NOW', nx, top + 11);
      c2.restore();
    },
  };

  /* Coloured background bands + threshold line injection */
  const bgPlugin = {
    id: 'bgBands',
    beforeDraw(ci) {
      if (!isGas) return;
      const {ctx: c2, chartArea: {left, right, top, bottom}, scales: {y}} = ci;
      if (!y) return;
      const wY = Math.min(Math.max(y.getPixelForValue(MQ_WARN), top), bottom);
      const dY = Math.min(Math.max(y.getPixelForValue(MQ_DANGER), top), bottom);
      c2.save();
      c2.fillStyle = 'rgba(0,230,118,.045)';
      c2.fillRect(left, wY, right - left, bottom - wY);
      c2.fillStyle = 'rgba(255,234,0,.045)';
      c2.fillRect(left, dY, right - left, wY - dY);
      c2.fillStyle = 'rgba(255,23,68,.06)';
      c2.fillRect(left, top, right - left, dY - top);
      c2.restore();
    },
    beforeUpdate(ci) {
      if (!isGas) return;
      const now = new Date();
      const tMin = new Date(now - chartWindowMin * 60_000 - 60_000);
      const tMax = new Date(+now + 30_000);
      const wDs = ci.data.datasets[1];
      const dDs = ci.data.datasets[2];
      if (wDs) wDs.data = [{x: tMin, y: MQ_WARN}, {x: tMax, y: MQ_WARN}];
      if (dDs) dDs.data = [{x: tMin, y: MQ_DANGER}, {x: tMax, y: MQ_DANGER}];
    },
  };

  /* Zone text labels in band corners */
  const zonePlugin = {
    id: 'zoneLabels',
    afterDraw(ci) {
      if (!isGas) return;
      const {ctx: c2, chartArea: {right, top, bottom}, scales: {y}} = ci;
      if (!y) return;
      const wY = Math.min(Math.max(y.getPixelForValue(MQ_WARN), top), bottom);
      const dY = Math.min(Math.max(y.getPixelForValue(MQ_DANGER), top), bottom);
      c2.save();
      c2.font = 'bold 10px Inter,sans-serif';
      c2.textAlign = 'right';
      if (bottom - wY > 20) {
        c2.fillStyle = 'rgba(0,230,118,.65)';
        c2.fillText('SAFE', right - 8, bottom - 7);
      }
      if (wY - dY > 20) {
        c2.fillStyle = 'rgba(255,234,0,.75)';
        c2.fillText('WARNING', right - 8, wY - 7);
      }
      if (dY - top > 20) {
        c2.fillStyle = 'rgba(255,23,68,.75)';
        c2.fillText('DANGER', right - 8, dY - 7);
      }
      c2.restore();
    },
  };

  chart = new Chart(ctx, {
    type: 'line',
    plugins: [bgPlugin, nowPlugin, zonePlugin],
    data: {datasets},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {duration: 150},
      interaction: {mode: 'index', intersect: false},
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'minute',
            stepSize: 1,
            displayFormats: {minute: 'HH:mm', second: 'HH:mm:ss'}
          },
          min: new Date(Date.now() - chartWindowMin * 60_000),
          max: new Date(Date.now() + 30_000),
          grid: {color: grd, lineWidth: 1},
          border: {color: light ? 'rgba(0,0,0,.15)' : 'rgba(255,255,255,.15)'},
          ticks:
              {color: tck, maxTicksLimit: 12, autoSkip: true, font: {size: 11}},
          title: {
            display: true,
            text: `Time — last ${chartWindowMin} min`,
            color: tck,
            font: {size: 11, style: 'italic'}
          },
        },
        y: {
          grid: {color: grd, lineWidth: 1},
          border: {color: light ? 'rgba(0,0,0,.15)' : 'rgba(255,255,255,.15)'},
          ticks: {
            color: tck,
            font: {size: 11},
            callback(v) {
              return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v;
            }
          },
          suggestedMin: 0,
          suggestedMax: isGas ? MQ_DANGER * 1.45 : undefined,
          title: {
            display: true,
            text: isGas ? 'ADC Value (0–4095)' : LBLS[key],
            color: tck,
            font: {size: 11, style: 'italic'}
          },
        },
      },
      plugins: {
        legend: {display: false},
        tooltip: {
          backgroundColor: light ? 'rgba(255,255,255,.97)' :
                                   'rgba(8,14,26,.97)',
          titleColor: c,
          bodyColor: light ? '#1f2937' : '#e0e6ed',
          borderColor: c,
          borderWidth: 1,
          padding: 12,
          cornerRadius: 10,
          callbacks: {
            title(it) {
              const d = new Date(it[0]?.raw?.x);
              return isNaN(d) ? '' : d.toLocaleTimeString();
            },
            label(it) {
              if (it.datasetIndex !== 0) return null;
              const v = it.raw?.y;
              if (v == null) return null;
              const vf = typeof v === 'number' ? v.toFixed(1) : v;
              if (!isGas) return ` ${vf}`;
              const st = v > MQ_DANGER ? '🔴 DANGER' :
                  v > MQ_WARN          ? '🟡 WARNING' :
                                         '🟢 SAFE';
              return ` ${vf}   ${st}`;
            },
            labelColor(it) {
              if (it.datasetIndex !== 0) return null;
              const v = it.raw?.y;
              const cl = isGas ? (v > MQ_DANGER   ? '#ff1744' :
                                      v > MQ_WARN ? '#ffea00' :
                                                    c) :
                                 c;
              return {backgroundColor: cl, borderColor: cl, borderRadius: 3};
            },
          },
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x',
            onPanStart() {
              setLiveMode(false);
            }
          },
          zoom: {
            wheel: {enabled: true, speed: 0.08},
            pinch: {enabled: true},
            mode: 'x',
            onZoomStart() {
              setLiveMode(false);
            },
          },
        },
      },
    },
  });

  buildCustomLegend(key, c, isGas, tck);

  chart._slideTimer = setInterval(() => {
    if (!chart || !chartLive) return;
    const now = Date.now();
    chart.options.scales.x.min = new Date(now - chartWindowMin * 60_000);
    chart.options.scales.x.max = new Date(now + 30_000);
    chart.options.scales.x.title.text = `Time — last ${chartWindowMin} min`;
    chart.update('none');
  }, 800);
}

function buildCustomLegend(key, c, isGas, tck) {
  const el = document.getElementById('chart-legend-custom');
  if (!el) return;
  el.innerHTML = '';
  const mk = (clr, dash, label, dotClr) => {
    const d = document.createElement('div');
    d.className = 'cleg-item';
    if (dotClr) {
      d.innerHTML = `<span class="cleg-dot" style="background:${
          dotClr};"></span><span style="color:${tck || '#8b9eb7'}">${
          label}</span>`;
    } else {
      const s = dash ?
          `border-top:2px dashed ${clr};background:transparent;height:0;` :
          `background:${clr};`;
      d.innerHTML = `<span class="cleg-line" style="${
          s}width:24px;display:inline-block;"></span><span style="color:${
          tck || '#8b9eb7'};margin-left:4px;">${label}</span>`;
    }
    el.appendChild(d);
  };
  mk(c, false, LBLS[key] || key);
  if (isGas) {
    mk('#ffea00', true, `⚠ Warning (${MQ_WARN})`);
    mk('#ff1744', true, `✖ Danger (${MQ_DANGER})`);
    mk(null, false, '  🟢 Safe reading', c);
    mk(null, false, '  🟡 Warning reading', '#ffea00');
    mk(null, false, '  🔴 Danger reading', '#ff1744');
  }
}

function setLiveMode(live) {
  chartLive = live;
  const btn = document.getElementById('btn-live-toggle');
  const dot = document.getElementById('live-dot');
  const lbl = document.getElementById('live-label');
  if (!btn) return;
  if (live) {
    btn.classList.remove('paused');
    dot?.classList.remove('paused');
    if (lbl) lbl.textContent = 'LIVE';
  } else {
    btn.classList.add('paused');
    dot?.classList.add('paused');
    if (lbl) lbl.textContent = 'PAUSED';
  }
}

/* ============================================================
   DOM READY — event wiring
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // ── Connect / Disconnect ──────────────────────────────
  document.getElementById('btn-connect-esp32')
      .addEventListener('click', async () => {
        if (!serial.connected)
          await connectSerial();
        else
          await disconnectSerial();
      });

  // ── Sidebar ───────────────────────────────────────────
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const tog = () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  };
  document.getElementById('hamburger-btn').addEventListener('click', tog);
  document.getElementById('close-sidebar-btn').addEventListener('click', tog);
  overlay.addEventListener('click', tog);

  // ── Navigation ────────────────────────────────────────
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const tid = e.currentTarget.getAttribute('data-target');
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
      document.querySelectorAll('.nav-btn')
          .forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      document.querySelectorAll('.view-section').forEach(v => {
        v.classList.remove('active-view');
        v.classList.add('hidden-view');
      });
      const t = document.getElementById(tid);
      if (t) {
        t.classList.remove('hidden-view');
        t.classList.add('active-view');
      }
      if (tid !== 'activity-view') hidePlot();
    });
  });

  // ── Activity: sensor card → chart ─────────────────────
  document.querySelectorAll('.sensor-card.hoverable').forEach(card => {
    card.addEventListener(
        'click', () => showPlot(card.getAttribute('data-sensor')));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter') showPlot(card.getAttribute('data-sensor'));
    });
  });
  document.getElementById('btn-back-sensors')
      .addEventListener('click', hidePlot);

  function showPlot(key) {
    activeKey = key;
    document.getElementById('chart-title').textContent =
        LBLS[key] || key.toUpperCase();
    document.getElementById('activity-cards').classList.add('hidden');
    document.getElementById('chart-section').classList.remove('hidden');
    document.getElementById('activity-workspace')
        .classList.add('split-view-active');
    buildChart(key);
  }
  function hidePlot() {
    document.getElementById('chart-section').classList.add('hidden');
    document.getElementById('activity-cards').classList.remove('hidden');
    document.getElementById('activity-workspace')
        .classList.remove('split-view-active');
    activeKey = null;
    if (chart) {
      if (chart._slideTimer) clearInterval(chart._slideTimer);
      chart.destroy();
      chart = null;
    }
  }

  // ── Chart toolbar ─────────────────────────────────────
  document.getElementById('btn-live-toggle').addEventListener('click', () => {
    if (!chartLive) {
      setLiveMode(true);
      if (chart) {
        chart.resetZoom();
        chart.options.scales.x.min =
            new Date(Date.now() - chartWindowMin * 60_000);
        chart.options.scales.x.max = new Date(Date.now() + 30_000);
        chart.update('none');
      }
    } else {
      setLiveMode(false);
    }
  });
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    if (chart) {
      setLiveMode(false);
      chart.zoom(1.4);
    }
  });
  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    if (chart) {
      setLiveMode(false);
      chart.zoom(0.7);
    }
  });
  document.getElementById('btn-zoom-reset').addEventListener('click', () => {
    if (!chart) return;
    chart.resetZoom();
    setLiveMode(true);
    chart.options.scales.x.min = new Date(Date.now() - chartWindowMin * 60_000);
    chart.options.scales.x.max = new Date(Date.now() + 30_000);
    chart.update('none');
  });
  document.getElementById('chart-window').addEventListener('change', e => {
    chartWindowMin = parseInt(e.target.value) || 10;
    if (chart && chartLive) {
      chart.options.scales.x.min =
          new Date(Date.now() - chartWindowMin * 60_000);
      chart.options.scales.x.max = new Date(Date.now() + 30_000);
      chart.options.scales.x.title.text = `Time — last ${chartWindowMin} min`;
      chart.update('none');
    }
  });

  // ── Control buttons ───────────────────────────────────
  document.getElementById('btn-auto').addEventListener('click', e => {
    autoMode = true;
    activateCtrlBtn(e.currentTarget, 'AUTO');
    log('↺ Switched to Auto (live sensor) mode', 'info');
  });

  document.querySelector('.ctrl-btn.btn-safe').addEventListener('click', e => {
    autoMode = false;
    activateCtrlBtn(e.currentTarget, 'SAFE');
    sendCmd('safe');
    setSystemState(0);
  });

  document.querySelector('.ctrl-btn.btn-warn').addEventListener('click', e => {
    autoMode = false;
    activateCtrlBtn(e.currentTarget, 'WARNING');
    sendCmd('mild');
    setSystemState(1);
    sendEmail('WARNING', true);
  });

  document.getElementById('btn-force-danger').addEventListener('click', () => {
    document.getElementById('danger-confirm').classList.add('show');
  });
  document.getElementById('btn-confirm-yes').addEventListener('click', () => {
    document.getElementById('danger-confirm').classList.remove('show');
    autoMode = false;
    activateCtrlBtn(document.getElementById('btn-force-danger'), 'DANGER');
    sendCmd('danger');
    setSystemState(2);
    sendEmail('DANGER', true);
  });
  document.getElementById('btn-confirm-no').addEventListener('click', () => {
    document.getElementById('danger-confirm').classList.remove('show');
  });

  function activateCtrlBtn(el, mode) {
    document.querySelectorAll('.ctrl-btn')
        .forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    const m = document.getElementById('current-mode');
    if (m) m.textContent = mode || '';
  }

  // ── Theme toggle ──────────────────────────────────────
  const tt = document.getElementById('theme-toggle');
  if (localStorage.getItem('airs-theme') === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    tt.checked = true;
  }
  tt.addEventListener('change', e => {
    if (e.target.checked) {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('airs-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('airs-theme', 'dark');
    }
    if (chart && activeKey) {
      if (chart._slideTimer) clearInterval(chart._slideTimer);
      chart.destroy();
      chart = null;
      buildChart(activeKey);
    }
  });

  // ── Settings save ─────────────────────────────────────
  document.getElementById('save-config-btn').addEventListener('click', () => {
    MQ_WARN = parseInt(document.getElementById('warn-adc').value) || 600;
    MQ_DANGER = parseInt(document.getElementById('danger-adc').value) || 1200;
    maxHistory =
        parseInt(document.getElementById('history-points').value) || 300;
    log(`Config saved: MQ_WARN=${MQ_WARN}, MQ_DANGER=${MQ_DANGER}, history=${
            maxHistory}`,
        'info');
    if (chart && activeKey) {
      if (chart._slideTimer) clearInterval(chart._slideTimer);
      chart.destroy();
      chart = null;
      buildChart(activeKey);
    }
    alert('Configuration saved!');
  });

  // ── Developer test: press T to cycle through mock states
  //    Safe (risk 0) → Warning (risk 1) → Danger (risk 2) → …
  let ts = 0;
  const TEST_FRAMES = [
    {
      mq135: 200,
      mq2: 180,
      mq5sim: 190,
      temp: 24.0,
      hum: 44,
      risk: 0,
      current: CFG.I_IDLE,
      power: +(CFG.VOLTAGE * CFG.I_IDLE).toFixed(2)
    },
    {
      mq135: 500,
      mq2: 450,
      mq5sim: 475,
      temp: 27.0,
      hum: 52,
      risk: 1,
      current: CFG.I_WARN,
      power: +(CFG.VOLTAGE * CFG.I_WARN).toFixed(2)
    },
    {
      mq135: 900,
      mq2: 750,
      mq5sim: 825,
      temp: 34.0,
      hum: 67,
      risk: 2,
      current: CFG.I_DANGER,
      power: +(CFG.VOLTAGE * CFG.I_DANGER).toFixed(2)
    },
  ];
  document.addEventListener('keydown', e => {
    if (e.key === 't' || e.key === 'T') {
      ingest(TEST_FRAMES[ts]);
      log(`[TEST] State ${ts}: risk=${TEST_FRAMES[ts].risk}`, 'info');
      ts = (ts + 1) % TEST_FRAMES.length;
    }
  });

  // ── Email ─────────────────────────────────────────────
  document.getElementById('btn-save-email')
      .addEventListener('click', emailSave);
  document.getElementById('btn-test-email')
      .addEventListener('click', async () => {
        if (!EMAIL.ready) {
          showToast('Save email config first before testing.', 'warn');
          return;
        }
        const prev = EMAIL.lastAlertType;
        const prevTime = EMAIL.lastAlertTime;
        EMAIL.lastAlertType = null;
        EMAIL.lastAlertTime = 0;
        await sendEmail('TEST_ALERT', true);
        if (prev) {
          EMAIL.lastAlertType = prev;
          EMAIL.lastAlertTime = prevTime;
        }
      });

  emailLoad();

  // ── Init UI ───────────────────────────────────────────
  setSystemState(-1);
  onConnChange(false);
  setTimeout(() => {
    log('Dashboard ready. Press T to cycle test states.', 'info');
    if (!('serial' in navigator))
      log('⚠ Web Serial not available — use Chrome/Edge.', 'warn');
  }, 5200);
});
