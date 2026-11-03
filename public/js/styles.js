/**
 * Hina Maps - MapLibre GL Vector & Raster Style Catalog
 * Supports Satellite, Hybrid, Streets (Carto Voyager), Dark (Carto Dark Matter), and Topo Terrain.
 * All styles support overzooming up to zoom 22.
 */

const HinaMapStyles = {
  // 1. Satellite Hybrid: High-Res Esri Satellite + Protomaps Vector Roads, Labels & 3D Buildings
  hybrid: {
    version: 8,
    name: 'Hina Satellite Hybrid',
    maxZoom: 22,
    sources: {
      'esri-satellite': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics'
      },
      'esri-places': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Labels &copy; Esri'
      },
      'esri-roads': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Roads &copy; Esri'
      },
      'protomaps': {
        type: 'vector',
        tiles: [
          'https://tiles.basemaps.cartocdn.com/v/20261026-01/vectortiles/carto.streets/v2/{z}/{x}/{y}.mvt'
        ],
        minzoom: 0,
        maxzoom: 15,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
      }
    },
    layers: [
      {
        id: 'satellite-base',
        type: 'raster',
        source: 'esri-satellite',
        paint: {
          'raster-resampling': 'linear',
          'raster-opacity': 1.0
        }
      },
      {
        id: 'roads-overlay',
        type: 'raster',
        source: 'esri-roads',
        paint: {
          'raster-resampling': 'linear',
          'raster-opacity': 0.85
        }
      },
      {
        id: 'places-overlay',
        type: 'raster',
        source: 'esri-places',
        paint: {
          'raster-resampling': 'linear',
          'raster-opacity': 1.0
        }
      }
    ]
  },

  // 2. Pure Satellite: Clean imagery with maximum resolution and overzoom
  satellite: {
    version: 8,
    name: 'Hina Pure Satellite',
    maxZoom: 22,
    sources: {
      'esri-satellite': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics'
      }
    },
    layers: [
      {
        id: 'satellite-base',
        type: 'raster',
        source: 'esri-satellite',
        paint: {
          'raster-resampling': 'linear',
          'raster-opacity': 1.0
        }
      }
    ]
  },

  // 3. Streets: Complete Carto Voyager vector style
  streets: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',

  // 4. Dark Mode: Carto Dark Matter vector style
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',

  // 5. Topographic Terrain: OpenTopoMap with elevation contours & hillshade
  terrain: {
    version: 8,
    name: 'Hina Topo Terrain',
    maxZoom: 20,
    sources: {
      'opentopomap': {
        type: 'raster',
        tiles: [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        maxzoom: 17,
        attribution: 'Map data: &copy; OpenStreetMap, SRTM | Style: &copy; OpenTopoMap'
      }
    },
    layers: [
      {
        id: 'opentopo-base',
        type: 'raster',
        source: 'opentopomap',
        paint: {
          'raster-resampling': 'linear',
          'raster-opacity': 1.0
        }
      }
    ]
  }
};

/**
 * Injects 3D buildings into any compatible vector style
 */
function inject3dBuildings(map, show = true) {
  if (!map) return;
  const layerId = 'hina-3d-buildings';

  if (!show) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    return;
  }

  // Check if protomaps source exists
  if (!map.getSource('protomaps')) return;
  if (map.getLayer(layerId)) return;

  try {
    map.addLayer({
      id: layerId,
      source: 'protomaps',
      'source-layer': 'buildings',
      type: 'fill-extrusion',
      minzoom: 14.5,
      paint: {
        'fill-extrusion-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'height'], ['*', ['get', 'levels'], 3.2], 10],
          0, '#334155',
          15, '#0284c7',
          35, '#06b6d4',
          70, '#38bdf8'
        ],
        'fill-extrusion-height': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14.5, 0,
          15.2, ['coalesce', ['get', 'height'], ['*', ['get', 'levels'], 3.2], 12]
        ],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.85
      }
    });
  } catch (err) {
    console.warn('[MapLibre] Could not inject 3D buildings:', err.message);
  }
}

/**
 * Returns road color classification based on road type
 */
function getRoadClassColor(type) {
  switch (type) {
    case 'motorway':
    case 'highway':
      return '#f59e0b'; // Amber / Gold
    case 'trunk':
    case 'primary':
      return '#0284c7'; // Blue
    case 'secondary':
      return '#06b6d4'; // Cyan
    case 'tertiary':
      return '#64748b'; // Slate
    default:
      return '#94a3b8'; // Neutral
  }
}

/**
 * Determines speed color coding for the GPS trail
 */
function getSpeedColor(speedKmh) {
  if (speedKmh <= 0) return '#64748b'; // Gray for stationary
  if (speedKmh < 25) return '#10b981'; // Green (slow/cruising)
  if (speedKmh < 50) return '#06b6d4'; // Cyan
  if (speedKmh < 75) return '#f59e0b'; // Amber / Moderate
  return '#ef4444'; // Red (High speed / over speed)
}

HinaMapStyles.inject3dBuildings = inject3dBuildings;
HinaMapStyles.getSpeedColor = getSpeedColor;
HinaMapStyles.getRoadClassColor = getRoadClassColor;

if (typeof window !== 'undefined') {
  window.HinaMapStyles = HinaMapStyles;
  window.inject3dBuildings = inject3dBuildings;
  window.getSpeedColor = getSpeedColor;
  window.getRoadClassColor = getRoadClassColor;
}
