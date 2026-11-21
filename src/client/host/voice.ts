// ── TV voice ──
// The announcer: speech synthesis narrates the big moments on the TV, and
// the two party sounds (Chance "hee-hee", Community Chest "bruh") are
// synthesized too — no audio files to ship, nothing to license.
// Browsers gate audio behind a user gesture; the first tap anywhere on
// the TV unlocks it. The 🔊 toggle remembers its state.

let enabled = (localStorage.getItem('mp-voice') ?? 'on') === 'on'

export function voiceEnabled(): boolean {
  return enabled
}

export function setVoiceEnabled(on: boolean): void {
  enabled = on
  localStorage.setItem('mp-voice', on ? 'on' : 'off')
  if (!('speechSynthesis' in window)) return
  if (!on) window.speechSynthesis.cancel()
  else speak('Voice on')
}

// Any interaction with the TV unlocks speech for the session.
export function unlockAudio(): void {
  if (!('speechSynthesis' in window)) return
  try {
    // Chrome suspends the queue until a gesture; a resume() at tap time
    // flushes anything announced while it was locked.
    void window.speechSynthesis.resume()
  } catch {
    /* ignore */
  }
}

function speak(text: string, opts: { pitch?: number; rate?: number } = {}): void {
  if (!enabled || !('speechSynthesis' in window)) return
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.rate = opts.rate ?? 1.05
    u.pitch = opts.pitch ?? 1
    u.volume = 1
    window.speechSynthesis.speak(u)
  } catch {
    /* ignore */
  }
}

export function announce(text: string): void {
  speak(text)
}

// Chance: a synthesized giggle — the vibe without shipping anyone's voice.
export function heeHee(): void {
  speak('hee hee', { pitch: 1.8, rate: 1.5 })
}

// Community Chest: the reaction, deadpan.
export function bruh(): void {
  speak('bruh', { pitch: 0.55, rate: 0.85 })
}
