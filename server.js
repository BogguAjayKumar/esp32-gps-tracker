/**
 * Real-Time GPS Tracking Dashboard - Server
 * Stack: Node.js (Express), SerialPort, Socket.IO
 * 
 * Communicates with ESP32 + NEO-6M GPS over USB Serial (COM7, 115200 baud).
 * Parses incoming JSON GPS streams, logs fixes to CSV, and broadcasts
 * live telemetry to web clients in real time.
 */

require('dotenv').config();
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// --- Configuration ---
const PORT = parseInt(process.env.PORT || '3000', 10);
let serialPortPath = process.env.SERIAL_PORT || 'COM7';
let baudRate = parseInt(process.env.BAUD_RATE || '115200', 10);
let isAutoDetect = process.env.AUTO_DETECT !== 'false'; // Smart auto-connect by default
const MAX_TRAIL_POINTS = parseInt(process.env.MAX_TRAIL_POINTS || '500', 10);
const RECONNECT_INTERVAL_MS = parseInt(process.env.RECONNECT_INTERVAL_MS || '2000', 10);
const LOG_DIR = path.resolve(__dirname, process.env.LOG_DIR || 'logs');
const SIMULATION_MODE = process.env.SIMULATION_MODE === 'true';

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Generate session-specific CSV log filename: logs/gps_track_YYYY-MM-DD_HH-mm-ss.csv
const sessionTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
const sessionCsvPath = path.join(LOG_DIR, `gps_track_${sessionTimestamp}.csv`);
const CSV_HEADER = 'timestamp,lat,lng,alt,speed,course,sats,hdop,chars\n';

try {
  fs.writeFileSync(sessionCsvPath, CSV_HEADER, { flag: 'wx' });
  console.log(`[CSV Logger] Initialized session log: ${sessionCsvPath}`);
} catch (err) {
  console.warn(`[CSV Logger] Note on session file creation: ${err.message}`);
}

// --- App and Socket.IO Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- In-Memory State ---
let latestReading = null;
let latestAddress = null;
const trailHistory = []; // Ring-buffer of valid fix points
const geocodeCache = new Map();

/**
 * Reverse geocodes coordinates to a human-readable place name and full street address.
 * Primary provider: Photon (OpenStreetMap data with street and neighborhood precision).
 * Secondary fallback: BigDataCloud client API.
 */
function reverseGeocode(lat, lng) {
  const roundedLat = Number(lat).toFixed(4);
  const roundedLng = Number(lng).toFixed(4);
  const cacheKey = `${roundedLat},${roundedLng}`;

  if (geocodeCache.has(cacheKey)) {
    return Promise.resolve(geocodeCache.get(cacheKey));
  }

  return new Promise((resolve) => {
    // 1. Try Photon (OpenStreetMap data)
    const photonUrl = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`;
    const req = https.get(photonUrl, { headers: { 'User-Agent': 'ESP32-GPS-Tracker-Dashboard/1.0' }, timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json && Array.isArray(json.features) && json.features.length > 0) {
            const p = json.features[0].properties;
            const parts = [];
            if (p.housenumber) parts.push(p.housenumber);
            if (p.name) parts.push(p.name);
            if (p.street && p.street !== p.name) parts.push(p.street);
            if (p.locality && p.locality !== p.name) parts.push(p.locality);
            if (p.district) parts.push(p.district);
            if (p.city || p.county) parts.push(p.city || p.county);
            if (p.state) parts.push(p.state);
            if (p.postcode) parts.push(p.postcode);
            if (p.country) parts.push(p.country);

            const placeName = p.name || p.street || p.locality || p.district || 'Location';
            const fullAddress = parts.filter(Boolean).join(', ');
            const result = { success: true, placeName, fullAddress, details: p };
            geocodeCache.set(cacheKey, result);
            return resolve(result);
          }
        } catch (e) {}

        // Fallback to BigDataCloud
        fallbackBigDataCloud(lat, lng, cacheKey, resolve);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      fallbackBigDataCloud(lat, lng, cacheKey, resolve);
    });

    req.on('error', () => {
      fallbackBigDataCloud(lat, lng, cacheKey, resolve);
    });
  });
}

function fallbackBigDataCloud(lat, lng, cacheKey, resolve) {
  const bdcUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
  const req = https.get(bdcUrl, { timeout: 4000 }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const parts = [json.locality, json.city, json.principalSubdivision, json.countryName].filter(Boolean);
        const placeName = json.locality || json.city || 'Location';
        const fullAddress = parts.join(', ');
        const result = { success: true, placeName, fullAddress, details: json };
        geocodeCache.set(cacheKey, result);
        resolve(result);
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  });

  req.on('timeout', () => {
    req.destroy();
    resolve({ success: false, error: 'Reverse geocode timed out' });
  });

  req.on('error', (err) => {
    resolve({ success: false, error: err.message });
  });
}

// Serial Monitor Circular Buffer (recent 500 lines)
const MAX_SERIAL_LOG_ENTRIES = 500;
const serialLogHistory = [];
let serialLogId = 0;

/**
 * Appends a log entry to the in-memory serial history and broadcasts it to web clients.
 */
function addSerialLog(direction, text, type = 'raw') {
  const entry = {
    id: ++serialLogId,
    timestamp: new Date().toISOString(),
    direction, // 'rx' | 'tx' | 'sys'
    text: String(text),
    type // 'json' | 'nmea' | 'debug' | 'tx' | 'sys' | 'error'
  };

  serialLogHistory.push(entry);
  if (serialLogHistory.length > MAX_SERIAL_LOG_ENTRIES) {
    serialLogHistory.shift();
  }

  io.emit('serial:line', entry);
  return entry;
}

let serialPort = null;
let parser = null;
let reconnectTimer = null;
let isConnecting = false;
let currentSerialStatus = {
  status: 'disconnected', // 'connected' | 'disconnected' | 'error' | 'reconnecting'
  port: serialPortPath,
  baudRate: baudRate,
  autoDetect: isAutoDetect,
  message: 'Initializing...',
  timestamp: new Date().toISOString()
};

/**
 * Writes data directly to the open serial port.
 */
function writeToSerial(text, lineEnding = '\r\n') {
  return new Promise((resolve, reject) => {
    if (!serialPort || !serialPort.isOpen) {
      const err = new Error(`Serial port (${serialPortPath}) is not open.`);
      addSerialLog('sys', `[TX Error] ${err.message}`, 'error');
      return reject(err);
    }
    const fullText = String(text) + lineEnding;
    serialPort.write(fullText, (err) => {
      if (err) {
        addSerialLog('sys', `[TX Error] ${err.message}`, 'error');
        return reject(err);
      }
      addSerialLog('tx', text, 'tx');
      resolve();
    });
  });
}

/**
 * Updates the current serial status and broadcasts it to all connected Socket.IO clients.
 */
function updateSerialStatus(status, message) {
  currentSerialStatus = {
    status,
    port: serialPortPath,
    baudRate: baudRate,
    autoDetect: isAutoDetect,
    message,
    timestamp: new Date().toISOString()
  };
  io.emit('serial:status', currentSerialStatus);
  addSerialLog('sys', `[Status: ${status.toUpperCase()}] ${message}`, 'sys');
  console.log(`[Serial Status] ${status.toUpperCase()} (${serialPortPath}, Auto=${isAutoDetect}): ${message}`);
}

/**
 * Appends a valid fix to the CSV log file.
 */
function logFixToCsv(fix) {
  const row = `"${fix.timestamp}",${fix.lat},${fix.lng},${fix.alt ?? ''},${fix.speed ?? ''},${fix.course ?? ''},${fix.sats ?? 0},${fix.hdop ?? ''},${fix.chars ?? 0}\n`;
  fs.appendFile(sessionCsvPath, row, (err) => {
    if (err) {
      console.error('[CSV Logger] Error writing to CSV:', err.message);
    }
  });
}

/**
 * Broadcasts validated GPS reading to all connected web clients,
 * updates in-memory history, and records valid fixes to the session CSV.
 */
function broadcastReading(parsed) {
  if (typeof parsed !== 'object' || parsed === null) return;

  // Stamp with server-side ISO timestamp
  parsed.timestamp = new Date().toISOString();

  // If fix is true, strictly validate coordinate ranges and types
  if (parsed.fix === true) {
    const latValid = typeof parsed.lat === 'number' && Number.isFinite(parsed.lat) && parsed.lat >= -90 && parsed.lat <= 90;
    const lngValid = typeof parsed.lng === 'number' && Number.isFinite(parsed.lng) && parsed.lng >= -180 && parsed.lng <= 180;

    if (!latValid || !lngValid) {
      console.warn(`[GPS Validation] Discarding invalid coordinates: lat=${parsed.lat}, lng=${parsed.lng}`);
      parsed.fix = false;
    } else {
      // Sanitize numeric fields
      parsed.lat = Number(parsed.lat.toFixed(6));
      parsed.lng = Number(parsed.lng.toFixed(6));
      parsed.alt = typeof parsed.alt === 'number' && Number.isFinite(parsed.alt) ? Number(parsed.alt.toFixed(1)) : 0;
      parsed.speed = typeof parsed.speed === 'number' && Number.isFinite(parsed.speed) ? Number(parsed.speed.toFixed(2)) : 0;
      parsed.course = typeof parsed.course === 'number' && Number.isFinite(parsed.course) ? Number(parsed.course.toFixed(1)) : 0;
      parsed.sats = typeof parsed.sats === 'number' && Number.isFinite(parsed.sats) ? Math.max(0, Math.floor(parsed.sats)) : 0;
      parsed.hdop = typeof parsed.hdop === 'number' && Number.isFinite(parsed.hdop) ? Number(parsed.hdop.toFixed(2)) : null;
      parsed.chars = typeof parsed.chars === 'number' && Number.isFinite(parsed.chars) ? Math.floor(parsed.chars) : 0;

      // Add to trail history
      trailHistory.push({
        timestamp: parsed.timestamp,
        lat: parsed.lat,
        lng: parsed.lng,
        alt: parsed.alt,
        speed: parsed.speed,
        course: parsed.course,
        sats: parsed.sats,
        hdop: parsed.hdop,
        chars: parsed.chars
      });

      // Keep only up to MAX_TRAIL_POINTS
      if (trailHistory.length > MAX_TRAIL_POINTS) {
        trailHistory.shift();
      }

      // Log to session CSV
      logFixToCsv(parsed);
    }
  } else {
    // When fix is false, ensure fix flag is explicit and sats/chars are cleanly formatted
    parsed.fix = false;
    parsed.sats = typeof parsed.sats === 'number' && Number.isFinite(parsed.sats) ? Math.max(0, Math.floor(parsed.sats)) : 0;
    parsed.chars = typeof parsed.chars === 'number' && Number.isFinite(parsed.chars) ? Math.floor(parsed.chars) : 0;
  }

  latestReading = parsed;

  // Broadcast to all connected web clients
  io.emit('gps:update', parsed);

  // If valid GPS fix, resolve human-readable place name and address
  if (parsed.fix === true && typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
    reverseGeocode(parsed.lat, parsed.lng).then((addr) => {
      if (addr && addr.success) {
        latestAddress = {
          lat: parsed.lat,
          lng: parsed.lng,
          placeName: addr.placeName,
          fullAddress: addr.fullAddress,
          timestamp: new Date().toISOString()
        };
        io.emit('gps:address', latestAddress);
      }
    }).catch(() => {});
  }
}

// Internal state buffer for combining NMEA GGA + RMC sentences
const nmeaState = {
  lat: null,
  lng: null,
  alt: 0,
  speed: 0,
  course: 0,
  sats: 0,
  hdop: null,
  fix: false,
  chars: 0
};

/**
 * Converts NMEA coordinate string (DDMM.MMMM or DDDMM.MMMM) to decimal degrees.
 */
function parseNmeaCoord(val, dir) {
  if (!val || !dir) return null;
  const dotIdx = val.indexOf('.');
  if (dotIdx < 2) return null;
  const degLen = dotIdx - 2;
  const degrees = parseFloat(val.substring(0, degLen));
  const minutes = parseFloat(val.substring(degLen));
  let deg = degrees + (minutes / 60);
  if (dir === 'S' || dir === 'W') deg = -deg;
  return Number(deg.toFixed(6));
}

/**
 * Fallback parser for raw NMEA sentences ($GPRMC, $GNRMC, $GPGGA, $GNGGA).
 */
function parseNmeaLine(nmeaStr) {
  try {
    const clean = nmeaStr.split('*')[0].trim();
    const parts = clean.split(',');
    const type = (parts[0] || '').toUpperCase();
    nmeaState.chars += nmeaStr.length;

    if (type.endsWith('RMC')) {
      // $--RMC,time,status,lat,N/S,lon,E/W,speed(knots),course(deg),date,...
      const status = parts[2]; // 'A' = valid fix, 'V' = receiver warning (no fix)
      if (status === 'A') {
        const lat = parseNmeaCoord(parts[3], parts[4]);
        const lng = parseNmeaCoord(parts[5], parts[6]);
        const speedKnots = parseFloat(parts[7]) || 0;
        const speedKmh = Number((speedKnots * 1.852).toFixed(2));
        const course = parseFloat(parts[8]) || 0;

        if (lat !== null && lng !== null) {
          nmeaState.lat = lat;
          nmeaState.lng = lng;
          nmeaState.speed = speedKmh;
          nmeaState.course = Number(course.toFixed(1));
          nmeaState.fix = true;
          broadcastReading({
            fix: true,
            lat: nmeaState.lat,
            lng: nmeaState.lng,
            alt: nmeaState.alt,
            speed: nmeaState.speed,
            course: nmeaState.course,
            sats: nmeaState.sats,
            hdop: nmeaState.hdop,
            chars: nmeaState.chars
          });
        }
      } else {
        nmeaState.fix = false;
        broadcastReading({
          fix: false,
          sats: nmeaState.sats,
          chars: nmeaState.chars
        });
      }
    } else if (type.endsWith('GGA')) {
      // $--GGA,time,lat,N/S,lon,E/W,quality,sats,hdop,alt,M,...
      const quality = parseInt(parts[6], 10) || 0;
      const sats = parseInt(parts[7], 10) || 0;
      const hdop = parseFloat(parts[8]) || null;
      const alt = parseFloat(parts[9]) || 0;

      nmeaState.sats = sats;
      nmeaState.hdop = hdop;
      nmeaState.alt = alt;

      if (quality > 0) {
        const lat = parseNmeaCoord(parts[2], parts[3]);
        const lng = parseNmeaCoord(parts[4], parts[5]);
        if (lat !== null && lng !== null) {
          nmeaState.lat = lat;
          nmeaState.lng = lng;
          nmeaState.fix = true;
          broadcastReading({
            fix: true,
            lat: nmeaState.lat,
            lng: nmeaState.lng,
            alt: nmeaState.alt,
            speed: nmeaState.speed,
            course: nmeaState.course,
            sats: nmeaState.sats,
            hdop: nmeaState.hdop,
            chars: nmeaState.chars
          });
        }
      } else {
        if (!nmeaState.fix) {
          broadcastReading({
            fix: false,
            sats: nmeaState.sats,
            chars: nmeaState.chars
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[NMEA] Error parsing line "${nmeaStr}": ${err.message}`);
  }
}

/**
 * Parses and validates an incoming raw line from the serial port.
 * Safely streams lines to the web Serial Monitor, supports JSON and NMEA telemetry,
 * and handles debug messages without crashing.
 */
function handleIncomingLine(rawLine) {
  if (!rawLine) return;
  const line = rawLine.trim();
  if (!line) return;

  // Identify line type for Serial Monitor classification
  let lineType = 'debug';
  if (line.startsWith('{')) {
    lineType = 'json';
  } else if (line.startsWith('$GP') || line.startsWith('$GN') || line.startsWith('$GL') || line.startsWith('$BD')) {
    lineType = 'nmea';
  }

  // Stream raw line to connected web Serial Monitors
  addSerialLog('rx', line, lineType);

  // Parse NMEA if line starts with NMEA prefix
  if (lineType === 'nmea') {
    parseNmeaLine(line);
    return;
  }

  // Non-JSON debug logs
  if (lineType !== 'json') {
    console.log(`[ESP32 Debug]: ${line}`);
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    console.warn(`[Serial] Ignored malformed JSON line: "${line}"`);
    return;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return;
  }

  broadcastReading(parsed);
}

/**
 * Helper to identify Bluetooth serial ports (which should be skipped for auto-connect)
 */
function isBluetoothPort(port) {
  const pnp = (port.pnpId || '').toLowerCase();
  const name = (port.friendlyName || '').toLowerCase();
  const mfg = (port.manufacturer || '').toLowerCase();
  return pnp.startsWith('bthenum') || name.includes('bluetooth') || (mfg.includes('microsoft') && name.includes('bluetooth'));
}

/**
 * Checks if a detected port corresponds to an ESP32 or common USB-to-UART bridge
 */
function isEspCandidate(port) {
  if (isBluetoothPort(port)) return false;
  const vid = (port.vendorId || '').toLowerCase();
  const pnp = (port.pnpId || '').toLowerCase();
  const name = (port.friendlyName || '').toLowerCase();
  const mfg = (port.manufacturer || '').toLowerCase();

  // Common ESP32 USB-UART chip VIDs:
  // 10c4: Silicon Labs CP210x
  // 1a86: WCH CH340 / CH341
  // 0403: FTDI
  // 303a: Espressif Native USB
  // 2341: Arduino
  // 067b: Prolific
  const knownVids = ['10c4', '1a86', '0403', '303a', '2341', '067b'];
  if (knownVids.includes(vid)) return true;

  if (pnp.includes('vid_10c4') || pnp.includes('vid_1a86') || pnp.includes('vid_0403') || pnp.includes('vid_303a') || pnp.includes('vid_2341')) {
    return true;
  }

  const keywords = ['cp210', 'ch340', 'ch341', 'ftdi', 'silicon labs', 'espressif', 'uart', 'usb serial', 'usb-to-serial', 'usb-serial'];
  return keywords.some(k => name.includes(k) || mfg.includes(k));
}

/**
 * Returns formatted port list with metadata (ESP candidates vs Bluetooth).
 */
async function getSanitizedPortsList() {
  try {
    const rawPorts = await SerialPort.list();
    return rawPorts.map((p) => ({
      path: p.path,
      friendlyName: p.friendlyName || p.path,
      manufacturer: p.manufacturer || 'Unknown',
      pnpId: p.pnpId || null,
      vendorId: p.vendorId || null,
      productId: p.productId || null,
      isBluetooth: isBluetoothPort(p),
      isEspCandidate: isEspCandidate(p)
    }));
  } catch (err) {
    console.error('[Serial] Error listing ports:', err.message);
    return [];
  }
}

/**
 * Broadcasts the current list of available ports to all connected web clients.
 */
async function broadcastPortsList() {
  const ports = await getSanitizedPortsList();
  io.emit('ports:list', {
    success: true,
    currentPort: serialPortPath,
    currentBaudRate: baudRate,
    autoDetect: isAutoDetect,
    status: currentSerialStatus.status,
    ports
  });
  return ports;
}

/**
 * Smartly finds the best candidate port for the ESP32.
 */
async function autoDetectBestPort() {
  const ports = await getSanitizedPortsList();
  const physicalPorts = ports.filter(p => !p.isBluetooth);
  if (physicalPorts.length === 0) return null;

  // 1. Prioritize recognized ESP32 / USB UART adapters
  const espCandidates = physicalPorts.filter(p => p.isEspCandidate);
  if (espCandidates.length > 0) {
    // If configured port in .env matches one of the candidates, prefer it
    const matchEnv = espCandidates.find(p => p.path.toUpperCase() === (process.env.SERIAL_PORT || '').toUpperCase());
    if (matchEnv) return matchEnv;

    // If current serialPortPath is an active candidate, keep it
    const matchCurrent = espCandidates.find(p => p.path.toUpperCase() === serialPortPath.toUpperCase());
    if (matchCurrent) return matchCurrent;

    return espCandidates[0];
  }

  // 2. Any USB port that is not Bluetooth
  const usbPorts = physicalPorts.filter(p => (p.pnpId || '').toUpperCase().startsWith('USB'));
  if (usbPorts.length > 0) return usbPorts[0];

  // 3. Fallback to first non-bluetooth port
  return physicalPorts[0];
}

/**
 * Schedules a reconnection attempt to the serial port after a delay.
 */
function scheduleReconnect(delay = RECONNECT_INTERVAL_MS) {
  if (reconnectTimer) return;
  updateSerialStatus('reconnecting', isAutoDetect ? 'Searching for ESP32 USB connection...' : `Attempting reconnection in ${(delay / 1000).toFixed(0)}s...`);
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSerialPort();
  }, delay);
}

/**
 * Closes and cleans up any existing serial port instance.
 */
function cleanupSerialPort() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (parser) {
    parser.removeAllListeners();
    parser = null;
  }

  if (serialPort) {
    serialPort.removeAllListeners();
    if (serialPort.isOpen) {
      try {
        serialPort.close();
      } catch (err) {
        // ignore errors during cleanup
      }
    }
    serialPort = null;
  }
}

/**
 * Opens the serial port and sets up data listeners and auto-reconnect handlers.
 */
async function openSerialPort() {
  if (SIMULATION_MODE) {
    console.log('[Serial] SIMULATION_MODE is active. Skipping physical serial port connection.');
    updateSerialStatus('connected', `Running in Simulation Mode (virtual GPS)`);
    startSimulationFeed();
    return;
  }

  if (isConnecting) return;
  isConnecting = true;

  cleanupSerialPort();

  // If in Auto-Detect mode, scan for connected devices
  if (isAutoDetect) {
    const candidate = await autoDetectBestPort();
    if (!candidate) {
      isConnecting = false;
      updateSerialStatus('disconnected', 'Waiting for ESP32 USB cable connection...');
      broadcastPortsList();
      scheduleReconnect(2000);
      return;
    }
    serialPortPath = candidate.path;
    console.log(`[Serial Auto-Detect] Selected candidate: ${candidate.path} (${candidate.friendlyName})`);
  }

  console.log(`[Serial] Connecting to ${serialPortPath} at ${baudRate} baud (Auto-Detect=${isAutoDetect})...`);

  try {
    serialPort = new SerialPort({
      path: serialPortPath,
      baudRate: baudRate,
      autoOpen: false
    });
  } catch (err) {
    isConnecting = false;
    updateSerialStatus('error', `Failed to initialize port instance: ${err.message}`);
    broadcastPortsList();
    scheduleReconnect();
    return;
  }

  // Handle open errors
  serialPort.open((err) => {
    isConnecting = false;
    if (err) {
      let friendlyMsg = err.message;
      if (err.message.includes('Access denied')) {
        friendlyMsg = `Access denied to ${serialPortPath}. Arduino Serial Monitor, PuTTY, or another app is currently using this port. Please close it first.`;
      } else if (err.message.includes('File not found') || err.message.includes('cannot find')) {
        friendlyMsg = `Port ${serialPortPath} not found. Check USB cable and device manager.`;
      }

      updateSerialStatus('error', friendlyMsg);
      broadcastPortsList();
      scheduleReconnect();
      return;
    }

    updateSerialStatus('connected', `Connected to ${serialPortPath} at ${baudRate} baud.`);
    broadcastPortsList();

    // Pipe serial data through ReadlineParser (splits on newline, works with both \r\n and \n)
    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', handleIncomingLine);
  });

  // Handle connection errors while open
  serialPort.on('error', (err) => {
    isConnecting = false;
    updateSerialStatus('error', `Serial port error: ${err.message}`);
    broadcastPortsList();
    scheduleReconnect();
  });

  // Handle unexpected port closures (e.g., unplugged USB)
  serialPort.on('close', (err) => {
    isConnecting = false;
    const reason = err ? ` (${err.message})` : '';
    updateSerialStatus('disconnected', `Serial port disconnected${reason}. Searching for device...`);
    broadcastPortsList();
    scheduleReconnect(1500);
  });
}

// --- Optional Built-in Simulator Feed (when SIMULATION_MODE=true) ---
let simInterval = null;
function startSimulationFeed() {
  if (simInterval) clearInterval(simInterval);
  let lat = 17.385044;
  let lng = 78.486671;
  let course = 45.0;
  let chars = 1000;
  let tick = 0;

  simInterval = setInterval(() => {
    tick++;
    chars += 85;

    // Simulate 3 seconds of search before fix is acquired
    if (tick < 3) {
      handleIncomingLine(JSON.stringify({ fix: false, sats: 2, chars }));
      return;
    }

    // Move in a realistic smooth curve
    const speed = 18.5 + Math.sin(tick / 5) * 4.0; // km/h
    course = (course + 2.5) % 360;
    const rad = (course * Math.PI) / 180;
    const step = 0.00012;
    lat += Math.cos(rad) * step;
    lng += Math.sin(rad) * step;

    const simulatedPayload = JSON.stringify({
      fix: true,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      sats: 9,
      alt: 512.4 + Math.sin(tick / 10) * 8.0,
      speed: Number(speed.toFixed(2)),
      course: Number(course.toFixed(1)),
      hdop: 1.15,
      chars: chars
    });

    handleIncomingLine(simulatedPayload);
  }, 1000);
}

// --- Socket.IO Client Lifecycle ---
io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id} (total: ${io.engine.clientsCount})`);

  // Send initial state: latest reading, address, full trail history, serial port status, and recent serial logs
  socket.emit('gps:init', {
    current: latestReading,
    address: latestAddress,
    history: trailHistory,
    serialStatus: currentSerialStatus,
    config: {
      port: serialPortPath,
      baudRate: baudRate,
      autoDetect: isAutoDetect,
      maxTrailPoints: MAX_TRAIL_POINTS
    },
    serialLogs: serialLogHistory.slice(-200)
  });

  // Provide initial serial log history directly
  socket.emit('serial:history', serialLogHistory.slice(-200));

  // Provide available ports right away to new web clients
  getSanitizedPortsList().then((ports) => {
    socket.emit('ports:list', {
      success: true,
      currentPort: serialPortPath,
      currentBaudRate: baudRate,
      autoDetect: isAutoDetect,
      status: currentSerialStatus.status,
      ports
    });
  });

  // Client sends data to ESP32 over serial port
  socket.on('serial:send', async (payload, callback) => {
    const text = typeof payload === 'object' && payload !== null ? payload.data : payload;
    const lineEnding = typeof payload === 'object' && payload !== null && payload.lineEnding !== undefined ? payload.lineEnding : '\r\n';

    if (text === undefined || text === null) {
      if (typeof callback === 'function') callback({ success: false, error: 'No data provided.' });
      return;
    }

    try {
      await writeToSerial(text, lineEnding);
      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // Client requests clearing the serial monitor log buffer
  socket.on('serial:clear', () => {
    serialLogHistory.length = 0;
    io.emit('serial:cleared', { timestamp: new Date().toISOString() });
    console.log(`[Socket.IO] Serial logs cleared by client ${socket.id}`);
  });

  // Client requests baud rate change
  socket.on('serial:set-baud', (newBaud) => {
    const rate = parseInt(newBaud, 10);
    if (rate > 0 && rate !== baudRate) {
      console.log(`[Serial] Changing baud rate from ${baudRate} to ${rate}...`);
      baudRate = rate;
      openSerialPort();
    }
  });

  // Client requests trail history reset
  socket.on('trail:clear', () => {
    trailHistory.length = 0;
    io.emit('gps:trail-cleared', { timestamp: new Date().toISOString() });
    console.log(`[Socket.IO] Trail cleared by client ${socket.id}`);
  });

  // Client requests manual serial reconnect or rescan
  socket.on('serial:reconnect', () => {
    console.log(`[Socket.IO] Manual reconnect requested by ${socket.id}`);
    openSerialPort();
  });

  // Client requests fresh port scan
  socket.on('ports:refresh', () => {
    broadcastPortsList();
  });

  // Client requests port switch via socket
  socket.on('serial:select-port', (data) => {
    if (data?.auto === true || data?.port === 'auto') {
      isAutoDetect = true;
      openSerialPort();
    } else if (data?.port) {
      isAutoDetect = false;
      serialPortPath = data.port;
      if (data.baud) baudRate = Number(data.baud);
      openSerialPort();
    }
  });

  // Support incoming mock/simulated streams for testing
  socket.on('gps:mock-stream', (mockPayload) => {
    handleIncomingLine(JSON.stringify(mockPayload));
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id} (total: ${io.engine.clientsCount})`);
  });
});

// --- REST API Endpoints ---

/**
 * POST /api/serial/send
 * Sends text or commands to the device over the active serial port.
 */
app.post('/api/serial/send', async (req, res) => {
  const { data, lineEnding } = req.body;
  if (data === undefined || data === null) {
    return res.status(400).json({ success: false, error: 'Field "data" is required.' });
  }

  try {
    await writeToSerial(data, lineEnding !== undefined ? lineEnding : '\r\n');
    res.json({ success: true, message: 'Command sent to serial port.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/serial/logs
 * Returns buffered recent serial logs.
 */
app.get('/api/serial/logs', (req, res) => {
  res.json({
    success: true,
    count: serialLogHistory.length,
    logs: serialLogHistory
  });
});

/**
 * POST /api/serial/clear
 * Clears buffered serial logs.
 */
app.post('/api/serial/clear', (req, res) => {
  serialLogHistory.length = 0;
  io.emit('serial:cleared', { timestamp: new Date().toISOString() });
  res.json({ success: true, message: 'Serial log history cleared.' });
});

/**
 * GET /api/geocode/reverse
 * Reverse geocodes coordinates to a place name and full address.
 */
app.get('/api/geocode/reverse', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ success: false, error: 'Valid "lat" and "lng" query parameters required.' });
  }

  try {
    const result = await reverseGeocode(lat, lng);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/geocode/search
 * Autocomplete search for places, POIs, addresses, and landmarks.
 */
app.get('/api/geocode/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (!q) {
    return res.json({ success: true, results: [] });
  }

  let photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8`;
  if (!isNaN(lat) && !isNaN(lng)) {
    photonUrl += `&lat=${lat}&lon=${lng}`;
  }

  const clientReq = https.get(photonUrl, { headers: { 'User-Agent': 'HinaMaps-Dashboard/2.0' }, timeout: 5000 }, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        const results = (json.features || []).map(f => {
          const p = f.properties || {};
          const coords = f.geometry ? f.geometry.coordinates : [0, 0];
          const parts = [p.name, p.street, p.locality, p.district, p.city, p.state, p.country].filter(Boolean);
          return {
            name: p.name || p.street || 'Place',
            description: parts.join(', '),
            lat: coords[1],
            lng: coords[0],
            osmType: p.osm_type,
            osmValue: p.osm_value,
            postcode: p.postcode
          };
        });
        res.json({ success: true, results });
      } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to parse search response' });
      }
    });
  });

  clientReq.on('timeout', () => {
    clientReq.destroy();
    res.status(504).json({ success: false, error: 'Search request timed out' });
  });

  clientReq.on('error', (err) => {
    res.status(502).json({ success: false, error: err.message });
  });
});

/**
 * GET /api/routing/route
 * Turn-by-turn driving directions with maneuvers, alternatives, and ETA via OSRM.
 */
app.get('/api/routing/route', (req, res) => {
  const startLng = parseFloat(req.query.startLng);
  const startLat = parseFloat(req.query.startLat);
  const endLng = parseFloat(req.query.endLng);
  const endLat = parseFloat(req.query.endLat);
  const alternatives = req.query.alternatives === 'true';

  if (isNaN(startLng) || isNaN(startLat) || isNaN(endLng) || isNaN(endLat)) {
    return res.status(400).json({ success: false, error: 'Valid startLng, startLat, endLng, endLat required.' });
  }

  const osrmUrl = `https://routing.openstreetmap.de/routed-car/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives}`;

  const clientReq = https.get(osrmUrl, { headers: { 'User-Agent': 'HinaMaps-Navigation/2.0' }, timeout: 7000 }, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.code !== 'Ok' || !json.routes || json.routes.length === 0) {
          return res.status(404).json({ success: false, error: 'No route found between coordinates.' });
        }
        const routes = json.routes.map(r => {
          const steps = (r.legs || []).flatMap(leg => (leg.steps || []).map(step => {
            let instruction = '';
            const m = step.maneuver || {};
            const type = m.type || 'turn';
            const mod = m.modifier || '';
            const roadName = step.name || '';

            if (type === 'depart') {
              instruction = roadName ? `Head out onto ${roadName}` : 'Depart on route';
            } else if (type === 'arrive') {
              instruction = 'You have arrived at your destination';
            } else if (type === 'turn') {
              instruction = `Turn ${mod || 'right'}${roadName ? ' onto ' + roadName : ''}`;
            } else if (type === 'new name') {
              instruction = roadName ? `Continue onto ${roadName}` : 'Continue on current road';
            } else if (type === 'end of road') {
              instruction = `Turn ${mod || 'right'} at the end of the road${roadName ? ' onto ' + roadName : ''}`;
            } else if (type === 'roundabout' || type === 'rotary') {
              instruction = `At the roundabout, take exit ${m.exit || 1}${roadName ? ' onto ' + roadName : ''}`;
            } else if (type === 'fork') {
              instruction = `Keep ${mod || 'right'} at the fork${roadName ? ' onto ' + roadName : ''}`;
            } else {
              instruction = `${type} ${mod}${roadName ? ' onto ' + roadName : ''}`.trim();
            }

            return {
              instruction: instruction.charAt(0).toUpperCase() + instruction.slice(1),
              distance: step.distance,
              duration: step.duration,
              location: m.location || null,
              maneuver: m,
              name: roadName
            };
          }));

          return {
            distance: r.distance, // meters
            duration: r.duration, // seconds
            geometry: r.geometry, // GeoJSON LineString
            steps: steps,
            legs: r.legs,
            weight_name: r.weight_name
          };
        });

        res.json({
          success: true,
          routes: routes
        });
      } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to parse routing response' });
      }
    });
  });

  clientReq.on('timeout', () => {
    clientReq.destroy();
    res.status(504).json({ success: false, error: 'Routing request timed out' });
  });

  clientReq.on('error', (err) => {
    res.status(502).json({ success: false, error: err.message });
  });
});

/**
 * GET /api/routing/nearest
 * Snaps a GPS coordinate to the closest drivable road segment.
 */
app.get('/api/routing/nearest', (req, res) => {
  const lng = parseFloat(req.query.lng);
  const lat = parseFloat(req.query.lat);

  if (isNaN(lng) || isNaN(lat)) {
    return res.status(400).json({ success: false, error: 'Valid lng and lat required.' });
  }

  const osrmUrl = `https://routing.openstreetmap.de/routed-car/nearest/v1/driving/${lng},${lat}?number=1`;

  const clientReq = https.get(osrmUrl, { headers: { 'User-Agent': 'HinaMaps-RoadMatching/2.0' }, timeout: 4000 }, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.code === 'Ok' && json.waypoints && json.waypoints.length > 0) {
          const wp = json.waypoints[0];
          return res.json({
            success: true,
            snappedLng: wp.location[0],
            snappedLat: wp.location[1],
            roadName: wp.name || '',
            distance: wp.distance
          });
        }
        res.json({ success: false, error: 'No road found nearby' });
      } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to parse nearest road response' });
      }
    });
  });

  clientReq.on('timeout', () => {
    clientReq.destroy();
    res.status(504).json({ success: false, error: 'Nearest road request timed out' });
  });

  clientReq.on('error', (err) => {
    res.status(502).json({ success: false, error: err.message });
  });
});

/**
 * GET /api/ports
 * Lists available serial ports detected on the system.
 */
app.get('/api/ports', async (req, res) => {
  try {
    const ports = await getSanitizedPortsList();
    res.json({
      success: true,
      currentPort: serialPortPath,
      currentBaudRate: baudRate,
      autoDetect: isAutoDetect,
      status: currentSerialStatus.status,
      ports
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/ports/select
 * Changes the active serial port and baud rate on the fly, or toggles auto-detect.
 */
app.post('/api/ports/select', (req, res) => {
  const { port, baud, auto } = req.body;

  if (auto === true || port === 'auto') {
    isAutoDetect = true;
    console.log('[Serial] Switching to Auto-Detect mode by client request...');
    openSerialPort();
    return res.json({
      success: true,
      message: 'Auto-detect mode active. Scanning for ESP32...',
      autoDetect: true,
      serialStatus: currentSerialStatus
    });
  }

  if (!port) {
    return res.status(400).json({ success: false, error: 'Port path is required.' });
  }

  isAutoDetect = false;
  serialPortPath = port;
  if (baud && Number.isInteger(Number(baud))) {
    baudRate = Number(baud);
  }

  console.log(`[Serial] Switching to manual port ${serialPortPath} at ${baudRate} baud...`);
  openSerialPort();

  res.json({
    success: true,
    message: `Switching to ${serialPortPath} at ${baudRate} baud.`,
    autoDetect: false,
    serialStatus: currentSerialStatus
  });
});

/**
 * GET /api/status
 * Returns server diagnostics and active GPS telemetry state.
 */
app.get('/api/status', (req, res) => {
  res.json({
    serial: currentSerialStatus,
    clientsConnected: io.engine.clientsCount,
    trailPointsCount: trailHistory.length,
    latestReading: latestReading,
    logFile: sessionCsvPath
  });
});

/**
 * POST /api/trail/clear
 * Clears the in-memory recorded track.
 */
app.post('/api/trail/clear', (req, res) => {
  trailHistory.length = 0;
  io.emit('gps:trail-cleared', { timestamp: new Date().toISOString() });
  res.json({ success: true, message: 'Trail history cleared.' });
});

/**
 * GET /api/export.csv
 * Downloads the current recorded GPS track as a CSV file.
 */
app.get('/api/export.csv', (req, res) => {
  const downloadFileName = `gps_track_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"`);

  let csvContent = CSV_HEADER;
  for (const pt of trailHistory) {
    csvContent += `"${pt.timestamp}",${pt.lat},${pt.lng},${pt.alt ?? ''},${pt.speed ?? ''},${pt.course ?? ''},${pt.sats ?? 0},${pt.hdop ?? ''},${pt.chars ?? 0}\n`;
  }

  res.send(csvContent);
});

/**
 * GET /api/export.gpx or /api/export/gpx
 * Exports the active GPS track in standard GPX XML format for GPS devices and GIS apps.
 */
function handleGpxExport(req, res) {
  const downloadFileName = `hina_maps_track_${new Date().toISOString().replace(/[:.]/g, '-')}.gpx`;
  res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"`);

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  gpx += `<gpx version="1.1" creator="Hina Maps" xmlns="http://www.topografix.com/GPX/1/1">\n`;
  gpx += `  <metadata>\n    <name>Hina Maps Track Log</name>\n    <time>${new Date().toISOString()}</time>\n  </metadata>\n`;
  gpx += `  <trk>\n    <name>Live Track</name>\n    <trkseg>\n`;

  for (const pt of trailHistory) {
    gpx += `      <trkpt lat="${pt.lat}" lon="${pt.lng}">\n`;
    if (pt.alt !== null && pt.alt !== undefined) gpx += `        <ele>${pt.alt}</ele>\n`;
    if (pt.timestamp) gpx += `        <time>${pt.timestamp}</time>\n`;
    if (pt.speed !== null && pt.speed !== undefined) gpx += `        <speed>${(pt.speed / 3.6).toFixed(2)}</speed>\n`;
    if (pt.sats !== null && pt.sats !== undefined) gpx += `        <sat>${pt.sats}</sat>\n`;
    if (pt.hdop !== null && pt.hdop !== undefined) gpx += `        <hdop>${pt.hdop}</hdop>\n`;
    gpx += `      </trkpt>\n`;
  }

  gpx += `    </trkseg>\n  </trk>\n</gpx>`;
  res.send(gpx);
}

app.get('/api/export.gpx', handleGpxExport);
app.get('/api/export/gpx', handleGpxExport);

/**
 * GET /api/export.geojson or /api/export/geojson
 * Exports the active GPS track in standard GeoJSON format.
 */
function handleGeoJsonExport(req, res) {
  const downloadFileName = `hina_maps_track_${new Date().toISOString().replace(/[:.]/g, '-')}.geojson`;
  res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"`);

  const coordinates = trailHistory.map(pt => [pt.lng, pt.lat, pt.alt || 0]);
  const geojson = {
    type: 'FeatureCollection',
    name: 'Hina Maps GPS Track',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Hina Maps Live Track',
          pointCount: trailHistory.length,
          startTime: trailHistory[0]?.timestamp || null,
          endTime: trailHistory[trailHistory.length - 1]?.timestamp || null
        },
        geometry: {
          type: 'LineString',
          coordinates: coordinates
        }
      }
    ]
  };

  res.json(geojson);
}

app.get('/api/export.geojson', handleGeoJsonExport);
app.get('/api/export/geojson', handleGeoJsonExport);

// --- Server Startup ---
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  ESP32 GPS Real-Time Dashboard`);
  console.log(`  Web Dashboard:   http://localhost:${PORT}`);
  console.log(`  Serial Mode:     ${isAutoDetect ? 'Smart Auto-Discovery (Plug & Play)' : `${serialPortPath} @ ${baudRate} baud (Manual)`}`);
  console.log(`  Trail Depth:     ${MAX_TRAIL_POINTS} points`);
  console.log(`  Session CSV Log: ${sessionCsvPath}`);
  console.log(`=======================================================`);

  // Initiate serial connection
  openSerialPort();
});

// Graceful process shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down gracefully...');
  cleanupSerialPort();
  if (simInterval) clearInterval(simInterval);
  server.close(() => {
    console.log('[Server] Server closed.');
    process.exit(0);
  });
});
