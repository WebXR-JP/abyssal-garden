import { Html } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useState } from 'react'

/**
 * 開発サーバー用の Enter VR ボタン。
 *
 * XRift の本番フロントエンドは自前の「Enter VR」を持つが、ローカルの
 * `DevEnvironment` には無い。R3F v9 は `gl.xr` の `sessionstart` を拾って
 * XR 用のアニメーションループに切り替えるので、ここでは
 * `navigator.xr.requestSession()` → `gl.xr.setSession()` を呼ぶだけでよい。
 *
 * 本番ビルドには含まれない（`dev.tsx` からのみ使う）。
 */
export const EnterVrButton: React.FC = () => {
  const gl = useThree((state) => state.gl)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [presenting, setPresenting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!navigator.xr) {
      setSupported(false)
      return
    }
    let alive = true
    navigator.xr
      .isSessionSupported('immersive-vr')
      .then((ok) => alive && setSupported(ok))
      .catch(() => alive && setSupported(false))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const sync = () => setPresenting(gl.xr.isPresenting)
    gl.xr.addEventListener('sessionstart', sync)
    gl.xr.addEventListener('sessionend', sync)
    return () => {
      gl.xr.removeEventListener('sessionstart', sync)
      gl.xr.removeEventListener('sessionend', sync)
    }
  }, [gl])

  const enterVR = useCallback(async () => {
    if (!navigator.xr) {
      setMessage('この端末は WebXR 非対応です')
      return
    }
    // 端末によっては未対応の feature を渡すと requestSession ごと失敗するので、
    // 要求を減らしながら順に試す（three 側は local-floor が無ければ local で動く）
    const attempts: XRSessionInit[] = [
      { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] },
      { optionalFeatures: ['local-floor'] },
      {},
    ]
    let lastError: unknown = null
    for (const init of attempts) {
      let session: XRSession | null = null
      try {
        session = await navigator.xr.requestSession('immersive-vr', init)
      } catch (error) {
        lastError = error
        continue
      }
      setMessage(null)
      session.addEventListener('end', () => setPresenting(false))
      gl.xr.enabled = true
      await gl.xr.setSession(session)
      return
    }
    setMessage(lastError instanceof Error ? lastError.message : String(lastError))
  }, [gl])

  const disabled = presenting || supported === false

  return (
    <Html fullscreen style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          display: 'grid',
          justifyItems: 'end',
          gap: 4,
          pointerEvents: 'auto',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <button
          type="button"
          onClick={enterVR}
          disabled={disabled}
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,.35)',
            background: disabled ? 'rgba(255,255,255,.08)' : 'rgba(64,160,255,.85)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          {presenting ? '🥽 VR 中' : '🥽 Enter VR'}
        </button>
        {supported === false && (
          <span style={{ fontSize: 11, color: '#ffb4b4' }}>immersive-vr 非対応</span>
        )}
        {message && <span style={{ fontSize: 11, color: '#ffb4b4' }}>{message}</span>}
      </div>
    </Html>
  )
}
