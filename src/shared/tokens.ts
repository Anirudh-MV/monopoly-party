// ── Player pieces ──
// The one and only list of allowed player emojis, shared by the phone
// join screen and the server's validation. Names are always emoji-stripped
// (server-side too — never trust the client).

export const TOKENS: string[] = [
  '🎩', '🚗', '🐕', '🚢', '👞', '🐈', '🛴', '🦆',
  '🚂', '🚁', '🛩️', '🐎', '🐘', '🚀', '⭐', '🍒',
]

// Strip emojis, variation selectors, and zero-width joiners; collapse spaces.
export function stripEmoji(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}
