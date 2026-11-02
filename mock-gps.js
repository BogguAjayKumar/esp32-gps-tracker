/**
 * Mock GPS Streamer / Test Utility
 * Simulates an ESP32 sending GPS telemetry over Socket.IO or stdout.
 * Useful for testing the frontend UI, animations, and telemetry cards
 * without needing physical satellite reception or USB hardware attached.
 * 
 * Usage:
 *   node mock-gps.js
 */

const { io } = require('socket.io-client');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
console.log(`[Mock GPS] Connecting to server at ${SERVER_URL}...`);

const socket = io(SERVER_URL);

// Base center: Hyderabad, India (from user prompt: 17.385044, 78.486671)
let lat = 17.385044;
let lng = 78.486671;
let speed = 25.4; // km/h
let course = 45.0; // degrees
let alt = 505.2; // meters
let sats = 8;
let hdop = 1.18;
let chars = 12000;
let step = 0;

socket.on('connect', () => {
  console.log(`[Mock GPS] Connected to server! Emitting simulated GPS stream every 1s...`);
});

socket.on('disconnect', () => {
  console.log('[Mock GPS] Disconnected from server.');
});

// Stream telemetry every second
setInterval(() => {
  step++;
  chars += 82;

  // Simulate a realistic driving route (smooth curves)
  course = (course + (Math.sin(step / 4) * 5) + 360) % 360;
  const headingRad = (course * Math.PI) / 180;
  
  // Approximate delta for ~25 km/h
  const deltaCoord = 0.00008;
  lat += Math.cos(headingRad) * deltaCoord;
  lng += Math.sin(headingRad) * deltaCoord;
  
  speed = Math.max(5.0, 24.0 + Math.sin(step / 3) * 6.5);
  alt = 505.0 + Math.sin(step / 10) * 12.0;
  hdop = 1.05 + Math.abs(Math.sin(step / 7)) * 0.4;
  sats = 8 + Math.floor(Math.sin(step / 15) * 3);

  const payload = {
    fix: true,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    sats: sats,
    alt: Number(alt.toFixed(1)),
    speed: Number(speed.toFixed(2)),
    course: Number(course.toFixed(1)),
    hdop: Number(hdop.toFixed(2)),
    chars: chars,
    timestamp: new Date().toISOString()
  };

  // Broadcast to server or print
  socket.emit('gps:mock-stream', payload);
  console.log(`[Mock GPS #${step}] Fix: ${payload.lat}, ${payload.lng} | Speed: ${payload.speed} km/h | Sats: ${payload.sats} | Chars: ${payload.chars}`);
}, 1000);
