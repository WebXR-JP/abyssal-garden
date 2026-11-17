/**
 * WebGPU Worker entry for @webxr-jp/webgpu-view.
 *
 * The library's own `defineGpuWorker` builds a three.js scene; Abyssal Garden
 * ships its own raw WebGPU renderer (WGSL, multiple passes), so this worker
 * speaks the same message protocol itself:
 *
 *   init    -> ready            (one per worker)
 *   resize  -> (applied on the next frame)
 *   frame   -> result + ImageBitmap (atlas: left/right eye side by side)
 *   dispose -> -
 *
 * The protocol is documented in @webxr-jp/webgpu-view's src/protocol.ts.
 */

type Mat4 = number[]

interface InitMessage {
  type: 'init'
  width: number
  height: number
  data?: { quality?: number; debug?: boolean }
}

interface ResizeMessage {
  type: 'resize'
  width: number
  height: number
}

interface FrameMessage {
  type: 'frame'
  id: number
  time: number
  delta: number
  views: { view: Mat4; projection: Mat4; camera: { fov: number; aspect: number; near: number; far: number } }[]
}

type WorkerRequest = InitMessage | ResizeMessage | FrameMessage | { type: 'dispose' }

const scope = globalThis as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

interface AbyssalRenderer {
  renderFrame: (views: FrameMessage['views'], time: number) => ImageBitmap
  resize: (width: number, height: number) => void
  dispose: () => void
  readonly spawnPos: number[]
  /** last GPU frame time (ms, timestamp query; 0 when unavailable) */
  readonly gpuMs: number
  /** current draw distance scale (1 = full) */
  readonly detail: number
  readonly pose: { x: number; y: number; z: number; yaw: number; pitch: number }
  readonly clearance: number
}

let renderer: AbyssalRenderer | null = null
let ready = false
let failed = false
let initWidth = 0
let initHeight = 0
/** resize requests that arrive while the world is still being built */
let pendingResize: { width: number; height: number } | null = null
let frameCount = 0
let debug = false

/** Pick a quality level: 0 High, 1 Medium, 2 Low (same scale as upstream). */
function pickQuality(explicit?: number) {
  if (typeof explicit === 'number' && explicit >= 0) return Math.min(2, Math.floor(explicit))
  const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer:coarse)').matches : false
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8
  if (coarse) return mem > 7 ? 1 : 2
  return mem <= 4 ? 2 : 0
}

async function init(message: InitMessage) {
  initWidth = Math.max(64, Math.round(message.width))
  initHeight = Math.max(64, Math.round(message.height))

  const quality = pickQuality(message.data?.quality)
  debug = message.data?.debug === true
  // engine.js reads this before it builds its shaders / world
  ;(globalThis as unknown as { __ABYSSAL_QUALITY__?: number }).__ABYSSAL_QUALITY__ = quality

  const canvas = new OffscreenCanvas(initWidth, initHeight)
  const { createAbyssalRenderer } = await import('../abyssal/renderer.js')

  renderer = (await createAbyssalRenderer({
    canvas,
    width: initWidth,
    height: initHeight,
    onProgress: (stage: string) => console.info('[abyssal]', stage),
  })) as AbyssalRenderer

  if (pendingResize) {
    renderer.resize(pendingResize.width, pendingResize.height)
    initWidth = pendingResize.width
    initHeight = pendingResize.height
    pendingResize = null
  }

  ready = true
  scope.postMessage({
    type: 'ready',
    width: initWidth,
    height: initHeight,
    backend: 'webgpu',
    adapter: `Abyssal Garden (quality ${quality})`,
    transfer: 'bitmap',
    meta: { quality, spawn: renderer.spawnPos },
  })
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  if (!message || typeof message !== 'object') return

  if (message.type === 'init') {
    init(message).catch((error: unknown) => {
      failed = true
      const text = error instanceof Error ? error.message : String(error)
      scope.postMessage({ type: 'error', message: text, fatal: true })
    })
    return
  }

  if (message.type === 'resize') {
    if (!renderer) {
      pendingResize = { width: message.width, height: message.height }
      return
    }
    renderer.resize(message.width, message.height)
    return
  }

  if (message.type === 'frame') {
    if (!ready || !renderer || failed) return
    frameCount++
    const start = performance.now()
    try {
      const bitmap = renderer.renderFrame(message.views, message.time)
      if (debug && frameCount % 120 === 0) {
        const p = renderer.pose
        console.info('[abyssal] gpu', renderer.gpuMs.toFixed(2), 'ms / draw distance', renderer.detail.toFixed(2), '/ pose', p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1), 'yaw', p.yaw.toFixed(2), 'pitch', p.pitch.toFixed(2), '/ clearance', renderer.clearance.toFixed(2))
      }
      scope.postMessage(
        {
          type: 'result',
          id: message.id,
          width: bitmap.width,
          height: bitmap.height,
          renderMs: performance.now() - start,
          bitmap,
        },
        [bitmap],
      )
    } catch (error: unknown) {
      // a single failed frame must not stop the stream
      const text = error instanceof Error ? error.message : String(error)
      scope.postMessage({ type: 'error', message: text, fatal: false })
    }
    return
  }

  if (message.type === 'dispose') {
    renderer?.dispose()
    renderer = null
    ready = false
  }
}
