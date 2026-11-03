/**
 * Hina Maps - 2D GPS Kalman Filter
 * Smooths jittery GPS coordinates and rejects erratic noise spikes.
 */
class GpsKalmanFilter {
  constructor(options = {}) {
    this.processNoise = options.processNoise || 3.0;
    this.measurementNoise = options.measurementNoise || 6.0;
    this.lat = null;
    this.lng = null;
    this.variance = -1;
    this.lastTimestamp = null;
  }

  reset() {
    this.lat = null;
    this.lng = null;
    this.variance = -1;
    this.lastTimestamp = null;
  }

  /**
   * Updates state with new raw GPS reading.
   * @param {number} rawLat 
   * @param {number} rawLng 
   * @param {number} accuracy - HDOP or estimated accuracy in meters
   * @param {number} timestamp - Unix timestamp in ms
   * @returns {{ lat: number, lng: number, smoothed: boolean }}
   */
  update(rawLat, rawLng, accuracy = 5, timestamp = Date.now()) {
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng)) {
      return { lat: this.lat || rawLat, lng: this.lng || rawLng, smoothed: false };
    }

    // First fix initialization
    if (this.variance < 0 || this.lat === null) {
      this.lat = rawLat;
      this.lng = rawLng;
      this.variance = accuracy * accuracy;
      this.lastTimestamp = timestamp;
      return { lat: rawLat, lng: rawLng, smoothed: false };
    }

    const dt = Math.max(0.1, Math.min(10, (timestamp - this.lastTimestamp) / 1000));
    this.lastTimestamp = timestamp;

    // 1. Prediction step
    this.variance += this.processNoise * this.processNoise * dt;

    // 2. Correction step (Kalman gain)
    const measVar = Math.max(1, accuracy * accuracy);
    const k = this.variance / (this.variance + measVar);

    this.lat += k * (rawLat - this.lat);
    this.lng += k * (rawLng - this.lng);
    this.variance = (1 - k) * this.variance;

    return {
      lat: Number(this.lat.toFixed(6)),
      lng: Number(this.lng.toFixed(6)),
      smoothed: true
    };
  }
}

if (typeof window !== 'undefined') {
  window.GpsKalmanFilter = GpsKalmanFilter;
}
