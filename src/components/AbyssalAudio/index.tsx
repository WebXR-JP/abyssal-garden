import { createPortal, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import { Vector3 } from 'three'
import { createAbyssalAudio } from '../../abyssal/audio.js'
import { AbyssalAudioHud } from './Hud'

const VOLUME_KEY = 'abyssal-garden:volume'
const MUTED_KEY = 'abyssal-garden:muted'

export interface AbyssalAudioProps {
  /** false で音を出さない（`?audio=0` でも止まる） */
  enabled?: boolean
  /** HUD を出すか（ワールドの読み込みが終わってから true にする） */
  visible?: boolean
}

function readSetting(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function writeSetting(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // プライベートモードなどで保存できなくても、その場の設定は有効にする
  }
}

/**
 * 上流の Web Audio のアンビエンス（`source/src/audio.js`）を鳴らし、
 * 音量 HUD を出す。
 *
 * 音はサンプルファイルではなく AudioBuffer をその場で作る手続き生成なので、
 * `public/` へのアセット追加も `baseUrl` の考慮も要らない。
 *
 * - ブラウザは最初の操作まで音を出せないので、クリック / キー / タッチで
 *   `AudioContext` を作って再開する（上流と同じ）。マウント時にも一度試す
 * - 水中の視点（= メインスレッドのカメラ）を毎フレーム渡し、音側が 10 Hz で
 *   読む。泳ぐ速さで水を切る音、深さで水面の音が変わる
 * - 音量とミュートは HUD（`Interactable`）と `M` キーで操作し、localStorage に残す
 */
export const AbyssalAudio: React.FC<AbyssalAudioProps> = ({ enabled = true, visible = false }) => {
  const query = useMemo(() => new URLSearchParams(window.location.search), [])
  const active = enabled && query.get('audio') !== '0'
  const scene = useThree((state) => state.scene)
  const gl = useThree((state) => state.gl)

  const initial = useMemo(() => {
    const stored = Number(readSetting(VOLUME_KEY, '1'))
    return {
      volume: Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 1,
      muted: readSetting(MUTED_KEY, '0') === '1',
    }
  }, [])
  const audio = useMemo(() => createAbyssalAudio(initial), [initial])
  const position = useMemo(() => new Vector3(), [])
  const [volume, setVolume] = useState(initial.volume)
  const [muted, setMuted] = useState(initial.muted)

  // 設定を音と localStorage に反映する（`start()` 前でも覚えておく）
  useEffect(() => {
    audio.setVolume(volume)
    writeSetting(VOLUME_KEY, String(volume))
  }, [audio, volume])

  useEffect(() => {
    audio.setMuted(muted)
    writeSetting(MUTED_KEY, muted ? '1' : '0')
  }, [audio, muted])

  useEffect(() => {
    if (!active) return
    // ページ側ですでに操作されていれば、ここでそのまま鳴り始める
    audio.start()
    const resume = () => audio.start()
    const gestures = ['pointerdown', 'touchstart'] as const
    for (const type of gestures) window.addEventListener(type, resume, { passive: true })
    window.addEventListener('keydown', resume)
    // VR 中は pointer イベントが来ないので、入室した時点で再開しておく
    gl.xr.addEventListener('sessionstart', resume)
    return () => {
      for (const type of gestures) window.removeEventListener(type, resume)
      window.removeEventListener('keydown', resume)
      gl.xr.removeEventListener('sessionstart', resume)
    }
  }, [active, audio, gl])

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyM' || event.metaKey || event.ctrlKey || event.altKey) return
      // XRift のチャット入力中に「m」でミュートが切り替わらないようにする
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      setMuted((value) => !value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  useEffect(() => () => audio.dispose(), [audio])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    // 実機で「鳴っているか / 音量 / ミュート」を外から確認するためのフック
    ;(window as unknown as { __abyssalAudio?: unknown }).__abyssalAudio = {
      get ready() {
        return audio.ready
      },
      get state() {
        return audio.state
      },
      get volume() {
        return audio.volume
      },
      get muted() {
        return audio.muted
      },
      setVolume,
      setMuted,
      toggleMute: () => setMuted((value) => !value),
    }
  }, [audio, setVolume, setMuted])

  useFrame(({ camera }) => {
    // XRift の本番ではカメラはプレイヤーの RigidBody の子なので、ローカル座標ではなく
    // ワールド座標を使う（歩いた距離が rush に出る）
    camera.getWorldPosition(position)
    audio.setPosition(position.x, position.y, position.z)
  })

  if (!active || !visible) return null
  return createPortal(
    <AbyssalAudioHud volume={volume} muted={muted} onVolumeChange={setVolume} onMutedChange={setMuted} />,
    scene,
  )
}
