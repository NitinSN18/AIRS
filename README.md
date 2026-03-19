# AIRS — Air Intelligent Response System

A browser-based real-time dashboard for an ESP32 air quality monitoring system. Connects directly to hardware over **Web Serial API** — no server, no app, no installation.

---

## What is AIRS?

AIRS is the monitoring and control interface for an ESP32-powered indoor air safety node. The hardware reads gas concentration, temperature, humidity, and flame presence; the dashboard visualises the data, computes a composite Air Quality Index, and lets you send manual override commands to the device.

---

## Problem it solves

Indoor gas leaks (LPG, natural gas, CO) are invisible and odourless until dangerous concentrations are reached. AIRS gives you:

- **Continuous monitoring** of multiple gas types simultaneously
- **Three-tier alerting** (Safe → Warning → Danger) with hardware actuation (servo vent, buzzer, LED, relay)
- **Remote awareness** via email notifications when thresholds are crossed
- **Manual override** so you can force a safe or danger state for testing without waiting for a real event

---

## Features

| Feature | Detail |
|---------|--------|
| Live sensor dashboard | MQ135, MQ2, simulated MQ5, DHT11 temperature + humidity, flame sensor |
| Air Quality Index | Weighted composite score with animated arc dial and 6-tier colour scale |
| Interactive charts | Per-sensor time-series with zoom/pan, coloured safety bands, live cursor |
| System status panel | Ventilation window SVG animation, buzzer state, LED subsystem, power draw |
| Manual control | Force Safe / Warning / Danger with confirmation guard on Danger |
| Email alerts | EmailJS integration — browser-native, no backend required |
| Dark / light theme | Toggleable with localStorage persistence |
| Intro animation | Cinematic AIRS acronym reveal on load |
| Developer test mode | Press **T** to cycle Safe → Warning → Danger without hardware |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Hardware MCU | ESP32 (Arduino framework) |
| Serial bridge | [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) — Chrome / Edge only |
| Charts | [Chart.js](https://www.chartjs.org/) + chartjs-adapter-date-fns + chartjs-plugin-zoom |
| Email | [EmailJS](https://www.emailjs.com/) (browser SDK) |
| Fonts | Orbitron (headings), Poppins (UI), Inter (body) via Google Fonts |
| Icons | Font Awesome 6 |
| Styles | Vanilla CSS with CSS custom properties (no framework) |
| JS | Vanilla ES2020+ (no bundler required) |

---

## Hardware

### Sensors

| Sensor | Measures | Notes |
|--------|----------|-------|
| **MQ135** | CO, NH₃, benzene, smoke | Broad-spectrum; 50% AQI weight |
| **MQ2** | LPG, butane, smoke | Combustibles focus; 30% AQI weight |
| **MQ5** | Natural gas / LPG | *Simulated* — no hardware; 20% AQI weight |
| **DHT11** | Temperature (°C), Humidity (%) | Digital single-wire |
| **Flame sensor** | Infrared flame detection | Digital HIGH/LOW |

> **Note on MQ5:** The board currently has only MQ135 and MQ2. The MQ5 channel is simulated as `(MQ135 + MQ2) / 2` — a natural-gas proxy. Swap in real MQ5 data in `parseLine()` / `ingest()` when hardware is added.

### Actuators

| Actuator | State | Trigger |
|----------|-------|---------|
| Servo (ventilation window) | 0° closed / 40° partial / 90° fully open | Safe / Warning / Danger |
| Green LED | ON | Safe |
| Yellow LED | ON | Warning |
| Red LED | ON | Danger |
| Buzzer | Sounding | Danger |
| Relay | Closed | Danger (external shutoff circuit) |

### Wiring (rough)

```
ESP32 GPIO assignments (example — match your sketch):

MQ135 analog out  →  GPIO 34 (ADC1_CH6)
MQ2 analog out    →  GPIO 35 (ADC1_CH7)
DHT11 data        →  GPIO 4
Flame sensor      →  GPIO 14 (digital)
Servo signal      →  GPIO 18 (PWM)
Green LED         →  GPIO 26
Yellow LED        →  GPIO 27
Red LED           →  GPIO 25
Buzzer            →  GPIO 32
Relay IN          →  GPIO 33
```

### Serial protocol

The ESP32 sketch sends one line per reading at **115200 baud**.

**Preferred (JSON):**
```json
{"mq135":412,"mq2":305,"temp":25.4,"hum":58,"flame":false,"risk":0}
```

**Fallback (text key:value):**
```
MQ135: 412  MQ2: 305  Temp: 25.4  Humidity: 58  Flame: NO
```

Commands accepted by the ESP32 (sent from the Control panel):
```
safe      → triggerSafeMode()
mild      → triggerWarningMode()
danger    → triggerDangerMode()
```

---

## AQI Logic

```
S_x  = max(0, (V_x − B) / B)           normalised sensor deviation
AQI  = 100 × (0.5·S₁₃₅ + 0.3·S₂ + 0.2·S₅)
```

### Why these weights?

| Sensor | Weight | Reason |
|--------|--------|--------|
| MQ135  | **50%** | Broadest sensitivity (CO, ammonia, benzene, organic solvents). Covers the widest range of hazardous indoor gases. Dominates the score. |
| MQ2    | **30%** | Directly measures combustible gases (LPG, butane, methane) — the most common kitchen/utility-room hazards. High weight because these are the highest-consequence leak types. |
| MQ5    | **20%** | Natural gas proxy. Lower weight because it is simulated, so its contribution should not outweigh hardware measurements. |

### Baseline (B)

The baseline is set to `MQ_WARN` (default **800 ADC**, configurable in Settings). This means:

- Readings **below** the warning threshold contribute **S = 0** (clean air — AQI stays at 0)
- Readings **above** the baseline scale linearly: doubling the reading beyond baseline gives S = 1 for that sensor

This avoids false AQI elevation from normal background noise.

### AQI scale

| Range | Category |
|-------|----------|
| 0–50 | Good |
| 51–100 | Moderate |
| 101–150 | Unhealthy for Sensitive Groups |
| 151–200 | Unhealthy |
| 201–300 | Very Unhealthy |
| 300+ | Hazardous |

---

## Security Notes

**No credentials are hard-coded.** EmailJS keys are entered by the user in the Settings panel and stored only in `localStorage` on their own device. See `.env.example` for variable names if you ever adapt this to a server-rendered environment.

Do not commit a `.env` file with real keys to source control.

---

## How to Run

### Browser setup

1. Open **Google Chrome** or **Microsoft Edge** (Web Serial API is not supported in Firefox or Safari)
2. Open `index.html` — either from the filesystem or via a local server:
   ```bash
   # Quick local server (Python)
   python -m http.server 8080
   # then open http://localhost:8080
   ```
3. Click **Connect ESP32** in the header
4. Select your ESP32 COM port from the browser dialog
5. Data streams immediately if the sketch is running

> **No hardware?** Press **T** to cycle through Safe → Warning → Danger test frames.

### ESP32 setup

1. Flash the Arduino sketch to your ESP32 (ensure baud rate is **115200**)
2. Ensure the sketch outputs JSON or key:value text — see Serial protocol above
3. Connect via USB-C / micro-USB
4. Open the dashboard and click Connect

### Email alerts (optional)

1. Create a free account at [emailjs.com](https://www.emailjs.com)
2. Create an email service (Gmail, Outlook, etc.)
3. Create a template using the variables listed in Settings → Email Notifications
4. Paste your Public Key, Service ID, Template ID, and recipient email into the Settings panel
5. Click **Save & Activate**, then **Send Test Email** to verify

---

## File Structure

```
airs/
├── index.html        HTML shell — views and component markup
├── styles.css        All CSS (design tokens, layout, components, animations)
├── script.js         All JavaScript (serial, AQI, charts, state, events)
├── .env.example      Credential template (never commit real keys)
└── README.md         This file
```

---

## Screenshots

> Add screenshots of the dashboard here.
> Suggested shots: Dashboard (dark), Dashboard (light), AQI panel, Activity chart (warning state), Danger alert banner.

```
docs/
├── screenshot-dashboard-dark.png
├── screenshot-dashboard-light.png
├── screenshot-aqi.png
├── screenshot-chart-warning.png
└── screenshot-danger-alert.png

## System Architecture

ESP32 (Sensors)
   ↓ Serial (USB)
Browser (Web Serial API)
   ↓
Dashboard (Processing + Visualization)
   ↓
Actuation (Servo / Buzzer / LEDs via commands)

## AQI Calculation

AIRS computes a composite Air Quality Index:

AQI = 100 × (0.5·S₁₃₅ + 0.3·S₂ + 0.2·S₅)

Where:
- S135 → MQ135 (air quality baseline)
- S2   → MQ2 (smoke/gas detection)
- S5   → derived value (average of MQ135 & MQ2)

Each score is normalized against a baseline:
S = max(0, (V - B) / B)

## Hardware Setup

- MQ135 → Air quality sensing
- MQ2 → Smoke / LPG detection
- Flame sensor → Fire detection
- DHT11 → Temperature & humidity
- Servo → Ventilation control
- Buzzer + LEDs → Alert system

ESP32 processes sensor data and streams via serial.
```
