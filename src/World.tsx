import { Html } from '@react-three/drei'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { SpawnPoint } from '@xrift/world-components'
import { useCallback, useState } from 'react'
import { AbyssalAudio } from './components/AbyssalAudio'
import { AbyssalBackdrop } from './components/AbyssalBackdrop'

export interface WorldProps {
  position?: [number, number, number]
  scale?: number
}

/**
 * Abyssal Garden - XRift ワールド
 *
 * 海中の世界は WebGPU（Worker）が描き、XRift 側はプレイヤーの移動と
 * スポーンだけを持つ。地面は見えないコライダーだけで、景色は背景として
 * 常にプレイヤーの周りに広がる。
 */
export const World: React.FC<WorldProps> = ({ position = [0, 0, 0], scale = 1 }) => {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleReady = useCallback(() => setReady(true), [])
  const handleError = useCallback((message: string) => setError(message), [])

  return (
    <group position={position} scale={scale}>
      {/* WebGPU が使えない環境でも真っ暗にならないように */}
      <color attach="background" args={['#03131c']} />

      {/* ========== アバター用のライト ========== */}
      {/* 景色は WebGPU の Worker が自前で陰影を付けて描くため、ここのライトは
          アバター（XRift が読み込む glTF）にしか当たらない。
          向きだけが意味を持つので、プレイヤーがどこへ動いても同じ当たり方になる。 */}
      <ambientLight intensity={0.9} color="#8fd8e8" />
      <directionalLight position={[4, 8, 6]} intensity={2.2} color="#e8fbff" />
      {/* 影側が真っ黒にならないよう、逆側から弱いフィルを足す */}
      <directionalLight position={[-6, 3, -4]} intensity={0.7} color="#6fd0e8" />

      {/* ========== WebGPU: Abyssal Garden ========== */}
      <AbyssalBackdrop onReady={handleReady} onError={handleError} />

      {/* ========== 効果音（上流の Web Audio アンビエンス） ========== */}
      <AbyssalAudio visible={ready} />

      {/* ========== 見えない床（歩けるようにするため） ========== */}
      <RigidBody type="fixed" colliders={false} restitution={0} friction={0.2}>
        <CuboidCollider args={[120, 0.05, 120]} position={[0, -0.05, 0]} />
      </RigidBody>

      {/* ========== スポーン ========== */}
      <SpawnPoint position={[0, 0, 0]} />

      {/* ========== 読み込み中 / 失敗 ========== */}
      {!ready && (
        <Html fullscreen>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeContent: 'center',
              justifyItems: 'center',
              gap: '1.2rem',
              background: 'radial-gradient(#0b3a4d, #03131c 70%)',
              color: '#e8fbff',
              fontFamily: 'system-ui, sans-serif',
              textAlign: 'center',
              padding: '2rem',
            }}
          >
            <h1
              style={{
                margin: 0,
                fontSize: 'clamp(2rem, 6vw, 4rem)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                background: 'linear-gradient(#fff 25%, #7ff3ff 70%)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              Abyssal Garden
            </h1>
            {error ? (
              <p style={{ margin: 0, maxWidth: '36em', lineHeight: 1.6 }}>
                WebGPU で描画できませんでした: {error}
                <br />
                最新の Chrome / Edge で開いてください。
              </p>
            ) : (
              <>
                <p style={{ margin: 0, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                  Diving…
                </p>
                <p style={{ margin: 0, opacity: 0.7, maxWidth: '30em', lineHeight: 1.6 }}>
                  海の底を彫って、ケルプを育てています。
                  <br />
                  WASD / スティックで動くと景色が動きます。
                </p>
                <p style={{ margin: 0, opacity: 0.4, fontSize: '0.8rem' }}>
                  Abyssal Garden by Noniv (MIT) · WebGPU via @webxr-jp/webgpu-view
                </p>
              </>
            )}
          </div>
        </Html>
      )}
    </group>
  )
}
