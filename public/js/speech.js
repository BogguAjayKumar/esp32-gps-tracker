/**
 * Hina Maps - Spoken Navigation & Audio Guidance
 * Powered by Web Speech API (speechSynthesis)
 */
class NavigationVoiceGuide {
  constructor() {
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    this.muted = this.loadMutedPreference();
    this.lastSpokenText = '';
    this.lastSpokenTime = 0;
  }

  loadMutedPreference() {
    try {
      return localStorage.getItem('hina_voice_muted') === 'true';
    } catch {
      return false;
    }
  }

  setMuted(muted) {
    this.muted = !!muted;
    try {
      localStorage.setItem('hina_voice_muted', this.muted);
    } catch {}
    if (this.muted && this.synth) {
      this.synth.cancel();
    }
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  isMuted() {
    return this.muted;
  }

  isSupported() {
    return !!this.synth;
  }

  speak(text, force = false) {
    if (!text || this.muted || !this.synth) return;

    // Avoid immediate repetitive utterances within 8 seconds
    const now = Date.now();
    if (!force && text === this.lastSpokenText && (now - this.lastSpokenTime) < 8000) {
      return;
    }

    this.lastSpokenText = text;
    this.lastSpokenTime = now;

    try {
      this.synth.cancel(); // Stop any pending utterance to avoid lag
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05; // Slightly brisk driving pace
      utterance.pitch = 1.0;
      utterance.lang = 'en-US';

      // Pick natural English voice if available
      const voices = this.synth.getVoices();
      const preferred = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Samantha')));
      if (preferred) {
        utterance.voice = preferred;
      }

      this.synth.speak(utterance);
    } catch (err) {
      console.warn('[VoiceGuide] Speech synthesis error:', err.message);
    }
  }
}

if (typeof window !== 'undefined') {
  window.voiceGuide = new NavigationVoiceGuide();
}
