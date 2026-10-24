export type Fix = { from: string; to: string; why: string }
export type Word = { word: string; meaning: string }
// A question the person asked about one card, and the answer. `about` is the
// block it asked about: 0 the feedback, n the card's nth follow-up.
export type FollowUp = { q: string; a: string; isError?: boolean; about?: number }
export type Entry = {
  id: number
  prompt: string
  // check: English prompt with mistakes; tutor: Chinese prompt taught in English
  mode: 'check' | 'tutor' | 'clean' | 'error'
  natural: string
  fixes: Fix[]
  words: Word[]
  note: string
  followUps?: FollowUp[]
}
// The card whose follow-up field is open, the block chosen on it, and how
// many questions were sent from it (each send draws a fresh, empty field).
export type FollowField = { id: number; block: number; sent: number }

declare module 'claude-code' {
  interface PluginState {
    'english-tutor': {
      isOn: boolean
      isPlaced: boolean
      useContext: boolean
      pending: Shaped<string[]>
      frame: number
      entries: Shaped<Entry[]>
      followField: Shaped<FollowField | null>
      followPending: Shaped<{ id: number; q: string }[]>
    }
  }
}
