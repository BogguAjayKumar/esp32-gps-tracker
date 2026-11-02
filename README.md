# Real-Time GPS Tracking Dashboard 🛰️📍

A real-time GPS tracking dashboard built with **Node.js**, **Express**, **SerialPort**, **Socket.IO**, and **Leaflet.js**. It connects to an **ESP32** microcontroller interfaced with a **u-blox NEO-6M GPS module** over USB serial, streaming live telemetry and visualizing the location, speed, altitude, heading, and trail history on an interactive map.

---

## Architecture Overview

```
 ┌──────────────────────┐        Serial (USB)         ┌────────────────────────┐
 │      ESP32 +         │  ─────────────────────────> │     Node.js Server     │
 │  NEO-6M GPS Module   │   115200 baud (JSON stream) │ (Express + SerialPort) │
 └──────────────────────┘                             └──────────┬─────────────┘
                                                                 │
                                          Socket.IO & REST APIs  │  (Port 3000)
                                                                 ▼
                                                      ┌────────────────────────┐
                                                      │    Web Dashboard UI    │
                                                      │  (Leaflet + Vanilla JS)│
                                                      └────────────────────────┘
```

---

## ✨ Features

- **Real-Time Telemetry Streaming:** Receives JSON GPS objects per second from the ESP32, validates coordinates, stamps with server ISO timestamps, and emits via Socket.IO.
- **Interactive Fullscreen Map:** Powered by Leaflet.js with smooth position transitions, directional course-heading arrow marker, and dynamic color-coded polyline trail.
- **Auto-Follow & Trail Management:**
  - Auto-center toggle that keeps the map centered on the vehicle / marker as it moves.
  - "Clear Trail" action to reset in-memory history and map polylines.
  - "Recenter" button to quickly focus on the last reported position.
- **Rich Telemetry Cards:**
  - **Coordinates:** Latitude & Longitude in decimal degrees with cardinal notation (e.g. `17.385044° N, 78.486671° E`).
  - **Speed:** Formatted in `km/h` with secondary `mph` and `knots` display.
  - **Altitude:** Meters above sea level with feet conversion.
  - **Course / Heading:** Dynamic 360° rotating compass needle and cardinal direction (e.g., `NE (North-East)`).
  - **Satellites in View:** Satellite count indicator and signal strength bar.
  - **HDOP (Precision):** Color-coded accuracy badge (Ideal, Excellent, Good, Moderate, Poor).
  - **Diagnostics:** Elapsed update ticker, raw character counter, distance traveled, and total points.
- **Resilient Serial Connection:**
  - Automatic reconnection every 3 seconds if the port is disconnected or busy.
  - Non-blocking error handling for `Access denied` when serial monitors are left open.
  - Safely ignores non-JSON debug lines without crashing.
- **Wiring Alert System:** Detects if GPS character count (`chars`) stays at 0 and presents a warning alert to check TX/RX pin connections, power, or baud rate.
- **Session CSV Logging & Export:**
  - Automatically logs every valid 3D fix to a timestamped CSV file in `logs/`.
  - Built-in `GET /api/export.csv` button in the UI for one-click download.
- **Light / Dark Mode:** Full UI theme switcher with matching CartoDB Dark Matter and OpenStreetMap tiles. Safely falls back if `localStorage` is disabled.
- **Fully Responsive:** Optimized for both desktop displays and mobile phone browsers with collapsible drawers and touch targets.
- **Built-in Mock Simulator:** Includes `npm run simulate` to test the entire dashboard without requiring physical hardware or outdoors satellite reception.

---

## 📁 Project Structure

```
gps/
├── .env                  # Local environment configuration
├── .env.example          # Environment variable template
├── .gitignore            # Git ignore configuration
├── package.json          # Node.js project manifest & dependencies
├── server.js             # Express backend, SerialPort manager & Socket.IO server
├── mock-gps.js           # Simulation streamer for offline testing
├── public/
│   ├── index.html        # Clean HTML5 dashboard with Leaflet & Telemetry cards
│   ├── style.css         # Responsive styling with Light/Dark theme variables
│   └── app.js            # Client-side map rendering, compass, and Socket.IO hooks
├── logs/                 # Auto-generated CSV track logs
│   └── .gitkeep
└── README.md             # Documentation and setup guide
```

---

## ⚡ Quick Start (Windows)

### Prerequisites
- **Node.js (LTS version 18, 20, or 22+)**: [Download Node.js](https://nodejs.org/)
- **ESP32** connected via micro-USB / USB-C to your Windows PC.

### 1. Clone & Install Dependencies
Open PowerShell or Command Prompt in the project folder:
```powershell
npm install
```

### 2. Configure Port Settings
Review `.env` (or copy `.env.example` to `.env`):
```ini
PORT=3000
SERIAL_PORT=COM7
BAUD_RATE=115200
RECONNECT_INTERVAL_MS=3000
MAX_TRAIL_POINTS=500
LOG_DIR=logs
SIMULATION_MODE=false
```

> **Note:** If your ESP32 appears on a different COM port (e.g. `COM3`, `COM4`), update `SERIAL_PORT` in `.env` or select it directly from the UI dropdown.

### 3. Run the Server
```powershell
npm start
```
Then open your browser at:
```
http://localhost:3000
```

---

## 🧪 Testing with Mock GPS (No Hardware Required)

If you are developing indoors or testing the UI before flashing the ESP32:

1. In one terminal, start the server:
   ```powershell
   npm start
   ```
2. In a second terminal, run the mock generator:
   ```powershell
   npm run simulate
   ```
3. Open `http://localhost:3000` to watch the simulated car move through coordinates, update metrics, draw the trail, and export CSV logs!

*(Alternatively, set `SIMULATION_MODE=true` in `.env` for the server to generate simulated GPS telemetry internally).*

---

## 📡 ESP32 Arduino Firmware (Reference)

For reference, here is the corresponding ESP32 Arduino sketch using `TinyGPS++` and `HardwareSerial`:

```cpp
#include <TinyGPSPlus.h>

TinyGPSPlus gps;
HardwareSerial gpsSerial(2); // GPS on UART2: RX=GPIO16, TX=GPIO17

void setup() {
  Serial.begin(115200);      // USB Serial to PC
  gpsSerial.begin(9600, SERIAL_8N1, 16, 17); // NEO-6M default baud
  Serial.println("# ESP32 GPS streamer started");
}

void loop() {
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  static unsigned long lastPrint = 0;
  if (millis() - lastPrint >= 1000) {
    lastPrint = millis();

    if (gps.location.isValid()) {
      Serial.printf("{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"sats\":%d,\"alt\":%.1f,\"speed\":%.2f,\"course\":%.1f,\"hdop\":%.2f,\"chars\":%lu}\n",
        gps.location.lat(),
        gps.location.lng(),
        gps.satellites.value(),
        gps.altitude.meters(),
        gps.speed.kmph(),
        gps.course.deg(),
        gps.hdop.hdop(),
        gps.charsProcessed()
      );
    } else {
      Serial.printf("{\"fix\":false,\"sats\":%d,\"chars\":%lu}\n",
        gps.satellites.value(),
        gps.charsProcessed()
      );
    }
  }
}
```

---

## 🔌 REST API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | Serves the web dashboard. |
| `/api/ports` | `GET` | Lists all detected system serial COM ports. |
| `/api/ports/select` | `POST` | Dynamically switches to a different COM port / baud rate without restarting. |
| `/api/status` | `GET` | Returns connection state, client count, recorded points, and latest reading. |
| `/api/export.csv` | `GET` | Downloads the active recorded track as a standard CSV file. |
| `/api/trail/clear` | `POST` | Clears recorded trail points from server memory and broadcasts to clients. |

---

## 🛠️ Troubleshooting Guide

### 1. "Access denied / Port busy"
- **Cause:** On Windows, serial COM ports can only be opened by one process at a time. If the **Arduino IDE Serial Monitor**, **PuTTY**, **VS Code Serial Monitor**, or **Cura** is open on `COM7`, Node.js will be blocked.
- **Fix:**
  1. Close the Serial Monitor window / tab inside the Arduino IDE or other terminal software.
  2. The Node.js server automatically detects this and will auto-reconnect within 3 seconds without needing a restart!

### 2. Wrong COM Port
- **Cause:** When plugging the ESP32 into a different USB port or hub, Windows may assign a new COM port number (e.g., `COM3` instead of `COM7`).
- **Fix:**
  1. Open Windows Device Manager (`Win + X` -> **Device Manager**) and expand **Ports (COM & LPT)** to verify your CP210x or CH340 COM port.
  2. Use the **Hardware Port** dropdown at the bottom of the dashboard sidebar to select the correct port live, or update `SERIAL_PORT` in `.env`.

### 3. No GPS Fix Indoors ("Searching for Satellites...")
- **Cause:** GPS signals (1575.42 MHz) are attenuated by concrete, brick, metallic roofs, and window coatings. The NEO-6M requires clear line-of-sight to at least 4 satellites for a 3D fix.
- **Fix:**
  1. Place the GPS patch antenna on an open windowsill, balcony, or outdoors.
  2. Ensure the ceramic square antenna faces upwards towards the sky.
  3. A "cold start" outdoors takes between 45 seconds to 2 minutes on the first lock. The green/blue LED on the NEO-6M will start blinking once satellite lock is achieved.

### 4. Blank Map
- **Cause:** Missing internet connectivity to download map tiles, or browser ad blockers blocking the OpenStreetMap/CARTO CDN.
- **Fix:**
  1. Verify your computer has internet access.
  2. If using strict ad blockers (uBlock Origin, Brave Shields), ensure `unpkg.com` and `tile.openstreetmap.org` / `cartocdn.com` are allowed.

### 5. Wiring Warning ("0 Characters Received")
- **Cause:** The ESP32 is not receiving serial bytes from the NEO-6M GPS module.
- **Fix:**
  1. Verify the crossover connection: **GPS Module TX** must connect to **ESP32 RX** (e.g. GPIO 16).
  2. Verify power: Connect NEO-6M `VCC` to ESP32 `VIN` (5V) or `3V3`, and connect `GND` to `GND`.
  3. Confirm baud rate: Most NEO-6M modules communicate with the ESP32 at `9600` baud by default on the internal UART.

---

## 📄 License

MIT License &copy; 2026 Boggu Ajay Kumar.
