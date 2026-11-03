/**
 * Hina Maps - Storage & Data Export Module
 * Manages saved favorite places, trip archives, and client-side GPX/GeoJSON exports.
 */
const HinaStorage = {
  KEY_FAVORITES: 'hina_favorites',
  KEY_TRIPS: 'hina_trip_history',

  safeGet(key, fallback) {
    try {
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : fallback;
    } catch {
      return fallback;
    }
  },

  safeSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('[Storage] Write failed:', e.message);
    }
  },

  // --- Favorite Places ---
  getFavorites() {
    return this.safeGet(this.KEY_FAVORITES, [
      { id: 'fav_charminar', name: 'Charminar', address: 'Charminar Rd, Hyderabad', lat: 17.3616, lng: 78.4747 },
      { id: 'fav_rgia', name: 'Rajiv Gandhi International Airport (HYD)', address: 'Shamshabad, Hyderabad', lat: 17.2403, lng: 78.4294 },
      { id: 'fav_hitech', name: 'HITEC City Cyber Towers', address: 'Madhapur, Hyderabad', lat: 17.4504, lng: 78.3808 }
    ]);
  },

  addFavorite(place) {
    const list = this.getFavorites();
    const id = 'fav_' + Date.now();
    const item = {
      id,
      name: place.name || 'Saved Place',
      address: place.address || place.description || '',
      lat: place.lat,
      lng: place.lng,
      timestamp: new Date().toISOString()
    };
    list.unshift(item);
    this.safeSet(this.KEY_FAVORITES, list.slice(0, 50));
    return item;
  },

  removeFavorite(id) {
    const list = this.getFavorites().filter(f => f.id !== id);
    this.safeSet(this.KEY_FAVORITES, list);
    return list;
  },

  isFavorite(lat, lng, radius = 0.0005) {
    const list = this.getFavorites();
    return list.some(f => Math.abs(f.lat - lat) < radius && Math.abs(f.lng - lng) < radius);
  },

  // --- Trip History ---
  getTrips() {
    return this.safeGet(this.KEY_TRIPS, []);
  },

  saveTrip(trip) {
    const list = this.getTrips();
    const item = {
      id: 'trip_' + Date.now(),
      startTime: trip.startTime || new Date().toISOString(),
      endTime: new Date().toISOString(),
      distanceKm: Number((trip.distanceKm || 0).toFixed(2)),
      durationSec: trip.durationSec || 0,
      avgSpeedKmh: Number((trip.avgSpeedKmh || 0).toFixed(1)),
      maxSpeedKmh: Number((trip.maxSpeedKmh || 0).toFixed(1)),
      startAddress: trip.startAddress || '',
      endAddress: trip.endAddress || '',
      pointsCount: (trip.points || []).length
    };
    list.unshift(item);
    this.safeSet(this.KEY_TRIPS, list.slice(0, 30));
    return item;
  },

  // --- File Download Helpers ---
  triggerDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  },

  exportGpx(points, filename = 'hina_maps_track.gpx') {
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gpx += `<gpx version="1.1" creator="Hina Maps" xmlns="http://www.topografix.com/GPX/1/1">\n`;
    gpx += `  <metadata>\n    <name>Hina Maps GPS Track</name>\n    <time>${new Date().toISOString()}</time>\n  </metadata>\n`;
    gpx += `  <trk>\n    <name>Recorded Path</name>\n    <trkseg>\n`;

    for (const pt of points) {
      gpx += `      <trkpt lat="${pt.lat}" lon="${pt.lng}">\n`;
      if (pt.alt !== undefined) gpx += `        <ele>${pt.alt}</ele>\n`;
      if (pt.timestamp) gpx += `        <time>${pt.timestamp}</time>\n`;
      if (pt.speed !== undefined) gpx += `        <speed>${(pt.speed / 3.6).toFixed(2)}</speed>\n`;
      gpx += `      </trkpt>\n`;
    }

    gpx += `    </trkseg>\n  </trk>\n</gpx>`;
    this.triggerDownload(filename, gpx, 'application/gpx+xml; charset=utf-8');
  },

  exportGeoJson(points, filename = 'hina_maps_track.geojson') {
    const coordinates = points.map(p => [p.lng, p.lat, p.alt || 0]);
    const geojson = {
      type: 'FeatureCollection',
      name: 'Hina Maps Live Track',
      features: [
        {
          type: 'Feature',
          properties: {
            title: 'Hina Maps Track',
            timestamp: new Date().toISOString(),
            pointsCount: points.length
          },
          geometry: {
            type: 'LineString',
            coordinates: coordinates
          }
        }
      ]
    };
    this.triggerDownload(filename, JSON.stringify(geojson, null, 2), 'application/geo+json; charset=utf-8');
  }
};

if (typeof window !== 'undefined') {
  window.HinaStorage = HinaStorage;
}
