/**
 * Hina Maps — Live Navigation & Spatial Telemetry Application
 * Powered by MapLibre GL JS (Vector & Satellite Hybrid), Kalman Filter GPS Smoothing,
 * OSRM Road-Snapping, Voice Turn-by-Turn Navigation, and Hardware USB Serial Monitoring.
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. Utilities & Safe Storage
  // ==========================================================================

  function safeStorageGet(key, fallback) {
    try {
      const val = localStorage.getItem(key);
      return val !== null ? val : fallback;
    } catch {
      return fallback;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage unavailable or quota exceeded
    }
  }

  function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function formatDuration(totalSeconds) {
    const sec = Math.floor(totalSeconds % 60);
    const min = Math.floor((totalSeconds / 60) % 60);
    const hr = Math.floor(totalSeconds / 3600);
    return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function getCardinalDirection(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return 'North (N)';
    const directions = [
      'North (N)', 'North-North-East (NNE)', 'North-East (NE)', 'East-North-East (ENE)',
      'East (E)', 'East-South-East (ESE)', 'South-East (SE)', 'South-South-East (SSE)',
      'South (S)', 'South-South-West (SSW)', 'South-West (SW)', 'West-South-West (WSW)',
      'West (W)', 'West-North-West (WNW)', 'North-West (NW)', 'North-North-West (NNW)'
    ];
    const index = Math.round((deg % 360) / 22.5) % 16;
    return directions[index];
  }

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

  // ==========================================================================
  // 2. Application State & Subsystems
  // ==========================================================================

  const DEFAULT_LAT = 17.385044;
  const DEFAULT_LNG = 78.486671;
  const DEFAULT_ZOOM = 16;

  // Follow modes: 'off', '2d', '3d'
  let followMode = '2d';
  let is3dBuildingsEnabled = true;
  let currentActiveStyle = 'hybrid';
  let currentTheme = safeStorageGet('hina_theme', 'dark');

  // Live Telemetry & Trip State
  let lastGpsPoint = null;
  let lastSnappedPoint = null;
  let lastFixTimestamp = null;
  let tripStartTime = Date.now();
  let totalDistanceKm = 0;
  let maxSpeedKmh = 0;
  let speedSamplesCount = 0;
  let speedSumKmh = 0;
  let currentRoadSpeedLimit = 50; // km/h default
  let zeroCharsCounter = 0;
  let currentAddressInfo = null;

  // Trail Segments (FeatureCollection for speed-colored lines)
  const trailSegments = [];
  const MAX_TRAIL_SEGMENTS = 1500;

  // Navigation & Routing State
  let activeRouteData = null;
  let currentStepIndex = 0;
  let lastRerouteTimestamp = 0;
  let destinationMarker = null;

  // Instantiate Subsystems
  const kalmanFilter = new GpsKalmanFilter(0.00001, 3.0);
  const voiceGuide = window.voiceGuide || new NavigationVoiceGuide();

  // ==========================================================================
  // 3. DOM Element Caching
  // ==========================================================================

  const elHtml = document.documentElement;

  // Header Status Chips
  const badgeServer = document.getElementById('badge-server');
  const badgeSerial = document.getElementById('badge-serial');
  const badgeFix = document.getElementById('badge-fix');

  // Search Bar
  const searchInput = document.getElementById('search-input');
  const btnClearSearch = document.getElementById('btn-clear-search');
  const searchSuggestions = document.getElementById('search-suggestions');

  // Navigation Banner
  const navGuidanceBanner = document.getElementById('nav-guidance-banner');
  const navManeuverIcon = document.getElementById('nav-maneuver-icon');
  const navDistanceCallout = document.getElementById('nav-distance-callout');
  const navInstructionText = document.getElementById('nav-instruction-text');
  const navRemainingDist = document.getElementById('nav-remaining-dist');
  const navEtaTime = document.getElementById('nav-eta-time');
  const btnVoiceToggle = document.getElementById('btn-voice-toggle');
  const iconVoiceOn = document.getElementById('icon-voice-on');
  const iconVoiceOff = document.getElementById('icon-voice-off');
  const btnStopNav = document.getElementById('btn-stop-nav');

  // Topbar Controls
  const btnAutoFollow = document.getElementById('btn-autofollow');
  const labelAutoFollow = document.getElementById('label-autofollow');
  const btnToggle3D = document.getElementById('btn-toggle-3d');
  const btnToggleNavPanel = document.getElementById('btn-toggle-nav-panel');
  const btnOpenFavorites = document.getElementById('btn-open-favorites');
  const btnExportMenu = document.getElementById('btn-export-menu');
  const exportDropdown = document.getElementById('export-dropdown');
  const btnThemeToggle = document.getElementById('btn-theme-toggle');
  const btnFullscreenToggle = document.getElementById('btn-fullscreen-toggle');
  const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  const telemetryPanel = document.getElementById('telemetry-panel');

  // Telemetry Cards
  const valPlaceName = document.getElementById('val-place-name');
  const valFullAddress = document.getElementById('val-full-address');
  const tagAddressStatus = document.getElementById('tag-address-status');
  const btnCopyAddress = document.getElementById('btn-copy-address');
  const btnSaveAsFav = document.getElementById('btn-save-as-fav');
  const linkMapsNav = document.getElementById('link-maps-nav');

  const valSpeed = document.getElementById('val-speed');
  const valSpeedAlt = document.getElementById('val-speed-alt');
  const speedLimitBadge = document.getElementById('speed-limit-badge');
  const speedWarningAlert = document.getElementById('speed-warning-alert');
  const warningLimitVal = document.getElementById('warning-limit-val');

  const valDistance = document.getElementById('val-distance');
  const valTripDuration = document.getElementById('val-trip-duration');
  const valAvgSpeed = document.getElementById('val-avg-speed');
  const valMaxSpeed = document.getElementById('val-max-speed');

  const valLat = document.getElementById('val-lat');
  const valLng = document.getElementById('val-lng');
  const valSnappedRoad = document.getElementById('val-snapped-road');

  const compassNeedle = document.getElementById('compass-needle');
  const valCourse = document.getElementById('val-course');
  const valCardinal = document.getElementById('val-cardinal');
  const valAltSummary = document.getElementById('val-alt-summary');

  const valSats = document.getElementById('val-sats');
  const satBar = document.getElementById('sat-bar');
  const hdopRating = document.getElementById('hdop-rating');

  const valChars = document.getElementById('val-chars');
  const selectSerialPort = document.getElementById('select-serial-port');
  const btnRefreshPorts = document.getElementById('btn-refresh-ports');
  const lastUpdateTime = document.getElementById('last-update-time');

  // Floating HUD Elements
  const floatingPlace = document.getElementById('floating-place');
  const floatingCoords = document.getElementById('floating-coords');
  const floatingSpeed = document.getElementById('floating-speed');

  // Map Controls Cluster
  const btnRecenter = document.getElementById('btn-recenter');
  const btnTiltToggle = document.getElementById('btn-tilt-toggle');
  const btnCompassNorth = document.getElementById('btn-compass-north');
  const svgCompassNorth = document.getElementById('svg-compass-north');
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  const styleButtons = document.querySelectorAll('.style-btn');

  // Modals
  const modalFavorites = document.getElementById('modal-favorites');
  const btnCloseFavorites = document.getElementById('btn-close-favorites');
  const modalTabButtons = document.querySelectorAll('.modal-tab-btn');
  const tabFavsContent = document.getElementById('tab-favs-content');
  const tabHistoryContent = document.getElementById('tab-history-content');
  const favoritesList = document.getElementById('favorites-list');
  const tripHistoryList = document.getElementById('trip-history-list');

  // Serial Monitor Elements
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

  // ==========================================================================
  // 4. MapLibre GL Map Initialization
  // ==========================================================================

  const map = new maplibregl.Map({
    container: 'map',
    style: HinaMapStyles.hybrid,
    center: [DEFAULT_LNG, DEFAULT_LAT],
    zoom: DEFAULT_ZOOM,
    minZoom: 2,
    maxZoom: 22,
    pitch: 0,
    bearing: 0,
    antialias: true
  });

  // Add scale bar control
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottomleft');

  // Custom Directional Vehicle Puck
  const puckEl = document.createElement('div');
  puckEl.className = 'hina-gps-puck';
  puckEl.innerHTML = `
    <div class="hina-puck-halo"></div>
    <div class="hina-puck-dot"></div>
    <div class="hina-puck-heading" id="puck-heading-arrow"></div>
  `;
  const puckArrowEl = puckEl.querySelector('#puck-heading-arrow');

  const gpsVehicleMarker = new maplibregl.Marker({
    element: puckEl,
    anchor: 'center'
  })
    .setLngLat([DEFAULT_LNG, DEFAULT_LAT])
    .addTo(map);

  // Road Snapped Marker
  const roadSnapMarker = new maplibregl.Marker({
    color: '#10b981',
    scale: 0.65
  });

  // Destination Search Marker Pin
  const destMarkerEl = document.createElement('div');
  destMarkerEl.className = 'hina-search-pin';
  destMarkerEl.innerHTML = `
    <svg viewBox="0 0 24 24" width="32" height="32" fill="#ef4444" stroke="#ffffff" stroke-width="1.5">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
      <circle cx="12" cy="9" r="2.8" fill="#ffffff"/>
    </svg>
  `;
  destinationMarker = new maplibregl.Marker({
    element: destMarkerEl,
    anchor: 'bottom'
  });

  // Dynamic Map Layers Setup (Speed Trail, Routes)
  function setupCustomMapLayers() {
    // 1. GPS Traveled Path (Segmented with Speed Colors)
    if (!map.getSource('gps-trail')) {
      map.addSource('gps-trail', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: trailSegments
        }
      });

      // Casing line underneath
      map.addLayer({
        id: 'gps-trail-casing',
        type: 'line',
        source: 'gps-trail',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#000000',
          'line-width': 6,
          'line-opacity': 0.5
        }
      });

      // Colored speed trail
      map.addLayer({
        id: 'gps-trail-line',
        type: 'line',
        source: 'gps-trail',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 4.5,
          'line-opacity': 0.95
        }
      });
    }

    // 2. Navigation Routes
    if (!map.getSource('nav-route-primary')) {
      map.addSource('nav-route-primary', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      // Route Casing
      map.addLayer({
        id: 'nav-route-casing',
        type: 'line',
        source: 'nav-route-primary',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0369a1',
          'line-width': 8,
          'line-opacity': 0.8
        }
      });

      // Route Core Line
      map.addLayer({
        id: 'nav-route-line',
        type: 'line',
        source: 'nav-route-primary',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#38bdf8',
          'line-width': 5.5,
          'line-opacity': 1.0
        }
      });
    }

    if (!map.getSource('nav-route-alt')) {
      map.addSource('nav-route-alt', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'nav-route-alt-line',
        type: 'line',
        source: 'nav-route-alt',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#94a3b8',
          'line-width': 4,
          'line-opacity': 0.65,
          'line-dasharray': [2, 2]
        }
      });
    }

    // 3. Inject 3D buildings if enabled
    if (is3dBuildingsEnabled) {
      HinaMapStyles.inject3dBuildings(map);
    }
  }

  map.on('style.load', () => {
    setupCustomMapLayers();
    updateMapTrailSource();
    if (activeRouteData) {
      renderRouteOnMap(activeRouteData);
    }
  });

  // Track map pitch/bearing for compass and controls
  map.on('rotate', () => {
    const bearing = map.getBearing();
    if (svgCompassNorth) {
      svgCompassNorth.style.transform = `rotate(${-bearing}deg)`;
    }
  });

  // When user manually drags/pans, suspend auto-follow to prevent fight
  map.on('dragstart', () => {
    if (followMode !== 'off') {
      setFollowMode('off');
    }
  });

  // Click on map to reverse geocode & inspect place
  map.on('click', async (e) => {
    const { lng, lat } = e.lngLat;
    const clickPopup = new maplibregl.Popup({ offset: 15, maxWidth: '320px' })
      .setLngLat([lng, lat])
      .setHTML(`
        <div class="gps-marker-popup">
          <div class="popup-title">🔍 Resolving address...</div>
          <div class="popup-coords">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
        </div>
      `)
      .addTo(map);

    try {
      const res = await fetch(`/api/geocode/reverse?lat=${lat}&lng=${lng}`);
      const data = await res.json();
      if (data && data.success) {
        clickPopup.setHTML(`
          <div class="gps-marker-popup">
            <div class="popup-title">📍 ${data.placeName || 'Location'}</div>
            <div class="popup-addr">${data.fullAddress}</div>
            <div class="popup-stats">
              <span>🌐 Lat: ${lat.toFixed(6)}</span> &bull; 
              <span>Lng: ${lng.toFixed(6)}</span>
            </div>
            <button class="btn btn-secondary btn-xs" style="margin-top:6px; width:100%; justify-content:center;" onclick="window.startNavTo(${lat}, ${lng}, '${data.placeName || 'Destination'}')">
              🚗 Navigate Here
            </button>
          </div>
        `);
      } else {
        clickPopup.setHTML(`
          <div class="gps-marker-popup">
            <div class="popup-title">📍 Selected Location</div>
            <div class="popup-coords">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
            <button class="btn btn-secondary btn-xs" style="margin-top:6px; width:100%; justify-content:center;" onclick="window.startNavTo(${lat}, ${lng}, 'Destination')">
              🚗 Navigate Here
            </button>
          </div>
        `);
      }
    } catch {
      clickPopup.setHTML(`
        <div class="gps-marker-popup">
          <div class="popup-title">📍 Selected Location</div>
          <div class="popup-coords">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
          <button class="btn btn-secondary btn-xs" style="margin-top:6px; width:100%; justify-content:center;" onclick="window.startNavTo(${lat}, ${lng}, 'Destination')">
            🚗 Navigate Here
          </button>
        </div>
      `);
    }
  });

  // Global helper for popup "Navigate Here" click
  window.startNavTo = function (lat, lng, name) {
    if (!lastGpsPoint) {
      alert('Waiting for GPS satellite lock to start navigation.');
      return;
    }
    initiateNavigation(lastGpsPoint.lat, lastGpsPoint.lng, lat, lng, name);
  };

  // ==========================================================================
  // 5. Follow Mode & View Controls
  // ==========================================================================

  function setFollowMode(mode) {
    followMode = mode;
    btnAutoFollow.classList.remove('active');

    if (mode === 'off') {
      labelAutoFollow.textContent = 'Follow: Off';
    } else if (mode === '2d') {
      btnAutoFollow.classList.add('active');
      labelAutoFollow.textContent = 'Follow: 2D';
      map.easeTo({ pitch: 0, duration: 400 });
      if (lastGpsPoint) {
        map.panTo([lastGpsPoint.lng, lastGpsPoint.lat], { duration: 600 });
      }
    } else if (mode === '3d') {
      btnAutoFollow.classList.add('active');
      labelAutoFollow.textContent = 'Follow: 3D';
      if (lastGpsPoint) {
        map.easeTo({
          center: [lastGpsPoint.lng, lastGpsPoint.lat],
          pitch: 58,
          bearing: lastGpsPoint.course || 0,
          zoom: Math.max(map.getZoom(), 17),
          duration: 600
        });
      }
    }
  }

  btnAutoFollow.addEventListener('click', () => {
    if (followMode === 'off') {
      setFollowMode('2d');
    } else if (followMode === '2d') {
      setFollowMode('3d');
    } else {
      setFollowMode('off');
    }
  });

  btnRecenter.addEventListener('click', () => {
    if (lastGpsPoint) {
      setFollowMode('2d');
      map.flyTo({
        center: [lastGpsPoint.lng, lastGpsPoint.lat],
        zoom: DEFAULT_ZOOM,
        pitch: 0,
        bearing: 0,
        essential: true
      });
    } else {
      map.flyTo({ center: [DEFAULT_LNG, DEFAULT_LAT], zoom: DEFAULT_ZOOM, pitch: 0, bearing: 0 });
    }
  });

  btnTiltToggle.addEventListener('click', () => {
    const currentPitch = map.getPitch();
    const nextPitch = currentPitch > 20 ? 0 : 60;
    map.easeTo({ pitch: nextPitch, duration: 500 });
  });

  btnCompassNorth.addEventListener('click', () => {
    map.easeTo({ bearing: 0, duration: 500 });
  });

  btnZoomIn.addEventListener('click', () => map.zoomIn({ duration: 300 }));
  btnZoomOut.addEventListener('click', () => map.zoomOut({ duration: 300 }));

  // 3D Buildings Toggle
  btnToggle3D.addEventListener('click', () => {
    is3dBuildingsEnabled = !is3dBuildingsEnabled;
    btnToggle3D.classList.toggle('active', is3dBuildingsEnabled);
    const layer = map.getLayer('hina-3d-buildings') || map.getLayer('3d-buildings');
    if (layer) {
      map.setLayoutProperty(layer.id, 'visibility', is3dBuildingsEnabled ? 'visible' : 'none');
    } else if (is3dBuildingsEnabled) {
      HinaMapStyles.inject3dBuildings(map);
    }
  });

  // Directions / Nav Panel Toggle
  if (btnToggleNavPanel) {
    btnToggleNavPanel.addEventListener('click', () => {
      if (activeRouteData) {
        navGuidanceBanner.classList.toggle('hidden');
      } else {
        searchInput.focus();
        searchInput.placeholder = 'Search destination to navigate...';
      }
    });
  }

  // Base Style Switcher
  styleButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      styleButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const styleKey = btn.dataset.style;
      if (HinaMapStyles[styleKey]) {
        currentActiveStyle = styleKey;
        map.setStyle(HinaMapStyles[styleKey]);
      }
    });
  });

  // ==========================================================================
  // 6. GPS Ingestion, Kalman Filter & Telemetry Dashboard
  // ==========================================================================

  let lastRoadSnapTime = 0;

  function updateMapTrailSource() {
    const src = map.getSource('gps-trail');
    if (src) {
      src.setData({
        type: 'FeatureCollection',
        features: trailSegments
      });
    }
  }

  function appendTrailSegment(p1, p2, speedKmh) {
    if (!p1 || !p2) return;
    const color = HinaMapStyles.getSpeedColor(speedKmh);
    const segment = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [p1.lng, p1.lat],
          [p2.lng, p2.lat]
        ]
      },
      properties: {
        speed: speedKmh,
        color: color
      }
    };
    trailSegments.push(segment);
    if (trailSegments.length > MAX_TRAIL_SEGMENTS) {
      trailSegments.shift();
    }
    updateMapTrailSource();
  }

  async function checkRoadSnapping(lat, lng) {
    const now = Date.now();
    // Throttle road snapping queries to once every 2.5 seconds
    if (now - lastRoadSnapTime < 2500) return;
    lastRoadSnapTime = now;

    try {
      const res = await fetch(`/api/routing/nearest?lat=${lat}&lng=${lng}`);
      const data = await res.json();
      if (data && data.success && data.snapped) {
        lastSnappedPoint = data.snapped;
        roadSnapMarker.setLngLat([data.snapped.lng, data.snapped.lat]).addTo(map);

        if (valSnappedRoad) {
          valSnappedRoad.textContent = data.name || 'OSRM Snapped Road';
        }
      }
    } catch (err) {
      console.warn('Road match snap error:', err);
    }
  }

  function processGpsData(data) {
    if (!data) return;

    lastFixTimestamp = new Date();
    checkWiringAlert(data.chars ?? 0);

    const sats = data.sats ?? 0;
    valSats.textContent = sats;
    const satPercent = Math.min(100, Math.round((sats / 12) * 100));
    satBar.style.width = `${satPercent}%`;
    valChars.textContent = Number(data.chars ?? 0).toLocaleString();

    if (data.fix === true && typeof data.lat === 'number' && typeof data.lng === 'number') {
      updateFixBadge(true, sats);

      // 1. Kalman Filter Position Smoothing
      const hdop = data.hdop || 2.0;
      const smoothed = kalmanFilter.update(data.lat, data.lng, hdop * 3.5, Date.now());
      const rawLat = data.lat;
      const rawLng = data.lng;
      const sLat = smoothed.lat;
      const sLng = smoothed.lng;

      const speedKmh = Number(data.speed ?? 0);
      const speedMph = (speedKmh * 0.621371).toFixed(1);
      const speedKnots = (speedKmh * 0.539957).toFixed(1);
      const altM = Number(data.alt ?? 0);
      const altFt = (altM * 3.28084).toFixed(0);
      const courseDeg = Number(data.course ?? 0);

      // 2. Trip Analytics Accumulation
      if (lastGpsPoint) {
        const stepDist = haversineDistanceKm(lastGpsPoint.lat, lastGpsPoint.lng, sLat, sLng);
        // Discard teleportation / noise jumps (> 140 km/h jump)
        if (stepDist < 0.25) {
          totalDistanceKm += stepDist;
          appendTrailSegment(lastGpsPoint, { lat: sLat, lng: sLng }, speedKmh);
        }
      }

      speedSamplesCount++;
      speedSumKmh += speedKmh;
      if (speedKmh > maxSpeedKmh) maxSpeedKmh = speedKmh;

      const tripElapsedSeconds = (Date.now() - tripStartTime) / 1000;
      const avgSpeedKmh = speedSamplesCount > 0 ? (speedSumKmh / speedSamplesCount) : 0;

      // Update Dashboard Metrics
      valLat.textContent = `${sLat.toFixed(6)}° ${sLat >= 0 ? 'N' : 'S'}`;
      valLng.textContent = `${sLng.toFixed(6)}° ${sLng >= 0 ? 'E' : 'W'}`;

      valSpeed.textContent = speedKmh.toFixed(1);
      valSpeedAlt.textContent = `${speedMph} mph • ${speedKnots} kn`;

      valDistance.textContent = `${totalDistanceKm.toFixed(2)} km`;
      valTripDuration.textContent = formatDuration(tripElapsedSeconds);
      valAvgSpeed.textContent = `${avgSpeedKmh.toFixed(1)} km/h`;
      valMaxSpeed.textContent = `${maxSpeedKmh.toFixed(1)} km/h`;

      valCourse.textContent = `${courseDeg.toFixed(1)}°`;
      valCardinal.textContent = getCardinalDirection(courseDeg);
      valAltSummary.textContent = `Altitude: ${altM.toFixed(1)} m (${altFt} ft)`;
      compassNeedle.style.transform = `rotate(${courseDeg}deg)`;

      // Speed Limit Warning
      if (speedLimitBadge) {
        speedLimitBadge.textContent = currentRoadSpeedLimit;
        speedLimitBadge.classList.remove('hidden');
      }
      if (speedKmh > (currentRoadSpeedLimit + 3)) {
        speedWarningAlert.classList.remove('hidden');
        if (warningLimitVal) warningLimitVal.textContent = currentRoadSpeedLimit;
      } else {
        speedWarningAlert.classList.add('hidden');
      }

      // HDOP Evaluation
      if (data.hdop !== null && data.hdop !== undefined) {
        const hdopInfo = getHdopQuality(data.hdop);
        hdopRating.textContent = hdopInfo.text;
        hdopRating.className = `hdop-badge ${hdopInfo.className}`;
      }

      // Floating Badges
      floatingCoords.textContent = `${sLat.toFixed(4)}, ${sLng.toFixed(4)}`;
      floatingSpeed.textContent = `${speedKmh.toFixed(1)} km/h`;

      // 3. Move Vehicle Puck Marker & Rotate Heading Arrow
      gpsVehicleMarker.setLngLat([sLng, sLat]);
      if (puckArrowEl) {
        puckArrowEl.style.transform = `rotate(${courseDeg}deg)`;
      }

      // 4. Auto-Follow Camera Management
      if (followMode === '2d') {
        map.panTo([sLng, sLat], { duration: 500, easeId: 'telemetry' });
      } else if (followMode === '3d') {
        map.easeTo({
          center: [sLng, sLat],
          bearing: courseDeg,
          pitch: 58,
          duration: 500
        });
      }

      // 5. Road Snapping Hook
      checkRoadSnapping(sLat, sLng);

      // 6. Navigation Step Tracking
      if (activeRouteData) {
        trackNavigationProgress(sLat, sLng);
      }

      lastGpsPoint = { lat: sLat, lng: sLng, course: courseDeg, speed: speedKmh, alt: altM };

    } else {
      // Searching for satellites / No Fix
      updateFixBadge(false, sats);
      floatingCoords.textContent = sats > 0 ? `Searching (${sats} sats)` : 'Searching...';
      valSpeed.textContent = '0.0';
      valSpeedAlt.textContent = '0.0 mph • 0.0 kn';
      valCourse.textContent = '0.0°';
      valCardinal.textContent = sats > 0 ? `Tracking ${sats} sat${sats === 1 ? '' : 's'}` : 'Searching satellites';
      hdopRating.textContent = 'No Fix';
      hdopRating.className = 'hdop-badge badge-neutral';
      speedWarningAlert.classList.add('hidden');

      if (lastGpsPoint) {
        valLat.textContent = `${lastGpsPoint.lat.toFixed(6)}° (Last)`;
        valLng.textContent = `${lastGpsPoint.lng.toFixed(6)}° (Last)`;
      } else {
        valLat.textContent = 'Searching Sky...';
        valLng.textContent = sats > 0 ? `${sats} sats locked (need 4+)` : 'Antenna needs clear sky view';
      }
    }
  }

  function updateAddressUI(addr) {
    if (!addr) return;
    currentAddressInfo = addr;

    if (valPlaceName) valPlaceName.textContent = addr.placeName || 'Active Location';
    if (valFullAddress) valFullAddress.textContent = addr.fullAddress || 'Address resolving...';
    if (floatingPlace) floatingPlace.textContent = addr.placeName || addr.fullAddress || 'Live Vehicle Target';

    if (tagAddressStatus) {
      tagAddressStatus.textContent = 'Verified';
      tagAddressStatus.classList.add('active');
    }

    if (linkMapsNav && addr.lat && addr.lng) {
      linkMapsNav.href = `https://www.google.com/maps?q=${addr.lat},${addr.lng}`;
    }
  }

  // Copy Address
  if (btnCopyAddress) {
    btnCopyAddress.addEventListener('click', () => {
      const text = valFullAddress?.textContent;
      if (!text || text.includes('Waiting for') || text.includes('Locating')) return;
      navigator.clipboard.writeText(text).then(() => {
        const span = btnCopyAddress.querySelector('span');
        const orig = span ? span.textContent : 'Copy';
        if (span) span.textContent = 'Copied!';
        btnCopyAddress.style.borderColor = 'var(--status-green)';
        setTimeout(() => {
          if (span) span.textContent = orig;
          btnCopyAddress.style.borderColor = '';
        }, 1500);
      });
    });
  }

  // Save Current Location to Favorites
  if (btnSaveAsFav) {
    btnSaveAsFav.addEventListener('click', () => {
      if (!lastGpsPoint) {
        alert('Cannot save favorite: No satellite fix acquired yet.');
        return;
      }
      const placeName = currentAddressInfo?.placeName || 'Saved Pin';
      const address = currentAddressInfo?.fullAddress || `${lastGpsPoint.lat.toFixed(5)}, ${lastGpsPoint.lng.toFixed(5)}`;
      HinaStorage.saveFavorite({
        name: placeName,
        address: address,
        lat: lastGpsPoint.lat,
        lng: lastGpsPoint.lng
      });

      const span = btnSaveAsFav.querySelector('span');
      if (span) span.textContent = 'Saved!';
      btnSaveAsFav.style.borderColor = 'var(--accent-cyan)';
      setTimeout(() => {
        if (span) span.textContent = 'Star';
        btnSaveAsFav.style.borderColor = '';
      }, 1500);
    });
  }

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

    if (monitorPortName) monitorPortName.textContent = portName;
    if (selectMonitorBaud && statusObj.baudRate) selectMonitorBaud.value = String(statusObj.baudRate);
    if (monitorStatusDot) {
      monitorStatusDot.className = 'status-dot';
      if (statusObj.status === 'connected') monitorStatusDot.classList.add('dot-green');
      else if (statusObj.status === 'reconnecting') monitorStatusDot.classList.add('dot-yellow', 'pulse');
      else monitorStatusDot.classList.add('dot-red');
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
      label.textContent = satsCount > 0 ? `Searching (${satsCount} sats)` : 'Searching satellites...';
      badgeFix.title = 'Module requires clear sky view to acquire satellite lock';
    }
  }

  function checkWiringAlert(chars) {
    const alertBanner = document.getElementById('wiring-alert-banner');
    if (!alertBanner) return;
    if (chars === 0) {
      zeroCharsCounter++;
      if (zeroCharsCounter >= 3) alertBanner.classList.remove('hidden');
    } else {
      zeroCharsCounter = 0;
      alertBanner.classList.add('hidden');
    }
  }

  // Ticker for last updated
  setInterval(() => {
    if (!lastFixTimestamp) {
      lastUpdateTime.textContent = 'Waiting for data...';
      return;
    }
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - lastFixTimestamp.getTime()) / 1000));
    lastUpdateTime.textContent = elapsedSeconds <= 1 ? 'Updated just now' : `Updated ${elapsedSeconds}s ago`;
  }, 1000);

  // ==========================================================================
  // 7. Turn-by-Turn Navigation & Routing Engine
  // ==========================================================================

  function getManeuverSvg(type, modifier) {
    if (type === 'arrive') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>';
    }
    if (modifier && modifier.includes('left')) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 4 4v6"/></svg>';
    }
    if (modifier && modifier.includes('right')) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 14l4-4-4-4"/><path d="M19 10H8a4 4 0 0 0-4 4v6"/></svg>';
    }
    if (modifier && modifier.includes('u-turn')) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  }

  function renderRouteOnMap(routeData) {
    if (!routeData) return;
    const primSrc = map.getSource('nav-route-primary');
    if (primSrc && routeData.routes && routeData.routes[0]) {
      primSrc.setData({
        type: 'Feature',
        geometry: routeData.routes[0].geometry,
        properties: {}
      });
    }

    const altSrc = map.getSource('nav-route-alt');
    if (altSrc) {
      if (routeData.routes && routeData.routes[1]) {
        altSrc.setData({
          type: 'Feature',
          geometry: routeData.routes[1].geometry,
          properties: {}
        });
      } else {
        altSrc.setData({ type: 'FeatureCollection', features: [] });
      }
    }
  }

  async function initiateNavigation(startLat, startLng, endLat, endLng, destinationName) {
    try {
      const url = `/api/routing/route?startLat=${startLat}&startLng=${startLng}&endLat=${endLat}&endLng=${endLng}&alternatives=true`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data || !data.success || !data.routes || data.routes.length === 0) {
        alert('Could not compute driving route to destination.');
        return;
      }

      activeRouteData = data;
      currentStepIndex = 0;

      // Place destination pin
      destinationMarker.setLngLat([endLng, endLat]).addTo(map);

      // Render routes on map
      renderRouteOnMap(data);

      // Fit map bounds to view full route initially
      const coords = data.routes[0].geometry.coordinates;
      const bounds = coords.reduce((b, coord) => b.extend(coord), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 90, maxZoom: 17, duration: 800 });

      // Show Navigation Guidance Banner
      navGuidanceBanner.classList.remove('hidden');

      // Set follow mode to 3D driving view
      setFollowMode('3d');

      // Present first step & vocalize
      updateNavBannerStep();
      const firstStep = data.routes[0].steps[0];
      if (firstStep) {
        voiceGuide.speak(`Starting route to ${destinationName}. ${firstStep.instruction || 'Follow highlighted road.'}`);
      }

    } catch (err) {
      console.error('Route calculation error:', err);
      alert('Failed to calculate navigation route.');
    }
  }

  function updateNavBannerStep() {
    if (!activeRouteData || !activeRouteData.routes[0]) return;
    const route = activeRouteData.routes[0];
    const steps = route.steps;
    if (currentStepIndex >= steps.length) {
      // Arrived at destination
      navDistanceCallout.textContent = 'Arrived!';
      navInstructionText.textContent = 'You have reached your destination.';
      navManeuverIcon.innerHTML = getManeuverSvg('arrive', '');
      voiceGuide.speak('You have arrived at your destination.');
      return;
    }

    const step = steps[currentStepIndex];
    const distM = Math.round(step.distance);
    navDistanceCallout.textContent = distM >= 1000 ? `In ${(distM / 1000).toFixed(1)} km` : `In ${distM} m`;
    navInstructionText.textContent = step.instruction || 'Proceed on route';
    navManeuverIcon.innerHTML = getManeuverSvg(step.maneuver?.type, step.maneuver?.modifier);

    // Remaining distance & ETA
    let remDistM = 0;
    let remSec = 0;
    for (let i = currentStepIndex; i < steps.length; i++) {
      remDistM += steps[i].distance;
      remSec += steps[i].duration;
    }
    navRemainingDist.textContent = `${(remDistM / 1000).toFixed(1)} km`;

    const etaDate = new Date(Date.now() + remSec * 1000);
    const etaStr = `${String(etaDate.getHours()).padStart(2, '0')}:${String(etaDate.getMinutes()).padStart(2, '0')}`;
    navEtaTime.textContent = etaStr;
  }

  function trackNavigationProgress(vehicleLat, vehicleLng) {
    if (!activeRouteData || !activeRouteData.routes[0]) return;
    const route = activeRouteData.routes[0];
    const steps = route.steps;
    if (currentStepIndex >= steps.length) return;

    const currentStep = steps[currentStepIndex];
    if (currentStep && currentStep.location) {
      const stepLng = currentStep.location[0];
      const stepLat = currentStep.location[1];
      const distToStepKm = haversineDistanceKm(vehicleLat, vehicleLng, stepLat, stepLng);

      // Within 25 meters of maneuver point -> advance step
      if (distToStepKm < 0.025) {
        currentStepIndex++;
        updateNavBannerStep();
        if (currentStepIndex < steps.length) {
          voiceGuide.speak(steps[currentStepIndex].instruction);
        }
      }
    }

    // Auto-Reroute Check: If vehicle deviates > 55m from the route polyline
    const now = Date.now();
    if (now - lastRerouteTimestamp > 12000) {
      // Find closest distance to route coordinates
      const coords = route.geometry.coordinates;
      let minDeviationKm = 999;
      for (let i = 0; i < coords.length; i += 2) {
        const d = haversineDistanceKm(vehicleLat, vehicleLng, coords[i][1], coords[i][0]);
        if (d < minDeviationKm) minDeviationKm = d;
      }

      if (minDeviationKm > 0.055) {
        // Vehicle is off-route by > 55 meters -> Auto-Reroute!
        lastRerouteTimestamp = now;
        const endCoord = coords[coords.length - 1];
        voiceGuide.speak('Off route. Recalculating directions.');
        initiateNavigation(vehicleLat, vehicleLng, endCoord[1], endCoord[0], 'Destination');
      }
    }
  }

  // Voice Toggle Button
  if (btnVoiceToggle) {
    btnVoiceToggle.addEventListener('click', () => {
      const isMuted = voiceGuide.toggle();
      iconVoiceOn.classList.toggle('hidden', isMuted);
      iconVoiceOff.classList.toggle('hidden', !isMuted);
    });
  }

  // Stop Navigation Button
  if (btnStopNav) {
    btnStopNav.addEventListener('click', () => {
      activeRouteData = null;
      navGuidanceBanner.classList.add('hidden');
      destinationMarker.remove();

      const primSrc = map.getSource('nav-route-primary');
      if (primSrc) primSrc.setData({ type: 'FeatureCollection', features: [] });
      const altSrc = map.getSource('nav-route-alt');
      if (altSrc) altSrc.setData({ type: 'FeatureCollection', features: [] });

      setFollowMode('2d');
      voiceGuide.speak('Navigation ended.');
    });
  }

  // ==========================================================================
  // 8. Place Search & Autocomplete
  // ==========================================================================

  let searchDebounceTimer = null;

  function renderSearchSuggestions(results) {
    searchSuggestions.innerHTML = '';
    if (!results || results.length === 0) {
      searchSuggestions.classList.add('hidden');
      return;
    }

    results.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'suggestion-item';
      el.innerHTML = `
        <div class="suggestion-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
            <circle cx="12" cy="9" r="2.5"/>
          </svg>
          <span>${item.name || item.street || 'Place'}</span>
        </div>
        <div class="suggestion-sub">${item.fullAddress || item.city || ''}</div>
      `;

      el.addEventListener('click', () => {
        searchSuggestions.classList.add('hidden');
        searchInput.value = item.name || item.fullAddress;
        btnClearSearch.classList.remove('hidden');

        // Fly to location
        map.flyTo({
          center: [item.lng, item.lat],
          zoom: 17,
          essential: true
        });

        // Prompt or start navigation if GPS is active
        if (lastGpsPoint) {
          initiateNavigation(lastGpsPoint.lat, lastGpsPoint.lng, item.lat, item.lng, item.name);
        } else {
          destinationMarker.setLngLat([item.lng, item.lat]).addTo(map);
        }
      });

      searchSuggestions.appendChild(el);
    });

    searchSuggestions.classList.remove('hidden');
  }

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    btnClearSearch.classList.toggle('hidden', query.length === 0);

    if (query.length < 2) {
      searchSuggestions.classList.add('hidden');
      return;
    }

    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(async () => {
      // Check if coordinates entered directly (lat, lng)
      const coordMatch = query.match(/^([-+]?[0-9]*\.?[0-9]+)\s*,\s*([-+]?[0-9]*\.?[0-9]+)$/);
      if (coordMatch) {
        const cLat = parseFloat(coordMatch[1]);
        const cLng = parseFloat(coordMatch[2]);
        if (cLat >= -90 && cLat <= 90 && cLng >= -180 && cLng <= 180) {
          renderSearchSuggestions([{
            name: `Coordinates: ${cLat.toFixed(5)}, ${cLng.toFixed(5)}`,
            fullAddress: 'Direct GPS Coordinate Pin',
            lat: cLat,
            lng: cLng
          }]);
          return;
        }
      }

      try {
        const res = await fetch(`/api/geocode/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (data && data.success && Array.isArray(data.results)) {
          renderSearchSuggestions(data.results);
        }
      } catch (err) {
        console.warn('Geocode search autocomplete error:', err);
      }
    }, 280);
  });

  btnClearSearch.addEventListener('click', () => {
    searchInput.value = '';
    btnClearSearch.classList.add('hidden');
    searchSuggestions.classList.add('hidden');
  });

  // Hide suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      searchSuggestions.classList.add('hidden');
    }
  });

  // ==========================================================================
  // 9. Modals: Favorites & Trip History
  // ==========================================================================

  function renderFavoritesList() {
    favoritesList.innerHTML = '';
    const favs = HinaStorage.getFavorites();
    if (favs.length === 0) {
      favoritesList.innerHTML = '<div style="color:var(--text-muted); padding:16px; text-align:center;">No saved places yet. Click the Star button to save places!</div>';
      return;
    }

    favs.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'saved-item';
      el.innerHTML = `
        <div class="saved-item-info">
          <div class="saved-item-name">⭐ ${item.name}</div>
          <div class="saved-item-sub">${item.address || `${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}`}</div>
        </div>
        <div class="saved-item-actions">
          <button class="btn btn-secondary btn-xs btn-nav-fav" title="Navigate here">🚗 Go</button>
          <button class="btn btn-secondary btn-xs btn-del-fav" style="color:var(--status-red);" title="Delete">&times;</button>
        </div>
      `;

      el.querySelector('.btn-nav-fav').addEventListener('click', () => {
        modalFavorites.classList.add('hidden');
        if (lastGpsPoint) {
          initiateNavigation(lastGpsPoint.lat, lastGpsPoint.lng, item.lat, item.lng, item.name);
        } else {
          map.flyTo({ center: [item.lng, item.lat], zoom: 17 });
          destinationMarker.setLngLat([item.lng, item.lat]).addTo(map);
        }
      });

      el.querySelector('.btn-del-fav').addEventListener('click', () => {
        HinaStorage.deleteFavorite(item.id);
        renderFavoritesList();
      });

      favoritesList.appendChild(el);
    });
  }

  function renderTripHistoryList() {
    tripHistoryList.innerHTML = '';
    const trips = HinaStorage.getTrips();
    if (trips.length === 0) {
      tripHistoryList.innerHTML = '<div style="color:var(--text-muted); padding:16px; text-align:center;">No completed trips archived yet.</div>';
      return;
    }

    trips.forEach((trip) => {
      const dateStr = new Date(trip.timestamp).toLocaleString();
      const el = document.createElement('div');
      el.className = 'saved-item';
      el.innerHTML = `
        <div class="saved-item-info">
          <div class="saved-item-name">🚗 Trip (${dateStr})</div>
          <div class="saved-item-sub">Dist: ${trip.distanceKm.toFixed(2)} km &bull; Dur: ${formatDuration(trip.durationSec)} &bull; Avg: ${trip.avgSpeed.toFixed(1)} km/h</div>
        </div>
        <div class="saved-item-actions">
          <button class="btn btn-secondary btn-xs btn-gpx">GPX</button>
        </div>
      `;

      el.querySelector('.btn-gpx').addEventListener('click', () => {
        HinaStorage.exportAsGpx(trip.points);
      });

      tripHistoryList.appendChild(el);
    });
  }

  btnOpenFavorites.addEventListener('click', () => {
    modalFavorites.classList.remove('hidden');
    renderFavoritesList();
  });

  btnCloseFavorites.addEventListener('click', () => {
    modalFavorites.classList.add('hidden');
  });

  modalTabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      modalTabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      if (tab === 'favs') {
        tabFavsContent.classList.remove('hidden');
        tabHistoryContent.classList.add('hidden');
        renderFavoritesList();
      } else {
        tabFavsContent.classList.add('hidden');
        tabHistoryContent.classList.remove('hidden');
        renderTripHistoryList();
      }
    });
  });

  // Export Menu Toggle
  btnExportMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', () => {
    exportDropdown.classList.add('hidden');
  });

  // Theme Toggle
  function applyTheme(theme) {
    currentTheme = theme;
    elHtml.setAttribute('data-theme', theme);
    safeStorageSet('hina_theme', theme);
  }

  btnThemeToggle.addEventListener('click', () => {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });

  // Fullscreen Toggle
  btnFullscreenToggle.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // Mobile Drawer Toggle
  btnSidebarToggle.addEventListener('click', () => {
    telemetryPanel.classList.toggle('collapsed');
  });

  // ==========================================================================
  // 10. Hardware USB Serial Monitor Controller
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

    const timeEl = document.createElement('span');
    timeEl.className = 'term-time';
    if (!chkTimestamp?.checked) timeEl.classList.add('hidden');
    timeEl.textContent = `[${formatLogTime(entry.timestamp)}]`;

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

    const contentEl = document.createElement('span');
    contentEl.className = 'term-content';

    if (entry.type === 'json') {
      contentEl.classList.add('content-json');
      if (lineText.includes('"fix":true')) contentEl.classList.add('has-fix');
      else if (lineText.includes('"fix":false')) contentEl.classList.add('no-fix');
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

    while (terminalBody.children.length > 400) {
      terminalBody.removeChild(terminalBody.firstChild);
    }

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

      line.classList.toggle('hidden-by-filter', !matchesSearch || !matchesCategory);
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
      if (chkAutoscroll?.checked) terminalBody.scrollTop = terminalBody.scrollHeight;
      setTimeout(() => inputSerialCommand?.focus(), 150);
    } else {
      serialDrawer.classList.add('hidden');
      btnSerialMonitor?.classList.remove('active');
    }
  }

  btnSerialMonitor?.addEventListener('click', () => toggleSerialDrawer());
  btnCloseConsole?.addEventListener('click', () => toggleSerialDrawer(false));

  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      filterChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter || 'all';
      applyFilterToAllLines();
    });
  });

  serialFilterInput?.addEventListener('input', applyFilterToAllLines);

  chkTimestamp?.addEventListener('change', () => {
    const show = chkTimestamp.checked;
    terminalBody.querySelectorAll('.term-time').forEach((el) => el.classList.toggle('hidden', !show));
  });

  btnClearConsole?.addEventListener('click', () => {
    terminalBody.innerHTML = '<div class="terminal-waiting">Console cleared. Waiting for serial data...</div>';
    if (socket) socket.emit('serial:clear');
  });

  btnCopyConsole?.addEventListener('click', () => {
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
    });
  });

  btnPauseConsole?.addEventListener('click', () => {
    isConsolePaused = !isConsolePaused;
    iconPause?.classList.toggle('hidden', isConsolePaused);
    iconPlay?.classList.toggle('hidden', !isConsolePaused);
    btnPauseConsole.title = isConsolePaused ? 'Resume Streaming' : 'Pause Streaming';
    btnPauseConsole.style.color = isConsolePaused ? '#f59e0b' : '';
    if (!isConsolePaused && chkAutoscroll?.checked) {
      terminalBody.scrollTop = terminalBody.scrollHeight;
    }
  });

  btnExpandConsole?.addEventListener('click', () => {
    const isMax = serialDrawer.classList.toggle('maximized');
    iconMaximize?.classList.toggle('hidden', isMax);
    iconRestore?.classList.toggle('hidden', !isMax);
    btnExpandConsole.title = isMax ? 'Restore Height' : 'Maximize Console';
  });

  selectMonitorBaud?.addEventListener('change', () => {
    if (socket) socket.emit('serial:set-baud', selectMonitorBaud.value);
  });

  formSerialSend?.addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = (inputSerialCommand?.value || '').trim();
    if (!cmd) return;
    const ending = selectCommandEnding ? selectCommandEnding.value : '\r\n';
    if (socket) socket.emit('serial:send', { data: cmd, lineEnding: ending });
    if (inputSerialCommand) inputSerialCommand.value = '';
  });

  // Dynamic Serial Ports Dropdown
  function renderPortsDropdown(data) {
    if (!data || !Array.isArray(data.ports)) return;
    const currentPort = (data.currentPort || '').toUpperCase();
    const isAuto = data.autoDetect !== false;
    selectSerialPort.innerHTML = '';

    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = '⚡ Auto-Detect (Plug & Play)';
    if (isAuto) autoOpt.selected = true;
    selectSerialPort.appendChild(autoOpt);

    const usbGroup = document.createElement('optgroup');
    usbGroup.label = 'Hardware / USB Devices';

    const btGroup = document.createElement('optgroup');
    btGroup.label = 'Bluetooth Ports (Ignored by Auto)';

    data.ports.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.path;
      let label = p.path;
      if (p.isEspCandidate) label += ` (ESP32 - ${p.friendlyName.replace(/\s*\(COM\d+\)/i, '')})`;
      else if (p.isBluetooth) label += ` (Bluetooth)`;
      else label += ` (${p.friendlyName ? p.friendlyName.replace(/\s*\(COM\d+\)/i, '') : p.manufacturer})`;
      opt.textContent = label;

      if (!isAuto && p.path.toUpperCase() === currentPort) opt.selected = true;
      if (p.isBluetooth) btGroup.appendChild(opt);
      else usbGroup.appendChild(opt);
    });

    if (usbGroup.children.length > 0) selectSerialPort.appendChild(usbGroup);
    if (btGroup.children.length > 0) selectSerialPort.appendChild(btGroup);
  }

  async function loadSerialPorts() {
    try {
      const response = await fetch('/api/ports');
      const data = await response.json();
      if (data.success) renderPortsDropdown(data);
    } catch (err) {
      console.warn('Could not load serial ports:', err.message);
    }
  }

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

  if (btnRefreshPorts) {
    btnRefreshPorts.addEventListener('click', async () => {
      btnRefreshPorts.classList.add('spinning');
      if (socket) {
        socket.emit('ports:refresh');
        socket.emit('serial:reconnect');
      }
      await loadSerialPorts();
      setTimeout(() => btnRefreshPorts.classList.remove('spinning'), 800);
    });
  }

  if (badgeSerial) {
    badgeSerial.addEventListener('click', () => {
      if (socket) {
        socket.emit('serial:reconnect');
        socket.emit('ports:refresh');
      }
      loadSerialPorts();
    });
  }

  // ==========================================================================
  // 11. Socket.IO Streaming Connection
  // ==========================================================================

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

  socket.on('ports:list', (payload) => {
    renderPortsDropdown(payload);
  });

  socket.on('gps:init', (payload) => {
    if (!payload) return;

    if (payload.serialStatus) updateSerialBadge(payload.serialStatus);
    if (payload.config) {
      renderPortsDropdown({
        ports: [],
        currentPort: payload.config.port,
        autoDetect: payload.config.autoDetect
      });
    }

    // Populate trail history from server
    if (Array.isArray(payload.history) && payload.history.length > 0) {
      for (let i = 1; i < payload.history.length; i++) {
        const p1 = payload.history[i - 1];
        const p2 = payload.history[i];
        if (typeof p1.lat === 'number' && typeof p2.lat === 'number') {
          appendTrailSegment(p1, p2, p2.speed || 0);
        }
      }
      const latestFix = payload.history[payload.history.length - 1];
      lastGpsPoint = { lat: latestFix.lat, lng: latestFix.lng, course: latestFix.course || 0 };
      map.setCenter([latestFix.lng, latestFix.lat]);
      gpsVehicleMarker.setLngLat([latestFix.lng, latestFix.lat]);
    }

    if (payload.current) processGpsData(payload.current);
    if (payload.address) updateAddressUI(payload.address);

    if (Array.isArray(payload.serialLogs) && payload.serialLogs.length > 0) {
      terminalBody.innerHTML = '';
      payload.serialLogs.forEach((entry) => appendTerminalLine(entry));
    }
  });

  socket.on('gps:address', (addr) => {
    updateAddressUI(addr);
  });

  socket.on('serial:line', (entry) => {
    triggerSerialPulse();
    appendTerminalLine(entry);
  });

  socket.on('serial:history', (logs) => {
    if (Array.isArray(logs) && logs.length > 0) {
      terminalBody.innerHTML = '';
      logs.forEach((entry) => appendTerminalLine(entry));
    }
  });

  socket.on('serial:cleared', () => {
    terminalBody.innerHTML = '<div class="terminal-waiting">Console buffer cleared.</div>';
  });

  socket.on('gps:update', (data) => {
    processGpsData(data);
  });

  socket.on('gps:trail-cleared', () => {
    trailSegments.length = 0;
    updateMapTrailSource();
    totalDistanceKm = 0;
    valDistance.textContent = '0.00 km';
  });

  // Initial calls
  loadSerialPorts();

})();
