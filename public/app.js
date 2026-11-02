/**
 * Real-Time GPS Tracking Dashboard - Client Application
 * Communicates with the Node.js backend over Socket.IO and renders
 * high-performance Leaflet maps, live telemetry cards, and diagnostics.
 */

(function () {
  'use strict';

  // --- Safe Storage Utilities (Never throws if localStorage is unavailable) ---
  function safeStorageGet(key, fallback) {
    try {
      const val = localStorage.getItem(key);
      return val !== null ? val : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      // Storage unavailable or disabled
    }
  }

  // --- State Variables ---
  let autoFollow = true;
  let totalDistanceKm = 0;
  let totalFixPoints = 0;
  let lastPoint = null;
  let lastFixTimestamp = null;
  let zeroCharsCounter = 0;
  let currentTheme = safeStorageGet('gps_theme', 'dark');

  // --- DOM Elements ---
  const elHtml = document.documentElement;
  const badgeServer = document.getElementById('badge-server');
  const badgeSerial = document.getElementById('badge-serial');
  const badgeFix = document.getElementById('badge-fix');
  const alertBanner = document.getElementById('wiring-alert-banner');
  const btnCloseAlert = document.getElementById('btn-close-alert');

  const btnAutoFollow = document.getElementById('btn-autofollow');
  const btnRecenter = document.getElementById('btn-recenter');
  const btnClearTrail = document.getElementById('btn-clear-trail');
  const btnThemeToggle = document.getElementById('btn-theme-toggle');
  const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  const telemetryPanel = document.getElementById('telemetry-panel');
  const selectSerialPort = document.getElementById('select-serial-port');

  // Telemetry metric elements
  const valLat = document.getElementById('val-lat');
  const valLng = document.getElementById('val-lng');
  const valSpeed = document.getElementById('val-speed');
  const valSpeedAlt = document.getElementById('val-speed-alt');
  const valAlt = document.getElementById('val-alt');
  const valAltFt = document.getElementById('val-alt-ft');
  const valCourse = document.getElementById('val-course');
  const valCardinal = document.getElementById('val-cardinal');
  const compassNeedle = document.getElementById('compass-needle');
  const valSats = document.getElementById('val-sats');
  const satBar = document.getElementById('sat-bar');
  const valHdop = document.getElementById('val-hdop');
  const hdopRating = document.getElementById('hdop-rating');
  const valChars = document.getElementById('val-chars');
  const valTrailCount = document.getElementById('val-trail-count');
  const valDistance = document.getElementById('val-distance');
  const lastUpdateTime = document.getElementById('last-update-time');
  const floatingCoords = document.getElementById('floating-coords');
  const floatingSpeed = document.getElementById('floating-speed');

  // --- Theme Management ---
  function applyTheme(theme) {
    currentTheme = theme;
    elHtml.setAttribute('data-theme', theme);
    safeStorageSet('gps_theme', theme);

    if (tileLayer && map) {
      map.removeLayer(tileLayer);
      tileLayer = getTileLayer(theme);
      tileLayer.addTo(map);
    }
  }

  // --- Leaflet Map Initialization ---
  const DEFAULT_LAT = 17.385044;
  const DEFAULT_LNG = 78.486671;
  const DEFAULT_ZOOM = 16;

  function getTileLayer(theme) {
    if (theme === 'dark') {
      return L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
      });
    } else {
      return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
        maxZoom: 19
      });
    }
  }

  const map = L.map('map', {
    zoomControl: false,
    attributionControl: true
  }).setView([DEFAULT_LAT, DEFAULT_LNG], DEFAULT_ZOOM);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  let tileLayer = getTileLayer(currentTheme);
  tileLayer.addTo(map);
  applyTheme(currentTheme);

  // Custom GPS Directional Marker Icon
  function createMarkerIcon(courseDeg = 0) {
    return L.divIcon({
      className: 'gps-custom-marker-wrapper',
      html: `
        <div class="gps-custom-marker">
          <div class="marker-beacon">
            <div class="marker-heading-arrow" style="transform: rotate(${courseDeg}deg);"></div>
          </div>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
  }

  let gpsMarker = L.marker([DEFAULT_LAT, DEFAULT_LNG], {
    icon: createMarkerIcon(0),
    title: 'GPS Target'
  }).addTo(map);

  // Traveled Path Polyline
  const trailPolyline = L.polyline([], {
    color: '#06b6d4',
    weight: 4,
    opacity: 0.85,
    lineJoin: 'round',
    lineCap: 'round',
    smoothFactor: 1.0
  }).addTo(map);

  // Distance helper (Haversine formula in km)
  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's mean radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // Cardinal direction compass lookup
  function getCardinalDirection(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return 'Unknown';
    const directions = [
      'N (North)', 'NNE (North-North-East)', 'NE (North-East)', 'ENE (East-North-East)',
      'E (East)', 'ESE (East-South-East)', 'SE (South-East)', 'SSE (South-South-East)',
      'S (South)', 'SSW (South-South-West)', 'SW (South-West)', 'WSW (West-South-West)',
      'W (West)', 'WNW (West-North-West)', 'NW (North-West)', 'NNW (North-North-West)'
    ];
    const index = Math.round((deg % 360) / 22.5) % 16;
    return directions[index];
  }

  // HDOP precision evaluation
  function getHdopQuality(hdop) {
    if (hdop === null || hdop === undefined || isNaN(hdop)) {
      return { text: 'Waiting', className: 'badge-neutral' };
    }
    if (hdop <= 1.0) return { text: 'Ideal (<1)', className: 'badge-ideal' };
    if (hdop <= 2.0) return { text: 'Excellent (1-2)', className: 'badge-ideal' };
    if (hdop <= 5.0) return { text: 'Good (2-5)', className: 'badge-good' };
    if (hdop <= 10.0) return { text: 'Moderate (5-10)', className: 'badge-moderate' };
    return { text: 'Poor (>10)', className: 'badge-poor' };
  }

  // --- UI Update Helpers ---

  function updateServerBadge(status, text) {
    const dot = badgeServer.querySelector('.status-dot');
    const label = badgeServer.querySelector('.status-text');
    dot.className = 'status-dot';

    if (status === 'connected') {
      dot.classList.add('dot-green');
      label.textContent = text || 'Server: Online';
    } else if (status === 'connecting') {
      dot.classList.add('dot-yellow', 'pulse');
      label.textContent = text || 'Server: Connecting...';
    } else {
      dot.classList.add('dot-red');
      label.textContent = text || 'Server: Offline';
    }
  }

  function updateSerialBadge(statusObj) {
    const dot = badgeSerial.querySelector('.status-dot');
    const label = badgeSerial.querySelector('.status-text');
    dot.className = 'status-dot';

    const portName = statusObj.port || 'Serial';

    if (statusObj.status === 'connected') {
      dot.classList.add('dot-green');
      label.textContent = `${portName} (${statusObj.baudRate || 115200})`;
      badgeSerial.title = statusObj.message || 'Serial port connected';
    } else if (statusObj.status === 'reconnecting') {
      dot.classList.add('dot-yellow', 'pulse');
      label.textContent = `${portName}: Reconnecting...`;
      badgeSerial.title = statusObj.message;
    } else if (statusObj.status === 'error') {
      dot.classList.add('dot-red');
      const isAccessDenied = (statusObj.message || '').includes('Access denied');
      label.textContent = isAccessDenied ? `${portName}: Busy` : `${portName}: Error`;
      badgeSerial.title = statusObj.message;
    } else {
      dot.classList.add('dot-gray');
      label.textContent = `${portName}: Disconnected`;
      badgeSerial.title = statusObj.message || 'Disconnected';
    }
  }

  function updateFixBadge(hasFix) {
    const dot = badgeFix.querySelector('.status-dot');
    const label = badgeFix.querySelector('.status-text');
    dot.className = 'status-dot';

    if (hasFix) {
      dot.classList.add('dot-green');
      label.textContent = 'Fix Acquired (3D)';
    } else {
      dot.classList.add('dot-yellow', 'pulse');
      label.textContent = 'Searching for satellites...';
    }
  }

  function checkWiringAlert(chars) {
    if (chars === 0) {
      zeroCharsCounter++;
      // If chars remains 0 after 2 consecutive updates, show warning
      if (zeroCharsCounter >= 2) {
        alertBanner.classList.remove('hidden');
      }
    } else {
      zeroCharsCounter = 0;
      alertBanner.classList.add('hidden');
    }
  }

  // --- Live Data Ingestion ---

  function processGpsData(data) {
    if (!data) return;

    lastFixTimestamp = new Date();
    checkWiringAlert(data.chars ?? 0);

    // Update Common fields
    valSats.textContent = data.sats ?? 0;
    const satPercent = Math.min(100, Math.round(((data.sats ?? 0) / 12) * 100));
    satBar.style.width = `${satPercent}%`;
    valChars.textContent = Number(data.chars ?? 0).toLocaleString();

    if (data.fix === true && typeof data.lat === 'number' && typeof data.lng === 'number') {
      updateFixBadge(true);

      const lat = data.lat;
      const lng = data.lng;
      const speedKmh = data.speed ?? 0;
      const speedMph = (speedKmh * 0.621371).toFixed(1);
      const speedKnots = (speedKmh * 0.539957).toFixed(1);
      const altM = data.alt ?? 0;
      const altFt = (altM * 3.28084).toFixed(1);
      const courseDeg = data.course ?? 0;
      const hdopVal = data.hdop;

      // Update Coordinates Card
      valLat.textContent = `${lat.toFixed(6)}° ${lat >= 0 ? 'N' : 'S'}`;
      valLng.textContent = `${lng.toFixed(6)}° ${lng >= 0 ? 'E' : 'W'}`;

      // Update Speed Card
      valSpeed.textContent = speedKmh.toFixed(1);
      valSpeedAlt.textContent = `${speedMph} mph • ${speedKnots} kn`;

      // Update Altitude Card
      valAlt.textContent = altM.toFixed(1);
      valAltFt.textContent = `${altFt} ft elevation`;

      // Update Course & Compass
      valCourse.textContent = `${courseDeg.toFixed(1)}°`;
      valCardinal.textContent = getCardinalDirection(courseDeg);
      compassNeedle.style.transform = `rotate(${courseDeg}deg)`;

      // Update HDOP Precision Card
      if (hdopVal !== null && hdopVal !== undefined) {
        valHdop.textContent = Number(hdopVal).toFixed(2);
        const hdopInfo = getHdopQuality(hdopVal);
        hdopRating.textContent = hdopInfo.text;
        hdopRating.className = `hdop-badge ${hdopInfo.className}`;
      }

      // Update Floating Top-Right Badges
      floatingCoords.textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      floatingSpeed.textContent = `${speedKmh.toFixed(1)} km/h`;

      // Update Leaflet Marker position and heading arrow rotation
      gpsMarker.setLatLng([lat, lng]);
      gpsMarker.setIcon(createMarkerIcon(courseDeg));

      // Append point to polyline
      trailPolyline.addLatLng([lat, lng]);
      totalFixPoints++;
      valTrailCount.textContent = totalFixPoints;

      // Accumulate distance
      if (lastPoint) {
        const delta = haversineDistance(lastPoint.lat, lastPoint.lng, lat, lng);
        // Discard excessive GPS jumps (> 150 km/h noise)
        if (delta < 0.2) {
          totalDistanceKm += delta;
          valDistance.textContent = `${totalDistanceKm.toFixed(2)} km`;
        }
      }
      lastPoint = { lat, lng };

      // Auto-follow pan
      if (autoFollow) {
        map.panTo([lat, lng], { animate: true, duration: 0.6 });
      }

    } else {
      // Fix is false
      updateFixBadge(false);
      floatingCoords.textContent = 'Searching...';
      valSpeed.textContent = '0.0';
      valSpeedAlt.textContent = '0.0 mph • 0.0 kn';
      valCourse.textContent = '0.0°';
      valCardinal.textContent = 'Searching satellites';
      valHdop.textContent = '--';
      hdopRating.textContent = 'No Fix';
      hdopRating.className = 'hdop-badge badge-neutral';
    }
  }

  // --- Relative Timestamp Ticker ---
  setInterval(() => {
    if (!lastFixTimestamp) {
      lastUpdateTime.textContent = 'Waiting for data...';
      return;
    }
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - lastFixTimestamp.getTime()) / 1000));
    if (elapsedSeconds === 0) {
      lastUpdateTime.textContent = 'Updated just now';
    } else if (elapsedSeconds === 1) {
      lastUpdateTime.textContent = 'Updated 1s ago';
    } else {
      lastUpdateTime.textContent = `Updated ${elapsedSeconds}s ago`;
    }
  }, 1000);

  // --- Fetch Available Serial Ports ---
  async function loadSerialPorts() {
    try {
      const response = await fetch('/api/ports');
      const data = await response.json();
      if (!data.success || !Array.isArray(data.ports)) return;

      selectSerialPort.innerHTML = '';
      data.ports.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = `${p.path} (${p.friendlyName || p.manufacturer || 'Serial Device'})`;
        if (p.path === data.currentPort) {
          opt.selected = true;
        }
        selectSerialPort.appendChild(opt);
      });
    } catch (err) {
      console.warn('Could not load serial ports:', err.message);
    }
  }

  // Port switch change handler
  selectSerialPort.addEventListener('change', async () => {
    const selectedPort = selectSerialPort.value;
    if (!selectedPort) return;
    try {
      await fetch('/api/ports/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: selectedPort, baud: 115200 })
      });
    } catch (err) {
      alert(`Failed to switch port: ${err.message}`);
    }
  });

  // --- Button Listeners ---

  // Auto-Follow Toggle
  btnAutoFollow.addEventListener('click', () => {
    autoFollow = !autoFollow;
    btnAutoFollow.classList.toggle('active', autoFollow);
    if (autoFollow && lastPoint) {
      map.panTo([lastPoint.lat, lastPoint.lng], { animate: true, duration: 0.5 });
    }
  });

  // Recenter Map
  btnRecenter.addEventListener('click', () => {
    if (lastPoint) {
      map.setView([lastPoint.lat, lastPoint.lng], DEFAULT_ZOOM, { animate: true });
    } else {
      map.setView([DEFAULT_LAT, DEFAULT_LNG], DEFAULT_ZOOM);
    }
  });

  // Clear Trail
  btnClearTrail.addEventListener('click', () => {
    trailPolyline.setLatLngs([]);
    totalFixPoints = 0;
    totalDistanceKm = 0;
    valTrailCount.textContent = '0';
    valDistance.textContent = '0.00 km';
    if (socket) {
      socket.emit('trail:clear');
    }
  });

  // Theme Toggle
  btnThemeToggle.addEventListener('click', () => {
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
  });

  // Mobile Sidebar Toggle
  btnSidebarToggle.addEventListener('click', () => {
    telemetryPanel.classList.toggle('collapsed');
  });

  // Close Wiring Alert Banner
  btnCloseAlert.addEventListener('click', () => {
    alertBanner.classList.add('hidden');
  });

  // --- Socket.IO Real-Time Stream Setup ---
  updateServerBadge('connecting', 'Connecting...');
  const socket = io();

  socket.on('connect', () => {
    updateServerBadge('connected', 'Server: Online');
  });

  socket.on('disconnect', () => {
    updateServerBadge('disconnected', 'Server: Offline');
  });

  socket.on('serial:status', (status) => {
    updateSerialBadge(status);
  });

  socket.on('gps:init', (payload) => {
    if (!payload) return;

    if (payload.serialStatus) {
      updateSerialBadge(payload.serialStatus);
    }

    // Populate trail history from server
    if (Array.isArray(payload.history) && payload.history.length > 0) {
      const latLngs = [];
      totalDistanceKm = 0;
      let prev = null;

      for (const pt of payload.history) {
        if (typeof pt.lat === 'number' && typeof pt.lng === 'number') {
          latLngs.push([pt.lat, pt.lng]);
          if (prev) {
            totalDistanceKm += haversineDistance(prev.lat, prev.lng, pt.lat, pt.lng);
          }
          prev = pt;
        }
      }

      trailPolyline.setLatLngs(latLngs);
      totalFixPoints = latLngs.length;
      valTrailCount.textContent = totalFixPoints;
      valDistance.textContent = `${totalDistanceKm.toFixed(2)} km`;

      const latestFix = payload.history[payload.history.length - 1];
      lastPoint = { lat: latestFix.lat, lng: latestFix.lng };
      map.setView([latestFix.lat, latestFix.lng], DEFAULT_ZOOM);
    }

    if (payload.current) {
      processGpsData(payload.current);
    }
  });

  socket.on('gps:update', (data) => {
    processGpsData(data);
  });

  socket.on('gps:trail-cleared', () => {
    trailPolyline.setLatLngs([]);
    totalFixPoints = 0;
    totalDistanceKm = 0;
    valTrailCount.textContent = '0';
    valDistance.textContent = '0.00 km';
  });

  // Initial calls
  loadSerialPorts();

})();
