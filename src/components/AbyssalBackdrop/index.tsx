import { GpuBackdrop } from '@webxr-jp/webgpu-view'
import { useCallback, useMemo } from 'react'
import AbyssalWorker from '../../worker/abyssal.worker.ts?worker'

export interface AbyssalBackdropProps {
  /** 最初のフレーム（= ワールド生成完了）を受け取った */
  onReady?: () => void
  /** WebGPU が使えない等で描画できない */
  onError?: (message: string) => void
  /** 0 High / 1 Medium / 2 Low（未指定なら端末から選ぶ） */
  quality?: number
  /** 1 視点ぶんの描画解像度の上限（px） */
  maxWidth?: number
  maxFps?: number
  debug?: boolean
}

/** 正の有限数だけ受け付け、それ以外は既定値にする */
function queryNumber(value: string | null, fallback: number) {
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Abyssal Garden（WebGPU）を XRift の背景として描く。
 *
 * 実際の描画は Worker の中で raw WebGPU が行い、ここは
 * `@webxr-jp/webgpu-view` の `GpuBackdrop` に任せる:
 * - モニタ: 画面全体を覆う板ポリ（常にメインシーンより奥）
 * - XR: 左右の目ぶんを 1 フレームで描いたアトラスを目ごとに表示
 *
 * Worker には XRift のカメラ行列が毎フレーム渡り、その位置・向きから
 * 海中のカメラを動かす（歩くと景色が動く）。
 */
export const AbyssalBackdrop: React.FC<AbyssalBackdropProps> = ({
  onReady,
  onError,
  quality,
  maxWidth,
  maxFps,
  debug = false,
}) => {
  const query = useMemo(() => new URLSearchParams(window.location.search), [])

  const resolvedQuality = useMemo(() => {
    if (typeof quality === 'number') return quality
    const raw = query.get('quality')
    if (raw === null) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? Math.max(0, Math.min(2, Math.floor(parsed))) : undefined
  }, [quality, query])

  const resolvedMaxWidth = useMemo(
    () => maxWidth ?? queryNumber(query.get('maxWidth'), 1280),
    [maxWidth, query],
  )
  const resolvedMaxFps = useMemo(
    () => maxFps ?? queryNumber(query.get('maxFps'), 60),
    [maxFps, query],
  )

  const isDebug = debug || query.get('debug') === '1'
  const workerData = useMemo(
    () => ({
      ...(resolvedQuality === undefined ? {} : { quality: resolvedQuality }),
      debug: isDebug,
    }),
    [resolvedQuality, isDebug],
  )

  const profile = query.get('profile') === '1'
  const onStats = useCallback((stats: unknown) => {
    console.info('[abyssal] stats ' + JSON.stringify(stats))
  }, [])

  // GpuBackdrop の onReady は毎回同じ形で来るので、外には「準備できた」だけ渡す
  const handleReady = useCallback(() => {
    onReady?.()
  }, [onReady])

  return (
    <GpuBackdrop
      worker={AbyssalWorker}
      workerData={workerData}
      maxWidth={resolvedMaxWidth}
      maxFps={resolvedMaxFps}
      // モニタで左右 2 視点（アトラス）を確認するためのデバッグ用
      stereo={query.get('stereo') === '1'}
      // Worker は ImageBitmap で返す（buffer 経路は three の WebGPURenderer 前提のため使わない）
      transfer="bitmap"
      enabled={query.get('off') !== '1'}
      debug={isDebug}
      profile={profile}
      onStats={onStats}
      onReady={handleReady}
      onError={onError}
    />
  )
}
