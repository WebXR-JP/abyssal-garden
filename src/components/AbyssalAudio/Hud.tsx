import { useFrame } from '@react-three/fiber'
import { Interactable } from '@xrift/world-components'
import { useEffect, useMemo, useRef } from 'react'
import { CanvasTexture, type Group, Quaternion, SRGBColorSpace, Vector3 } from 'three'

/** パネルの大きさ（メートル）。16:4 の横長。実際の幅は視野に合わせて縮む */
const W = 0.3
const H = 0.075
const DIST = 0.62
const TEX_W = 1024
const TEX_H = 256
const SEGMENTS = 10

/** 横方向の視野に対するパネルの角度（広い画面ではこの角度、狭い画面では視野の割合で縮む） */
const TARGET_ANGLE = (22 * Math.PI) / 180
const MAX_VIEW_FRACTION = 0.42

/** 非 VR は右下に 70% で置く（視線の邪魔をしない） */
const DESKTOP_SCALE = 0.7
const EDGE = 0.09 // 画面端からの余白（画面の半分に対する割合）

// パネル幅に対する各操作の位置（キャンバスと当たり判定で共有する）
const MUTE_U = 0.065
const MINUS_U = 0.205
const BAR_FROM = 0.285
const BAR_TO = 0.875
const PLUS_U = 0.94

const ACCENT = '#7ff3ff'
const DIM = 'rgba(127, 243, 255, 0.18)'
const SOFT = 'rgba(216, 248, 255, 0.88)'

export interface AbyssalAudioHudProps {
  /** 0..1 */
  volume: number
  muted: boolean
  onVolumeChange: (volume: number) => void
  onMutedChange: (muted: boolean) => void
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * パネル全体を 1 枚のキャンバスに描く（文字は使わない）。
 * スピーカー・−・10 段のバー・＋ だけなので、フォントやロケールに依存しない。
 */
function paint(ctx: CanvasRenderingContext2D, volume: number, muted: boolean) {
  const cy = TEX_H / 2
  ctx.clearRect(0, 0, TEX_W, TEX_H)

  const pad = 5
  roundRect(ctx, pad, pad, TEX_W - pad * 2, TEX_H - pad * 2, 54)
  ctx.fillStyle = 'rgba(3, 22, 31, 0.66)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(127, 243, 255, 0.26)'
  ctx.lineWidth = 4
  ctx.stroke()

  // スピーカー（ミュート中は暗くして × を重ねる）
  const sx = MUTE_U * TEX_W
  const s = 88
  ctx.fillStyle = muted ? 'rgba(190, 225, 235, 0.30)' : ACCENT
  ctx.beginPath()
  ctx.moveTo(sx - s * 0.44, cy - s * 0.14)
  ctx.lineTo(sx - s * 0.20, cy - s * 0.14)
  ctx.lineTo(sx + s * 0.02, cy - s * 0.38)
  ctx.lineTo(sx + s * 0.02, cy + s * 0.38)
  ctx.lineTo(sx - s * 0.20, cy + s * 0.14)
  ctx.lineTo(sx - s * 0.44, cy + s * 0.14)
  ctx.closePath()
  ctx.fill()

  ctx.lineCap = 'round'
  if (muted) {
    const x0 = sx + s * 0.28
    const d = s * 0.14
    ctx.strokeStyle = 'rgba(255, 152, 166, 0.95)'
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.moveTo(x0 - d, cy - d)
    ctx.lineTo(x0 + d, cy + d)
    ctx.moveTo(x0 + d, cy - d)
    ctx.lineTo(x0 - d, cy + d)
    ctx.stroke()
  } else {
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 5
    for (const r of [0.30, 0.46]) {
      ctx.beginPath()
      ctx.arc(sx + s * 0.04, cy, s * r, -0.85, 0.85)
      ctx.stroke()
    }
  }

  // − と ＋（端まで来たら暗くして、押しても変わらないことを示す）
  const canDown = volume > 0.001
  const canUp = volume < 0.999
  const mx = MINUS_U * TEX_W
  const px = PLUS_U * TEX_W
  const arm = 25
  ctx.lineWidth = 10
  ctx.strokeStyle = canDown ? SOFT : DIM
  ctx.beginPath()
  ctx.moveTo(mx - arm, cy)
  ctx.lineTo(mx + arm, cy)
  ctx.stroke()
  ctx.strokeStyle = canUp ? SOFT : DIM
  ctx.beginPath()
  ctx.moveTo(px - arm, cy)
  ctx.lineTo(px + arm, cy)
  ctx.moveTo(px, cy - arm)
  ctx.lineTo(px, cy + arm)
  ctx.stroke()

  // 10 段のバー（ミュート中は 0 段）
  const filled = muted ? 0 : Math.round(volume * SEGMENTS)
  const from = BAR_FROM * TEX_W
  const to = BAR_TO * TEX_W
  const slot = (to - from) / SEGMENTS
  const barH = 92
  for (let i = 0; i < SEGMENTS; i++) {
    roundRect(ctx, from + slot * i + slot * 0.16, cy - barH / 2, slot * 0.68, barH, 10)
    ctx.fillStyle = i < filled ? ACCENT : DIM
    ctx.fill()
  }
}

/**
 * カメラに追従する音量 HUD。上流の水中音のマスター音量を操作する。
 *
 * 見た目は 1 枚のキャンバス（スピーカー / − / 10 段バー / ＋）で、当たり判定だけを
 * `Interactable` の透明な板で重ねている。
 *
 * グループは `scene` 直下（`AbyssalAudio` が portal で置く）なので、ワールドの
 * ルートに position / scale が付いていても画面に対する位置は変わらない。
 * モニタでは右下 70%。VR では押す手段がないので `AbyssalAudio` が出さない。
 */
export const AbyssalAudioHud: React.FC<AbyssalAudioHudProps> = ({
  volume,
  muted,
  onVolumeChange,
  onMutedChange,
}) => {
  const group = useRef<Group>(null)
  const headPosition = useMemo(() => new Vector3(), [])
  const headQuaternion = useMemo(() => new Quaternion(), [])

  const { canvas, texture } = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = TEX_W
    canvas.height = TEX_H
    const ctx = canvas.getContext('2d')
    if (ctx) paint(ctx, volume, muted)
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    return { canvas, texture }
    // 初期描画だけ。以後は下の effect が描き直す
  }, [])

  useEffect(() => {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    paint(ctx, volume, muted)
    texture.needsUpdate = true
  }, [canvas, texture, volume, muted])

  useEffect(() => () => texture.dispose(), [texture])

  // カメラ（= 頭）の姿勢に合わせて、右下に置く
  useFrame(({ camera, size }) => {
    const node = group.current
    if (!node) return
    headPosition.setFromMatrixPosition(camera.matrixWorld)
    headQuaternion.setFromRotationMatrix(camera.matrixWorld)
    node.position.copy(headPosition)
    node.quaternion.copy(headQuaternion)

    const fov = 'fov' in camera ? (camera.fov * Math.PI) / 180 : Math.PI / 3
    const aspect = size.width / Math.max(1, size.height)
    const hFov = 2 * Math.atan(Math.tan(fov / 2) * aspect)
    const angle = Math.min(TARGET_ANGLE, hFov * MAX_VIEW_FRACTION)
    const scale = ((2 * DIST * Math.tan(angle / 2)) / W) * DESKTOP_SCALE
    node.scale.setScalar(scale)

    // 右下：視野の端から余白ぶん内側に、パネルの右端と下端を合わせる
    const halfH = DIST * Math.tan(fov / 2)
    const halfW = halfH * aspect
    node.translateX(halfW * (1 - EDGE) - (W * scale) / 2)
    node.translateY(-halfH * (1 - EDGE) + (H * scale) / 2)
    node.translateZ(-DIST)
  })

  const changeVolume = (next: number) => {
    onVolumeChange(Math.min(1, Math.max(0, next)))
    // 音量を触ったらミュートは解除する（バーが暗いままだと操作したことが分からない）
    if (muted) onMutedChange(false)
  }

  const xOf = (u: number) => (u - 0.5) * W

  return (
    <group ref={group} renderOrder={1000}>
      <mesh renderOrder={1000}>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial
          map={texture}
          transparent
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* ミュート */}
      <Interactable
        id="abyssal-volume-mute"
        type="button"
        interactionText={muted ? 'ミュート解除 (M)' : 'ミュート (M)'}
        onInteract={() => onMutedChange(!muted)}
      >
        <mesh position={[xOf(MUTE_U), 0, 0.002]}>
          <planeGeometry args={[0.06, 0.06]} />
          <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
        </mesh>
      </Interactable>

      {/* − */}
      <Interactable
        id="abyssal-volume-down"
        type="button"
        interactionText={`音量を下げる (${Math.round(volume * 100)}%)`}
        onInteract={() => changeVolume(Math.round((volume - 0.1) * 10) / 10)}
      >
        <mesh position={[xOf(MINUS_U), 0, 0.002]}>
          <planeGeometry args={[0.05, 0.055]} />
          <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
        </mesh>
      </Interactable>

      {/* 10 段のバー（押した段の音量へ） */}
      {Array.from({ length: SEGMENTS }, (_, i) => {
        const u = BAR_FROM + ((i + 0.5) / SEGMENTS) * (BAR_TO - BAR_FROM)
        const step = (i + 1) / SEGMENTS
        return (
          <Interactable
            key={i}
            id={`abyssal-volume-${i + 1}`}
            type="button"
            interactionText={`音量 ${Math.round(step * 100)}%`}
            onInteract={() => changeVolume(step)}
          >
            <mesh position={[xOf(u), 0, 0.002]}>
              <planeGeometry args={[(W * (BAR_TO - BAR_FROM)) / SEGMENTS, 0.055]} />
              <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
            </mesh>
          </Interactable>
        )
      })}

      {/* ＋ */}
      <Interactable
        id="abyssal-volume-up"
        type="button"
        interactionText={`音量を上げる (${Math.round(volume * 100)}%)`}
        onInteract={() => changeVolume(Math.round((volume + 0.1) * 10) / 10)}
      >
        <mesh position={[xOf(PLUS_U), 0, 0.002]}>
          <planeGeometry args={[0.05, 0.055]} />
          <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
        </mesh>
      </Interactable>
    </group>
  )
}
