export type SurfStatus = 'idle' | 'loading' | 'ready' | 'error'

export type SurfClip = {
  source: string
  dir: string
  frameCount: number
  fps: number
  width: number
  height: number
  hasAudio: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'subway-surfers': {
      status: SurfStatus
      message: string
      clip: SurfClip | null
      isPlaying: boolean
      isMuted: boolean
      isAutoplay: boolean
      tick: number
      position: number
    }
  }
}
