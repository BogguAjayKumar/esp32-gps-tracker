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
  const btnRefreshPorts = document.getElementById('btn-refresh-ports');

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
  const floatingPlace = document.getElementById('floating-place');

  // Place Name & Address Elements
  const valPlaceName = document.getElementById('val-place-name');
  const valFullAddress = document.getElementById('val-full-address');
  const tagAddressStatus = document.getElementById('tag-address-status');
  const btnCopyAddress = document.getElementById('btn-copy-address');
  const linkMapsNav = document.getElementById('link-maps-nav');

  // --- Serial Monitor DOM Elements ---
  const btnSerialMonitor = document.getElementById('btn-serial-monitor');
  const serialPulseDot = document.getElementById('serial-pulse-dot');
  const serialDrawer = document.getElementById('serial-monitor-drawer');
  const terminalBody = document.getElementById('terminal-body');
  const monitorPortName = document.getElementById('monitor-port-name');
  const selectMonitorBaud = document.getElementById('select-monitor-baud');
  const monitorStatusDot = document.getElementById('monitor-status-dot');
  const filterChips = document.querySelectorAll('.serial-filters .filter-chip');
  const serialFilterInput = document.getElementById('serial-filter-input');
  const chkAutoscroll = document.getElementById('chk-autoscroll');
  const chkTimestamp = document.getElementById('chk-timestamp');
  const btnClearConsole = document.getElementById('btn-clear-console');
  const btnCopyConsole = document.getElementById('btn-copy-console');
  const btnPauseConsole = document.getElementById('btn-pause-console');
  const iconPause = document.getElementById('icon-pause');
  const iconPlay = document.getElementById('icon-play');
  const btnExpandConsole = document.getElementById('btn-expand-console');
  const iconMaximize = document.getElementById('icon-maximize');
  const iconRestore = document.getElementById('icon-restore');
  const btnCloseConsole = document.getElementById('btn-close-console');
  const formSerialSend = document.getElementById('form-serial-send');
  const inputSerialCommand = document.getElementById('input-serial-command');
  const selectCommandEnding = document.getElementById('select-command-ending');
  const serialDiagText = document.getElementById('serial-diag-text');

  // --- Free, No-API-Key Tile Providers (Cached automatically by browser) ---
  // High-Resolution Satellite with place names, boundaries, and street labels
  const satelliteHybrid = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      maxZoom: 19
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Labels &copy; Esri',
      maxZoom: 19
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Roads &copy; Esri',
      maxZoom: 19
    })
  ]);

  const satellitePure = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19
  });

  const mapLayers = {
    hybrid: satelliteHybrid,
    pureSatellite: satellitePure,
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20
    }),
    street: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20
    })
  };

  const DEFAULT_LAT = 17.385044;
  const DEFAULT_LNG = 78.486671;
  const DEFAULT_ZOOM = 16;

  const map = L.map('map', {
    zoomControl: false,
    attributionControl: true
  }).setView([DEFAULT_LAT, DEFAULT_LNG], DEFAULT_ZOOM);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // SATELLITE WITH PLACE NAMES & ROADS BY DEFAULT
  let currentTileLayer = mapLayers.hybrid.addTo(map);

  // Layer Switcher Control (Satellite Hybrid first & selected by default)
  const baseMaps = {
    "🛰️ Satellite + Place Names (Hybrid)": mapLayers.hybrid,
    "🛰️ Pure Satellite (No Labels)": mapLayers.pureSatellite,
    "🌙 Dark Mode": mapLayers.dark,
    "🗺️ Street Map": mapLayers.street
  };
  L.control.layers(baseMaps, null, { position: 'bottomright' }).addTo(map);

  // --- Theme Management ---
  function applyTheme(theme) {
    currentTheme = theme;
    elHtml.setAttribute('data-theme', theme);
    safeStorageSet('gps_theme', theme);

    // If user is explicitly on dark or street map, adapt tile layer; keep satellite active if selected
    if (map.hasLayer(mapLayers.dark) || map.hasLayer(mapLayers.street)) {
      map.removeLayer(mapLayers.dark);
      map.removeLayer(mapLayers.street);
      const newLayer = theme === 'dark' ? mapLayers.dark : mapLayers.street;
      newLayer.addTo(map);
      currentTileLayer = newLayer;
    }
  }

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

  // --- Address & Place Geocoding State & Helpers ---
  let currentAddressInfo = null;
  let lastReportedSpeed = 0;
  let lastReportedSats = 0;
  let lastReportedCourse = 0;

  function updateAddressUI(addr) {
    if (!addr) return;
    currentAddressInfo = addr;

    if (valPlaceName) {
      valPlaceName.textContent = addr.placeName || 'Active Location';
    }

    if (valFullAddress) {
      valFullAddress.textContent = addr.fullAddress || 'Address details resolving...';
    }

    if (floatingPlace) {
      floatingPlace.textContent = addr.placeName || addr.fullAddress || 'Live GPS Target';
    }

    if (tagAddressStatus) {
      tagAddressStatus.textContent = 'Verified';
      tagAddressStatus.classList.add('active');
    }

    if (linkMapsNav && addr.lat && addr.lng) {
      linkMapsNav.href = `https://www.google.com/maps?q=${addr.lat},${addr.lng}`;
    }

    // Refresh vehicle marker popup with full address and telemetry
    if (lastPoint) {
      const popupHtml = `
        <div class="gps-marker-popup">
          <div class="popup-title">📍 ${addr.placeName || 'Current Location'}</div>
          <div class="popup-addr">${addr.fullAddress || ''}</div>
          <div class="popup-stats">
            <span>⚡ ${lastReportedSpeed.toFixed(1)} km/h</span> &bull; 
            <span>🛰️ ${lastReportedSats} sats</span> &bull; 
            <span>🧭 ${lastReportedCourse.toFixed(0)}°</span>
          </div>
          <div class="popup-coords">${lastPoint.lat.toFixed(6)}, ${lastPoint.lng.toFixed(6)}</div>
          <a href="https://www.google.com/maps?q=${lastPoint.lat},${lastPoint.lng}" target="_blank" rel="noopener noreferrer" class="popup-link">Open in Google Maps &rarr;</a>
        </div>
      `;
      gpsMarker.bindPopup(popupHtml);
    }
  }

  // Copy Address Button
  if (btnCopyAddress) {
    btnCopyAddress.addEventListener('click', () => {
      const text = valFullAddress?.textContent;
      if (!text || text.includes('Waiting for') || text.includes('Locating')) return;
      navigator.clipboard.writeText(text).then(() => {
        const span = btnCopyAddress.querySelector('span');
        const orig = span ? span.textContent : 'Copy Address';
        if (span) span.textContent = 'Copied!';
        btnCopyAddress.style.borderColor = 'var(--status-green)';
        setTimeout(() => {
          if (span) span.textContent = orig;
          btnCopyAddress.style.borderColor = '';
        }, 1500);
      }).catch(err => {
        console.warn('Clipboard copy error:', err);
      });
    });
  }

  // Interactive Map Click: Click anywhere on the map to inspect place name & address
  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    const clickPopup = L.popup()
      .setLatLng(e.latlng)
      .setContent(`
        <div class="gps-marker-popup">
          <div class="popup-title">🔍 Resolving address...</div>
          <div class="popup-coords">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
        </div>
      `)
      .openOn(map);

    try {
      const res = await fetch(`/api/geocode/reverse?lat=${lat}&lng=${lng}`);
      const data = await res.json();
      if (data && data.success) {
        clickPopup.setContent(`
          <div class="gps-marker-popup">
            <div class="popup-title">📍 ${data.placeName || 'Location'}</div>
            <div class="popup-addr">${data.fullAddress}</div>
            <div class="popup-stats">
              <span>🌐 Lat: ${lat.toFixed(6)}</span> &bull; 
              <span>Lng: ${lng.toFixed(6)}</span>
            </div>
            <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener noreferrer" class="popup-link">Open in Google Maps &rarr;</a>
          </div>
        `);
      } else {
        clickPopup.setContent(`
          <div class="gps-marker-popup">
            <div class="popup-title">📍 Selected Location</div>
            <div class="popup-coords">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
            <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener noreferrer" class="popup-link">Open in Google Maps &rarr;</a>
          </div>
        `);
      }
    } catch (err) {
      clickPopup.setContent(`
        <div class="gps-marker-popup">
          <div class="popup-title">📍 Selected Location</div>
          <div class="popup-coords">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
          <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener noreferrer" class="popup-link">Open in Google Maps &rarr;</a>
        </div>
      `);
    }
  });

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
    const isAuto = statusObj.autoDetect !== false;

    if (statusObj.status === 'connected') {
      dot.classList.add('dot-green');
      label.textContent = `${portName} (${statusObj.baudRate || 115200})`;
      badgeSerial.title = `${statusObj.message || 'Connected'} ${isAuto ? '[Auto-Detected]' : '[Manual]'}. Click to rescan/reconnect.`;
    } else if (statusObj.status === 'reconnecting') {
      dot.classList.add('dot-yellow', 'pulse');
      label.textContent = isAuto ? 'Searching USB...' : `${portName}: Reconnecting...`;
      badgeSerial.title = `${statusObj.message}. Click to retry.`;
    } else if (statusObj.status === 'error') {
      dot.classList.add('dot-red');
      const isAccessDenied = (statusObj.message || '').includes('Access denied');
      label.textContent = isAccessDenied ? `${portName}: Busy` : `${portName}: Error`;
      badgeSerial.title = `${statusObj.message}. Click to retry.`;
    } else {
      dot.classList.add('dot-gray');
      label.textContent = isAuto ? 'Waiting for ESP...' : `${portName}: Disconnected`;
      badgeSerial.title = `${statusObj.message || 'Disconnected'}. Click to rescan USB ports.`;
    }

    // Keep Serial Monitor drawer header synchronized
    if (monitorPortName) {
      monitorPortName.textContent = portName;
    }
    if (selectMonitorBaud && statusObj.baudRate) {
      selectMonitorBaud.value = String(statusObj.baudRate);
    }
    if (monitorStatusDot) {
      monitorStatusDot.className = 'status-dot';
      if (statusObj.status === 'connected') {
        monitorStatusDot.classList.add('dot-green');
      } else if (statusObj.status === 'reconnecting') {
        monitorStatusDot.classList.add('dot-yellow', 'pulse');
      } else {
        monitorStatusDot.classList.add('dot-red');
      }
    }
  }

  function updateFixBadge(hasFix, satsCount = 0) {
    const dot = badgeFix.querySelector('.status-dot');
    const label = badgeFix.querySelector('.status-text');
    dot.className = 'status-dot';

    if (hasFix) {
      dot.classList.add('dot-green');
      label.textContent = 'Fix Acquired (3D)';
      badgeFix.title = 'GPS 3D Fix Active';
    } else {
      dot.classList.add('dot-yellow', 'pulse');
      if (satsCount > 0) {
        label.textContent = `Searching (${satsCount} sat${satsCount === 1 ? '' : 's'} tracked, need 4+)`;
      } else {
        label.textContent = 'Searching for satellites...';
      }
      badgeFix.title = 'Module requires clear sky view to acquire satellite lock';
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

    const sats = data.sats ?? 0;

    // Update Common fields
    valSats.textContent = sats;
    const satPercent = Math.min(100, Math.round((sats / 12) * 100));
    satBar.style.width = `${satPercent}%`;
    valChars.textContent = Number(data.chars ?? 0).toLocaleString();

    if (data.fix === true && typeof data.lat === 'number' && typeof data.lng === 'number') {
      updateFixBadge(true, sats);

      const lat = data.lat;
      const lng = data.lng;
      const speedKmh = data.speed ?? 0;
      const speedMph = (speedKmh * 0.621371).toFixed(1);
      const speedKnots = (speedKmh * 0.539957).toFixed(1);
      const altM = data.alt ?? 0;
      const altFt = (altM * 3.28084).toFixed(1);
      const courseDeg = data.course ?? 0;
      const hdopVal = data.hdop;

      lastReportedSpeed = speedKmh;
      lastReportedSats = sats;
      lastReportedCourse = courseDeg;

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

      // Update marker popup with address if already resolved
      if (currentAddressInfo) {
        updateAddressUI(currentAddressInfo);
      } else {
        gpsMarker.bindPopup(`
          <div class="gps-marker-popup">
            <div class="popup-title">📍 Current Location</div>
            <div class="popup-addr">Resolving place name &amp; address...</div>
            <div class="popup-stats">
              <span>⚡ ${speedKmh.toFixed(1)} km/h</span> &bull; 
              <span>🛰️ ${sats} sats</span>
            </div>
            <div class="popup-coords">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
          </div>
        `);
      }

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
      // Fix is false (searching for satellite lock)
      updateFixBadge(false, sats);
      floatingCoords.textContent = sats > 0 ? `Searching (${sats} sats)` : 'Searching...';
      valSpeed.textContent = '0.0';
      valSpeedAlt.textContent = '0.0 mph • 0.0 kn';
      valCourse.textContent = '0.0°';
      valCardinal.textContent = sats > 0 ? `Tracking ${sats} sat${sats === 1 ? '' : 's'}` : 'Searching satellites';
      valHdop.textContent = '--';
      hdopRating.textContent = 'No Fix';
      hdopRating.className = 'hdop-badge badge-neutral';

      // Guide the user clearly on the coordinates card
      if (lastPoint) {
        valLat.textContent = `${lastPoint.lat.toFixed(6)}° (Last)`;
        valLng.textContent = `${lastPoint.lng.toFixed(6)}° (Last)`;
      } else {
        valLat.textContent = 'Searching Sky...';
        valLng.textContent = sats > 0 ? `${sats} sats locked (need 4+)` : 'Antenna needs open sky view';
      }
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

  // --- Dynamic Serial Ports Dropdown Rendering ---
  function renderPortsDropdown(data) {
    if (!data || !Array.isArray(data.ports)) return;
    const currentPort = (data.currentPort || '').toUpperCase();
    const isAuto = data.autoDetect !== false;

    // Remember currently focused/selected state if user interacted
    selectSerialPort.innerHTML = '';

    // Auto-Detect Option
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = '⚡ Auto-Detect (Plug & Play)';
    if (isAuto) {
      autoOpt.selected = true;
    }
    selectSerialPort.appendChild(autoOpt);

    // Group detected USB/UART ports
    const usbGroup = document.createElement('optgroup');
    usbGroup.label = 'Detected Hardware / USB Ports';

    const btGroup = document.createElement('optgroup');
    btGroup.label = 'Bluetooth Ports (Ignored by Auto)';

    data.ports.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.path;

      let label = p.path;
      if (p.isEspCandidate) {
        label += ` (ESP32 - ${p.friendlyName.replace(/\s*\(COM\d+\)/i, '')})`;
      } else if (p.isBluetooth) {
        label += ` (Bluetooth)`;
      } else {
        label += ` (${p.friendlyName ? p.friendlyName.replace(/\s*\(COM\d+\)/i, '') : p.manufacturer})`;
      }
      opt.textContent = label;

      if (!isAuto && p.path.toUpperCase() === currentPort) {
        opt.selected = true;
      }

      if (p.isBluetooth) {
        btGroup.appendChild(opt);
      } else {
        usbGroup.appendChild(opt);
      }
    });

    if (usbGroup.children.length > 0) {
      selectSerialPort.appendChild(usbGroup);
    }
    if (btGroup.children.length > 0) {
      selectSerialPort.appendChild(btGroup);
    }
  }

  // --- Fetch Available Serial Ports ---
  async function loadSerialPorts() {
    try {
      const response = await fetch('/api/ports');
      const data = await response.json();
      if (!data.success) return;
      renderPortsDropdown(data);
    } catch (err) {
      console.warn('Could not load serial ports:', err.message);
    }
  }

  // Port switch change handler
  selectSerialPort.addEventListener('change', async () => {
    const selectedVal = selectSerialPort.value;
    if (!selectedVal) return;

    try {
      if (selectedVal === 'auto') {
        await fetch('/api/ports/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auto: true })
        });
      } else {
        await fetch('/api/ports/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: selectedVal, baud: 115200, auto: false })
        });
      }
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

  // Rescan / Refresh Serial Ports Button
  if (btnRefreshPorts) {
    btnRefreshPorts.addEventListener('click', async () => {
      btnRefreshPorts.classList.add('spinning');
      if (socket) {
        socket.emit('ports:refresh');
        socket.emit('serial:reconnect');
      }
      await loadSerialPorts();
      setTimeout(() => {
        btnRefreshPorts.classList.remove('spinning');
      }, 800);
    });
  }

  // Clickable Serial Badge: Triggers Reconnect / Rescan
  if (badgeSerial) {
    badgeSerial.addEventListener('click', () => {
      if (socket) {
        socket.emit('serial:reconnect');
        socket.emit('ports:refresh');
      }
      loadSerialPorts();
    });
  }

  // Mobile Sidebar Toggle
  btnSidebarToggle.addEventListener('click', () => {
    telemetryPanel.classList.toggle('collapsed');
  });

  // Close Wiring Alert Banner
  btnCloseAlert.addEventListener('click', () => {
    alertBanner.classList.add('hidden');
  });

  // ==========================================================================
  // Serial Monitor Controller
  // ==========================================================================

  let activeFilter = 'all';
  let isConsolePaused = false;
  let pulseTimeout = null;

  function triggerSerialPulse() {
    if (!serialPulseDot) return;
    serialPulseDot.classList.add('active');
    if (pulseTimeout) clearTimeout(pulseTimeout);
    pulseTimeout = setTimeout(() => {
      serialPulseDot.classList.remove('active');
    }, 180);
  }

  function formatLogTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      return `${hh}:${mm}:${ss}.${ms}`;
    } catch {
      return '';
    }
  }

  function appendTerminalLine(entry) {
    if (!terminalBody) return;

    const waiting = terminalBody.querySelector('.terminal-waiting');
    if (waiting) waiting.remove();

    const lineEl = document.createElement('div');
    lineEl.className = 'term-line';
    lineEl.dataset.type = entry.type || 'raw';
    lineEl.dataset.direction = entry.direction || 'rx';

    const filterText = (serialFilterInput?.value || '').toLowerCase().trim();
    const lineText = entry.text || '';
    const matchesSearch = !filterText || lineText.toLowerCase().includes(filterText);
    const matchesCategory =
      activeFilter === 'all' ||
      (activeFilter === 'json' && entry.type === 'json') ||
      (activeFilter === 'nmea' && entry.type === 'nmea') ||
      (activeFilter === 'tx' && entry.direction === 'tx') ||
      (activeFilter === 'debug' && (entry.type === 'debug' || entry.type === 'sys'));

    if (!matchesSearch || !matchesCategory) {
      lineEl.classList.add('hidden-by-filter');
    }

    // Timestamp element
    const timeEl = document.createElement('span');
    timeEl.className = 'term-time';
    if (!chkTimestamp?.checked) timeEl.classList.add('hidden');
    timeEl.textContent = `[${formatLogTime(entry.timestamp)}]`;

    // Direction/Type tag
    const tagEl = document.createElement('span');
    tagEl.className = 'term-tag';
    if (entry.direction === 'tx') {
      tagEl.classList.add('tag-tx');
      tagEl.textContent = 'TX';
    } else if (entry.direction === 'sys') {
      tagEl.classList.add('tag-sys');
      tagEl.textContent = 'SYS';
    } else if (entry.type === 'error') {
      tagEl.classList.add('tag-error');
      tagEl.textContent = 'ERR';
    } else {
      tagEl.classList.add('tag-rx');
      tagEl.textContent = 'RX';
    }

    // Content element
    const contentEl = document.createElement('span');
    contentEl.className = 'term-content';

    if (entry.type === 'json') {
      contentEl.classList.add('content-json');
      if (lineText.includes('"fix":true')) {
        contentEl.classList.add('has-fix');
      } else if (lineText.includes('"fix":false')) {
        contentEl.classList.add('no-fix');
      }
    } else if (entry.type === 'nmea') {
      contentEl.classList.add('content-nmea');
    } else if (entry.direction === 'tx') {
      contentEl.classList.add('content-tx');
    } else if (entry.direction === 'sys') {
      contentEl.classList.add('content-sys');
    } else if (entry.type === 'error') {
      contentEl.classList.add('content-error');
    } else {
      contentEl.classList.add('content-debug');
    }
    contentEl.textContent = lineText;

    lineEl.appendChild(timeEl);
    lineEl.appendChild(tagEl);
    lineEl.appendChild(contentEl);

    terminalBody.appendChild(lineEl);

    // Limit in-memory DOM nodes to 400
    while (terminalBody.children.length > 400) {
      terminalBody.removeChild(terminalBody.firstChild);
    }

    // Auto-scroll if enabled and not paused
    if (!isConsolePaused && chkAutoscroll?.checked) {
      terminalBody.scrollTop = terminalBody.scrollHeight;
    }
  }

  function applyFilterToAllLines() {
    const filterText = (serialFilterInput?.value || '').toLowerCase().trim();
    const lines = terminalBody.querySelectorAll('.term-line');
    lines.forEach((line) => {
      const type = line.dataset.type;
      const dir = line.dataset.direction;
      const text = line.querySelector('.term-content')?.textContent || '';

      const matchesSearch = !filterText || text.toLowerCase().includes(filterText);
      const matchesCategory =
        activeFilter === 'all' ||
        (activeFilter === 'json' && type === 'json') ||
        (activeFilter === 'nmea' && type === 'nmea') ||
        (activeFilter === 'tx' && dir === 'tx') ||
        (activeFilter === 'debug' && (type === 'debug' || type === 'sys'));

      if (matchesSearch && matchesCategory) {
        line.classList.remove('hidden-by-filter');
      } else {
        line.classList.add('hidden-by-filter');
      }
    });

    if (chkAutoscroll?.checked) {
      terminalBody.scrollTop = terminalBody.scrollHeight;
    }
  }

  function toggleSerialDrawer(forceOpen = null) {
    if (!serialDrawer) return;
    const isHidden = serialDrawer.classList.contains('hidden');
    const shouldOpen = forceOpen !== null ? forceOpen : isHidden;

    if (shouldOpen) {
      serialDrawer.classList.remove('hidden');
      btnSerialMonitor?.classList.add('active');
      if (chkAutoscroll?.checked) {
        terminalBody.scrollTop = terminalBody.scrollHeight;
      }
      setTimeout(() => inputSerialCommand?.focus(), 150);
    } else {
      serialDrawer.classList.add('hidden');
      btnSerialMonitor?.classList.remove('active');
    }
  }

  // Serial Monitor Toggle & Close
  if (btnSerialMonitor) {
    btnSerialMonitor.addEventListener('click', () => toggleSerialDrawer());
  }

  if (btnCloseConsole) {
    btnCloseConsole.addEventListener('click', () => toggleSerialDrawer(false));
  }

  // Filter chips
  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      filterChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter || 'all';
      applyFilterToAllLines();
    });
  });

  if (serialFilterInput) {
    serialFilterInput.addEventListener('input', () => {
      applyFilterToAllLines();
    });
  }

  // Timestamp Toggle
  if (chkTimestamp) {
    chkTimestamp.addEventListener('change', () => {
      const show = chkTimestamp.checked;
      terminalBody.querySelectorAll('.term-time').forEach((el) => {
        el.classList.toggle('hidden', !show);
      });
    });
  }

  // Clear Console
  if (btnClearConsole) {
    btnClearConsole.addEventListener('click', () => {
      terminalBody.innerHTML = '<div class="terminal-waiting">Console cleared. Waiting for serial data...</div>';
      if (socket) socket.emit('serial:clear');
    });
  }

  // Copy to Clipboard
  if (btnCopyConsole) {
    btnCopyConsole.addEventListener('click', () => {
      const visibleLines = Array.from(terminalBody.querySelectorAll('.term-line:not(.hidden-by-filter)'));
      const fullText = visibleLines
        .map((l) => {
          const time = l.querySelector('.term-time')?.textContent || '';
          const tag = l.querySelector('.term-tag')?.textContent || '';
          const content = l.querySelector('.term-content')?.textContent || '';
          return `${time} [${tag}] ${content}`.trim();
        })
        .join('\n');

      navigator.clipboard.writeText(fullText).then(() => {
        const prevTitle = btnCopyConsole.title;
        btnCopyConsole.title = 'Copied to clipboard!';
        btnCopyConsole.style.color = '#38bdf8';
        setTimeout(() => {
          btnCopyConsole.title = prevTitle;
          btnCopyConsole.style.color = '';
        }, 1500);
      }).catch(err => {
        console.warn('Clipboard copy error:', err);
      });
    });
  }

  // Pause / Resume
  if (btnPauseConsole) {
    btnPauseConsole.addEventListener('click', () => {
      isConsolePaused = !isConsolePaused;
      if (isConsolePaused) {
        iconPause?.classList.add('hidden');
        iconPlay?.classList.remove('hidden');
        btnPauseConsole.title = 'Resume Streaming';
        btnPauseConsole.style.color = '#f59e0b';
      } else {
        iconPause?.classList.remove('hidden');
        iconPlay?.classList.add('hidden');
        btnPauseConsole.title = 'Pause Streaming';
        btnPauseConsole.style.color = '';
        if (chkAutoscroll?.checked) {
          terminalBody.scrollTop = terminalBody.scrollHeight;
        }
      }
    });
  }

  // Maximize / Restore
  if (btnExpandConsole) {
    btnExpandConsole.addEventListener('click', () => {
      const isMax = serialDrawer.classList.toggle('maximized');
      iconMaximize?.classList.toggle('hidden', isMax);
      iconRestore?.classList.toggle('hidden', !isMax);
      btnExpandConsole.title = isMax ? 'Restore Height' : 'Maximize Console';
    });
  }

  // Baud Selector
  if (selectMonitorBaud) {
    selectMonitorBaud.addEventListener('change', () => {
      const newBaud = selectMonitorBaud.value;
      if (socket) {
        socket.emit('serial:set-baud', newBaud);
      }
    });
  }

  // Send Command Form
  if (formSerialSend) {
    formSerialSend.addEventListener('submit', (e) => {
      e.preventDefault();
      const cmd = (inputSerialCommand?.value || '').trim();
      if (!cmd) return;
      const ending = selectCommandEnding ? selectCommandEnding.value : '\r\n';

      if (socket) {
        socket.emit('serial:send', { data: cmd, lineEnding: ending });
      }
      if (inputSerialCommand) inputSerialCommand.value = '';
    });
  }

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

  // Listen to dynamic serial port additions/removals
  socket.on('ports:list', (payload) => {
    renderPortsDropdown(payload);
  });

  socket.on('gps:init', (payload) => {
    if (!payload) return;

    if (payload.serialStatus) {
      updateSerialBadge(payload.serialStatus);
    }

    if (payload.config) {
      renderPortsDropdown({
        ports: [],
        currentPort: payload.config.port,
        autoDetect: payload.config.autoDetect
      });
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

    // Hydrate place name and address if provided on initial load
    if (payload.address) {
      updateAddressUI(payload.address);
    }

    // Populate initial serial monitor history from server
    if (Array.isArray(payload.serialLogs) && payload.serialLogs.length > 0) {
      terminalBody.innerHTML = '';
      payload.serialLogs.forEach((entry) => appendTerminalLine(entry));
    }
  });

  // Real-time address updates
  socket.on('gps:address', (addr) => {
    updateAddressUI(addr);
  });

  // Real-time serial line reception
  socket.on('serial:line', (entry) => {
    triggerSerialPulse();
    appendTerminalLine(entry);
  });

  // Direct serial history hydration
  socket.on('serial:history', (logs) => {
    if (Array.isArray(logs) && logs.length > 0) {
      terminalBody.innerHTML = '';
      logs.forEach((entry) => appendTerminalLine(entry));
    }
  });

  // Serial console clear event
  socket.on('serial:cleared', () => {
    terminalBody.innerHTML = '<div class="terminal-waiting">Console buffer cleared.</div>';
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
