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

// ── card sounds ──
// The real party clips (Chance: the giggle, Community Chest: the reaction),
// shipped as tiny mp3s in public/sounds/ and cached once. Playback follows
// the same 🔊 toggle; the first tap on the TV unlocks it.
const effects: Record<string, HTMLAudioElement> = {}

function playEffect(url: string): void {
  if (!enabled) return
  try {
    const a = effects[url] ?? (effects[url] = new Audio(url))
    a.currentTime = 0
    a.volume = 1
    void a.play().catch(() => {
      /* autoplay still locked — the next tap unlocks it */
    })
  } catch {
    /* ignore */
  }
}

// Chance: the giggle.
export function heeHee(): void {
  playEffect('sounds/hehe.mp3')
}

// Community Chest: the reaction.
export function bruh(): void {
  playEffect('sounds/bruh.mp3')
}
