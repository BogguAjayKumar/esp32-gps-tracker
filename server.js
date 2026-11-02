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
const MAX_TRAIL_POINTS = parseInt(process.env.MAX_TRAIL_POINTS || '500', 10);
const RECONNECT_INTERVAL_MS = parseInt(process.env.RECONNECT_INTERVAL_MS || '3000', 10);
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
const trailHistory = []; // Ring-buffer of valid fix points

let serialPort = null;
let parser = null;
let reconnectTimer = null;
let currentSerialStatus = {
  status: 'disconnected', // 'connected' | 'disconnected' | 'error' | 'reconnecting'
  port: serialPortPath,
  baudRate: baudRate,
  message: 'Initializing...',
  timestamp: new Date().toISOString()
};

/**
 * Updates the current serial status and broadcasts it to all connected Socket.IO clients.
 */
function updateSerialStatus(status, message) {
  currentSerialStatus = {
    status,
    port: serialPortPath,
    baudRate: baudRate,
    message,
    timestamp: new Date().toISOString()
  };
  io.emit('serial:status', currentSerialStatus);
  console.log(`[Serial Status] ${status.toUpperCase()} (${serialPortPath}): ${message}`);
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
 * Parses and validates an incoming raw line from the serial port.
 * Safely ignores debug text and invalid JSON without crashing.
 */
function handleIncomingLine(rawLine) {
  if (!rawLine) return;
  const line = rawLine.trim();

  // ESP32 debug or non-JSON logs (e.g., "# ESP32 GPS streamer started") must be ignored
  if (!line.startsWith('{')) {
    // Log debug lines to console for developer visibility
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
}

/**
 * Schedules a reconnection attempt to the serial port after a delay.
 */
function scheduleReconnect(delay = RECONNECT_INTERVAL_MS) {
  if (reconnectTimer) return;
  updateSerialStatus('reconnecting', `Attempting reconnection in ${(delay / 1000).toFixed(0)}s...`);
  
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
function openSerialPort() {
  if (SIMULATION_MODE) {
    console.log('[Serial] SIMULATION_MODE is active. Skipping physical serial port connection.');
    updateSerialStatus('connected', `Running in Simulation Mode (virtual GPS)`);
    startSimulationFeed();
    return;
  }

  cleanupSerialPort();

  console.log(`[Serial] Connecting to ${serialPortPath} at ${baudRate} baud...`);

  try {
    serialPort = new SerialPort({
      path: serialPortPath,
      baudRate: baudRate,
      autoOpen: false
    });
  } catch (err) {
    updateSerialStatus('error', `Failed to initialize port instance: ${err.message}`);
    scheduleReconnect();
    return;
  }

  // Handle open errors
  serialPort.open((err) => {
    if (err) {
      let friendlyMsg = err.message;
      if (err.message.includes('Access denied')) {
        friendlyMsg = `Access denied to ${serialPortPath}. Arduino Serial Monitor, PuTTY, or another app is currently using this port. Please close it first.`;
      } else if (err.message.includes('File not found') || err.message.includes('cannot find')) {
        friendlyMsg = `Port ${serialPortPath} not found. Check USB cable and device manager.`;
      }

      updateSerialStatus('error', friendlyMsg);
      scheduleReconnect();
      return;
    }

    updateSerialStatus('connected', `Connected to ${serialPortPath} at ${baudRate} baud.`);

    // Pipe serial data through ReadlineParser (splits on newline, works with both \r\n and \n)
    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', handleIncomingLine);
  });

  // Handle connection errors while open
  serialPort.on('error', (err) => {
    updateSerialStatus('error', `Serial port error: ${err.message}`);
    scheduleReconnect();
  });

  // Handle unexpected port closures (e.g., unplugged USB)
  serialPort.on('close', (err) => {
    const reason = err ? ` (${err.message})` : '';
    updateSerialStatus('disconnected', `Serial port closed${reason}. Reconnecting...`);
    scheduleReconnect();
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

  // Send initial state: latest reading, full trail history, and serial port status
  socket.emit('gps:init', {
    current: latestReading,
    history: trailHistory,
    serialStatus: currentSerialStatus,
    config: {
      port: serialPortPath,
      baudRate: baudRate,
      maxTrailPoints: MAX_TRAIL_POINTS
    }
  });

  // Client requests trail history reset
  socket.on('trail:clear', () => {
    trailHistory.length = 0;
    io.emit('gps:trail-cleared', { timestamp: new Date().toISOString() });
    console.log(`[Socket.IO] Trail cleared by client ${socket.id}`);
  });

  // Client requests manual serial reconnect
  socket.on('serial:reconnect', () => {
    console.log(`[Socket.IO] Manual reconnect requested by ${socket.id}`);
    openSerialPort();
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
 * GET /api/ports
 * Lists available serial ports detected on the system.
 */
app.get('/api/ports', async (req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json({
      success: true,
      currentPort: serialPortPath,
      currentBaudRate: baudRate,
      ports: ports.map((p) => ({
        path: p.path,
        friendlyName: p.friendlyName || p.path,
        manufacturer: p.manufacturer || 'Unknown',
        pnpId: p.pnpId || null
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/ports/select
 * Changes the active serial port and baud rate on the fly.
 */
app.post('/api/ports/select', (req, res) => {
  const { port, baud } = req.body;
  if (!port) {
    return res.status(400).json({ success: false, error: 'Port path is required.' });
  }

  serialPortPath = port;
  if (baud && Number.isInteger(Number(baud))) {
    baudRate = Number(baud);
  }

  console.log(`[Serial] Switching to port ${serialPortPath} at ${baudRate} baud...`);
  openSerialPort();

  res.json({
    success: true,
    message: `Switching to ${serialPortPath} at ${baudRate} baud.`,
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

// --- Server Startup ---
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  ESP32 GPS Real-Time Dashboard`);
  console.log(`  Web Dashboard:   http://localhost:${PORT}`);
  console.log(`  Target Port:     ${serialPortPath} @ ${baudRate} baud`);
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
