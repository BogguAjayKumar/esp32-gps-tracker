# Hina Maps 🛰️🧭 — Live Navigation & Spatial Telemetry

A high-performance, premium live-tracking web map and navigation system built with **MapLibre GL JS**, **Node.js**, **Express**, **SerialPort**, and **Socket.IO**. Designed for hardware developers, vehicles, and outdoor exploration, Hina Maps connects to an **ESP32** microcontroller interfaced with a **u-blox NEO-6M / M8N GPS module** over USB serial, streaming live telemetry with sub-meter smoothing, road-snapping, 3D vector buildings, and spoken turn-by-turn driving directions.

---

## 🏗️ Architecture Overview

```
 ┌──────────────────────┐        Serial (USB)         ┌────────────────────────┐
 │      ESP32 +         │  ─────────────────────────> │     Node.js Server     │
 │  NEO-6M GPS Module   │   115200 baud (JSON / NMEA) │ (Express + SerialPort) │
 └──────────────────────┘                             └──────────┬─────────────┘
                                                                 │
                                          Socket.IO & REST APIs  │  (Port 3000)
                                                                 ▼
                                                      ┌────────────────────────┐
                                                      │  Hina Maps Web Client  │
                                                      │ (MapLibre GL JS + PWA) │
                                                      └────────────────────────┘
```

---

## ✨ Features

### 1. Map Engine & Spatial Detail
- **MapLibre GL JS (Vector & Hybrid Engine):** Replaced raster Leaflet with a modern WebGL-accelerated vector tile engine supporting linear raster overzooming up to zoom 22, smooth bearing rotations, and 3D camera pitching.
- **5 Base Map Styles:**
  1. **🛰️ Hybrid (Default):** High-resolution Esri World Imagery with vector road labels, place boundaries, and 3D buildings.
  2. **🛰️ Pure Satellite:** Unobstructed high-detail aerial photography.
  3. **🗺️ Streets:** Full Carto Voyager vector styling with high-zoom lane arrows, road classifications, and POIs.
  4. **🌙 Dark:** High-contrast Carto Dark Matter vector theme for nighttime driving.
  5. **⛰️ Terrain:** Topographic elevation contours with hillshading via OpenTopoMap.
- **3D Buildings (Fill-Extrusion):** Dynamically rendered 3D building heights with gradient coloring based on building elevation and level counts.
- **POIs & Zoom Filtering:** Displays hospitals, fuel stations, ATMs, restaurants, transit hubs, and schools filtered dynamically by zoom level to eliminate map clutter.
- **Road Class Coloring:** Speed trails and road segments colored by speed and road hierarchy.

### 2. Live Tracking & Spatial Telemetry
- **2D Kalman Filter Smoothing (`public/js/kalman.js`):** Filters raw GPS jitter and antenna noise using a dynamic covariance 2D Kalman filter.
- **OSRM Map-Matching & Road Snapping:** Snaps raw coordinates to the nearest drivable road segment via `/api/routing/nearest`.
- **Directional 3D Vehicle Marker:** Custom hardware-accelerated vehicle puck with pulsing beacon and rotating heading arrow aligned to direction of travel.
- **Speed-Colored Path Trail:** Records the traveled route with GeoJSON LineString segments colored according to instantaneous speed (Green = cruising, Cyan = moderate, Amber = fast, Red = high speed).
- **Auto-Follow & 3D Driving View:**
  - **Follow 2D:** Keeps map centered on vehicle.
  - **Follow 3D:** Tilts camera to 58° driving pitch and rotates map bearing with vehicle course heading.
  - **Free Explore:** Panning or dragging the map automatically pauses auto-follow to allow manual inspection; re-center button snaps back instantly.
- **Road Speed Limit Alerts:** Displays road speed limit badge and sounds/displays an animated warning alert when the vehicle exceeds the road limit.
- **Cached Reverse-Geocoding:** Resolves current street address, place name, and postal code via Photon / BigDataCloud fallback with in-memory caching to eliminate rate limits.

### 3. Turn-by-Turn Navigation & Search
- **Live Search with Autocomplete:** Debounced place name, street address, and direct coordinate (`lat, lng`) search powered by Photon OSM geocoding.
- **Turn-by-Turn Guidance Banner:** Visual maneuver icons (left turn, right turn, fork, roundabout, arrival), distance callout, next street name, remaining distance, and ETA.
- **Spoken Voice Directions (`public/js/speech.js`):** Hands-free voice guidance using the browser Web Speech Synthesis API with mute toggle and debounce queue.
- **Off-Route Auto-Rerouting:** Detects when the vehicle deviates more than 50 meters from the planned route and automatically recalculates driving directions.
- **Favorites & Saved Places (`public/js/storage.js`):** Star locations to save them locally, and initiate one-click navigation to saved places.
- **Trip History & Analytics:** Tracks trip duration, total distance traveled, average speed, and maximum speed.
- **Full Track Exports:** Export trip data directly in GPX, GeoJSON, and CSV formats.

### 4. Integrated Hardware USB Serial Monitor
- **Real-Time Web Console:** Embedded sliding drawer to view raw serial communication between ESP32 and server without locking the COM port.
- **Categorized Highlighting:** Automatic tag badges for JSON packets, NMEA sentences, transmitted commands, system messages, and errors.
- **Filtering & Search:** Instant text search and category chips (`All`, `JSON`, `NMEA`, `Sent TX`, `Debug`).
- **Interactive Controls:** Baud rate selector (`9600` to `921600`), auto-scroll toggle, timestamp toggle, pause/resume, and one-click clipboard copy.
- **Bidirectional Transmission:** Send serial commands or NMEA configurations directly to the ESP32.

### 5. PWA & Offline Support
- **Progressive Web App:** Web manifest and Service Worker (`sw.js`) enabled for installation on mobile devices and tablet dashboards.
- **Client-Side Caching:** Offline shell assets and cached vector styles.

---

## 📁 Project Structure

```
gps/
├── .env                     # Local environment settings (PORT, SERIAL_PORT, BAUD_RATE)
├── .env.example             # Template for environment configuration
├── package.json             # Node.js project manifest & dependencies
├── server.js                # Express server, SerialPort manager, OSRM/Geocode proxies & Socket.IO
├── mock-gps.js              # Hardware simulation streamer for offline testing
├── public/
│   ├── index.html           # Modern HTML5 Hina Maps layout
│   ├── style.css            # Glassmorphism styling, responsive themes, HUD & drawer styles
│   ├── app.js               # MapLibre GL JS engine, Kalman filter integration & telemetry loop
│   ├── manifest.json        # PWA Web Application Manifest
│   ├── sw.js                # Service Worker for offline asset caching
│   └── js/
│       ├── kalman.js        # 2D GPS Kalman Filter implementation
│       ├── speech.js        # Web Speech API turn-by-turn voice guide
│       ├── storage.js       # LocalStorage favorites, trip history & GPX/GeoJSON exporters
│       └── styles.js        # MapLibre vector style definitions & 3D buildings injector
├── logs/                    # Timestamped CSV telemetry session recordings
└── README.md                # Documentation and guide
```

---

## ⚡ Quick Start (Windows)

### Prerequisites
- **Node.js (v18, v20, or v22+)**: [Download Node.js](https://nodejs.org/)
- **ESP32** connected via micro-USB / USB-C to your computer.

### 1. Install Dependencies
```powershell
npm install
```

### 2. Start the Server
```powershell
npm start
```
The server will automatically scan your USB ports, find the ESP32 bridge (e.g. `COM7`), connect at 115200 baud, and launch the web server on `http://localhost:3000`.

### 3. Open Hina Maps
Navigate to `http://localhost:3000` in Google Chrome, Microsoft Edge, or Safari.

---

## 🧪 Testing Without Hardware (Simulation Mode)

If you are developing indoors without an ESP32 or satellite reception:
```powershell
npm run simulate
```
This launches a virtual vehicle streaming realistic GPS fixes across Hyderabad / Charminar, demonstrating Kalman smoothing, speed-colored trails, and turn-by-turn routing in real time.

---

## 🌐 Free Tile & API Providers Used

| Service | Provider | Cost / API Key |
|---|---|---|
| **Satellite Imagery** | Esri World Imagery | Free (No API Key Required) |
| **Streets Vector Map** | Carto Voyager (OSM) | Free (No API Key Required) |
| **Dark Vector Map** | Carto Dark Matter (OSM) | Free (No API Key Required) |
| **Topographic Contours** | OpenTopoMap / SRTM | Free (No API Key Required) |
| **Turn-by-Turn Routing** | OpenStreetMap OSRM | Free (No API Key Required) |
| **Road Snapping / Nearest**| OpenStreetMap OSRM | Free (No API Key Required) |
| **Geocoding & Search** | Photon (Komoot OSM) | Free (No API Key Required) |
| **Reverse Geocoding** | Photon + BigDataCloud | Free (No API Key Required) |

---

## 🛡️ License
MIT License. Open-source and free for personal, commercial, and research use.
