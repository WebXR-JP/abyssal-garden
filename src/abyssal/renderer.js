// ============================================================================
// Abyssal Garden - WebGPU renderer for @webxr-jp/webgpu-view
//
// This is `source/src/main.js` from https://github.com/Noniv/abyssal-garden
// (MIT, see LICENSE-abyssal) adapted to run inside a Web Worker and to take the
// camera from the host (XRift / React Three Fiber) instead of pointer lock.
//
// What changed:
// - the page (menu, loading bar, pointer lock, touch, HUD, audio) is gone
// - the camera comes from the view/projection matrices the main thread sends
// - rendering is driven by a `frame` message instead of requestAnimationFrame
// - one frame can hold several views (XR: left and right eye side by side)
// - the player no longer swims with WASD; the world renders from wherever the
//   XRift camera is, so walking around moves through the abyss
// Everything else (world generation, shaders, passes, shadow map, bloom,
// light shafts) is unchanged.
// ============================================================================

import {
  LV, SHADOW, AA, WATER, RAYN,
  NX, NY, NZ, VS, OX, OY, OZ, CELLS, CELLW, NCHUNK,
  MESAS, ARCHES, HOLES, CLEARS, PURPLE,
  W_DENS, W_SOLID, W_LEAF, W_ANIM, W_SURF, W_SPR, W_BLIT, W_WATER, W_RAYS, W_POST, W_RBLUR, W_DETAIL,
  primBuffer, buildTerrain, makeWorld,
  meshChunk, meshLathe, meshCoral, meshTubes, meshFluke, meshShip, meshManta, meshFish,
  clamp, hypot, floor, round, max, min, abs, sqrt, sin, cos, atan2, PI,
} from './engine.js'

// preset viewpoints from upstream main.js (position, look-at); the world
// generator dresses the scene around them and the player spawns at the first
const POSES = [
  [10, 1.3, 7, -9, -31, -10],
  [50, 1.3, 34, 58, -23, 8],
  [-26, 2.2, -100, 0, -9, -108],
  [-55, 1.5, -18, -60, -30, 8],
  [10, 1.2, -62, 6, -22, -90],
  [3, 1.6, 62, 1, -28, 100],
]
// 60 s camera path (position + look-at, Catmull-Rom): the world generator keeps it clear
const FLY = new Float32Array([
  10, -42.2, 7, -9, -31, -10,
  7.5, -41.8, 5.5, -10, -31, -12,
  9, -40.5, 18, 17, -37, 42,
  22, -39.2, 40, 48, -36, 45,
  38, -39.2, 46, 57, -27, 18,
  50, -40.4, 35, 58, -24, 8,
  55, -39, 20, 60, -18, -10,
  58, -34, -12, 40, -26, -60,
  50, -30, -44, 10, -26, -80,
  30, -30, -70, 4, -28, -90,
  12, -38.5, -62, 6, -27, -90,
  -4, -36.5, -70, 0, -14, -100,
  -16, -37, -84, 0, -22, -108,
  -29, -38, -90, -44, -34, -60,
  -41, -38, -70, -56, -34, -40,
  -53, -38, -50, -60, -34, -20,
  -58, -38, -28, -60, -32, 0,
  -57, -38, -10, -60, -30, 16,
  -60, -38, 10, -50, -36, 40,
  -52, -37, 36, -20, -35, 44,
  -22, -38, 43, 4, -38, 52,
  -6, -39.2, 44.5, 4, -37, 70,
  3, -40.6, 53, 3, -35, 84,
  3, -41.5, 62, 1, -30, 100,
  4, -39, 76, 3, -22, 100,
])
const FLYN = FLY.length / 6
const NEAR = 0.1
const EXPO = 0.62
const RAYS = 0.54
const TANH = 0.6 // fallback tan(fov/2) when a projection cannot be read
let TANX = TANH, TANY = TANH // tan half angles of the current view, for culling

const F = new Float64Array(32)
const CX = 0, CY = 1, CZ = 2, YAW = 3, PIT = 4, FX = 5, FY = 6, FZ = 7, RX = 8, RY = 13, RZ = 9, UX = 10, UY = 11, UZ = 12

const mod = (device, code) => device.createShaderModule({ code })
const colorAtt = (view, clear) => ({ view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] })

/**
 * Builds the whole world and returns a renderer.
 *
 * @param {object} options
 * @param {OffscreenCanvas} options.canvas
 * @param {number} options.width  per view, px
 * @param {number} options.height per view, px
 * @param {(msg: string) => void} [options.onProgress]
 */
export async function createAbyssalRenderer({ canvas, width, height, onProgress = () => {} }) {
  const report = (m) => onProgress(m)
  if (!navigator.gpu) throw new Error('This scene needs WebGPU. Try a current Chrome or Edge.')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('No WebGPU adapter found.')
  const info = adapter.info || {}
  const hasTS = adapter.features.has('timestamp-query')
  const device = await adapter.requestDevice({ requiredFeatures: hasTS ? ['timestamp-query'] : [] })
  device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message))

  const ctx = canvas.getContext('webgpu')
  const FMT = navigator.gpu.getPreferredCanvasFormat()
  const Q = device.queue, HDR = 'rgba16float', DEPTH = 'depth32float'
  const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage

  const buf = (data, usage) => {
    const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | BU.COPY_DST })
    Q.writeBuffer(b, 0, data.buffer || data, data.byteOffset || 0, data.byteLength)
    return b
  }
  const tex = (w, h, format, usage, o = {}) => device.createTexture({
    size: [w, h, o.d || 1], format, usage, mipLevelCount: o.mips || 1, sampleCount: o.samples || 1,
    dimension: o.d ? '3d' : '2d',
  })

  // ---------------------------------------------------------------- static resources
  const sRep = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: LV > 1 ? 1 : 8 })
  const sClamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const sCmp = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' })
  const tShadow = tex(SHADOW, SHADOW, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING)
  const tDummy = tex(1, 1, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING)
  const tWater = tex(WATER, WATER, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { mips: 5 })
  const tDetail = tex(1024, 1024, 'rgba8unorm', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { mips: 11 })
  const tVol = tex(NX / 2, NY / 2, 'rg8unorm', TU.TEXTURE_BINDING | TU.COPY_DST, { d: NZ / 2 })
  const tMap = tex(512, 512, 'rgba8unorm', TU.TEXTURE_BINDING | TU.COPY_DST)

  const UB = [new Float32Array(60), new Float32Array(60)]
  const UBS = new Float32Array(60)
  const ubo = [0, 1].map(() => device.createBuffer({ size: 240, usage: BU.UNIFORM | BU.COPY_DST }))
  const uboS = device.createBuffer({ size: 240, usage: BU.UNIFORM | BU.COPY_DST })
  const WT = new Float32Array(4)
  const uboW = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST })

  const VF = SS.VERTEX | SS.FRAGMENT
  const bgl0 = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: VF, buffer: {} },
    { binding: 1, visibility: VF, sampler: {} }, { binding: 2, visibility: VF, sampler: {} }, { binding: 3, visibility: VF, sampler: { type: 'comparison' } },
    { binding: 4, visibility: VF, texture: { sampleType: 'depth' } },
    { binding: 5, visibility: VF, texture: {} }, { binding: 6, visibility: VF, texture: {} },
    { binding: 7, visibility: VF, texture: { viewDimension: '3d' } }, { binding: 8, visibility: VF, texture: {} }] })
  const mkBG0 = (u, sh) => device.createBindGroup({ layout: bgl0, entries: [
    { binding: 0, resource: { buffer: u } }, { binding: 1, resource: sRep }, { binding: 2, resource: sClamp }, { binding: 3, resource: sCmp },
    { binding: 4, resource: sh.createView() }, { binding: 5, resource: tWater.createView() }, { binding: 6, resource: tDetail.createView() },
    { binding: 7, resource: tVol.createView() }, { binding: 8, resource: tMap.createView() }] })
  const bg0 = [mkBG0(ubo[0], tShadow), mkBG0(ubo[1], tShadow)]
  const bg0s = mkBG0(uboS, tDummy)
  const pl0 = device.createPipelineLayout({ bindGroupLayouts: [bgl0] })

  const bglBlit = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: {} }, { binding: 1, visibility: SS.FRAGMENT, sampler: {} }] })
  const plBlit = device.createPipelineLayout({ bindGroupLayouts: [bglBlit] })
  const mBlit = mod(device, W_BLIT)
  const blitPipe = (entry, format, add) => device.createRenderPipeline({ layout: plBlit, vertex: { module: mBlit, entryPoint: 'vs' },
    fragment: { module: mBlit, entryPoint: entry, targets: [{ format, blend: add ? { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } : undefined }] } })
  const pMip8 = blitPipe('fsMip', 'rgba8unorm'), pMip16 = blitPipe('fsMip', HDR), pDown0 = blitPipe('fsDown0', HDR), pDown = blitPipe('fsDown', HDR), pUp = blitPipe('fsUp', HDR, true)
  const blitBG = (view) => device.createBindGroup({ layout: bglBlit, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sClamp }] })

  // vertex layouts
  const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format })
  const vbSolid = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')] }
  const ibSolid = { arrayStride: 48, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4'), A(4, 32, 'float32x4')] }
  const ibLeaf = { arrayStride: 36, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4'), A(2, 32, 'unorm8x4')] }
  const ibAnim = { arrayStride: 32, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4')] }
  const ibBub = { arrayStride: 32, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4')] }
  const ibSnow = { arrayStride: 16, stepMode: 'instance', attributes: [A(0, 0, 'float32x4')] }

  const scenePipe = (m, vsE, fsE, buffers, o = {}) => device.createRenderPipeline({ layout: pl0,
    vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
    fragment: { module: m, entryPoint: fsE, targets: [{ format: HDR, blend: o.blend }] },
    primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
    depthStencil: { format: DEPTH, depthWriteEnabled: !o.blend, depthCompare: 'greater' }, multisample: { count: AA } })
  const shadowPipe = (m, vsE, buffers, o = {}) => device.createRenderPipeline({ layout: pl0,
    vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
    primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
    depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 } })

  report('Compiling shaders…')
  const mSolid = mod(device, W_SOLID), mLeaf = mod(device, W_LEAF), mAnim = mod(device, W_ANIM), mSurf = mod(device, W_SURF), mSpr = mod(device, W_SPR)
  const pTerrain = scenePipe(mSolid, 'vs', 'fs', [vbSolid, ibSolid], { cull: 'back' })
  const pSolid = scenePipe(mSolid, 'vs', 'fs', [vbSolid, ibSolid])
  const pLeaf = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 9 } })
  const pLeaf5 = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 5 } })
  const pLeafS = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 3, FAR: 70 } })
  const pLeafF = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], { strip: true, constants: { ROWS: 3 } })
  const pFish = scenePipe(mAnim, 'vsFish', 'fsFish', [vbSolid, ibAnim])
  const pManta = scenePipe(mAnim, 'vsManta', 'fsManta', [vbSolid, ibAnim])
  const pSurf = scenePipe(mSurf, 'vs', 'fs', [], { strip: true }), pBack = scenePipe(mSurf, 'vsB', 'fsB', [], { strip: true })
  const pBub = scenePipe(mSpr, 'vsBub', 'fsBub', [ibBub], { strip: true, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } })
  const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } }
  const pSnow = scenePipe(mSpr, 'vsSnow', 'fsSnow', [ibSnow], { strip: true, blend: ADD })
  // ROWS は vs だけが使う override。vsGl に渡すと Dawn が
  // "Pipeline overridable constant \"ROWS\" not found" でパイプラインを無効化する端末がある（PICO 4 Ultra）
  const pGl = scenePipe(mLeaf, 'vsGl', 'fsGl', [ibBub], { strip: true, blend: ADD })
  const pSolidSh = shadowPipe(mSolid, 'vs', [vbSolid, ibSolid]), pTerrSh = shadowPipe(mSolid, 'vs', [vbSolid, ibSolid], { cull: 'front' })
  const pLeafSh = shadowPipe(mLeaf, 'vs', [ibLeaf], { strip: true, constants: { ROWS: 3 } })

  const mWater = mod(device, W_WATER)
  const pWater = device.createRenderPipeline({ layout: 'auto', vertex: { module: mWater, entryPoint: 'vs' }, fragment: { module: mWater, entryPoint: 'fs', targets: [{ format: HDR }] } })
  const bgWater = device.createBindGroup({ layout: pWater.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uboW } }] })
  const waterViews = [0, 1, 2, 3, 4].map((m) => tWater.createView({ baseMipLevel: m, mipLevelCount: 1 }))
  const waterBG = waterViews.map((v) => blitBG(v))
  const waterPass = waterViews.map((v) => ({ colorAttachments: [colorAtt(v, true)] }))

  const mRays = mod(device, W_RAYS), mPost = mod(device, W_POST), mRB = mod(device, W_RBLUR)
  const pRB = device.createRenderPipeline({ layout: 'auto', vertex: { module: mRB, entryPoint: 'vs' }, fragment: { module: mRB, entryPoint: 'fs', targets: [{ format: HDR }] } })
  const pRays = device.createRenderPipeline({ layout: 'auto', vertex: { module: mRays, entryPoint: 'vs' }, fragment: { module: mRays, entryPoint: 'fs', targets: [{ format: HDR }] } })
  const pPost = device.createRenderPipeline({ layout: 'auto', vertex: { module: mPost, entryPoint: 'vs' }, fragment: { module: mPost, entryPoint: 'fs', targets: [{ format: FMT }] } })

  // ---------------------------------------------------------------- sun + shadow matrix
  const SUN = (() => { const v = [0.27, 1, -0.24], l = hypot(...v); return v.map((c) => c / l) })()
  {
    const L = SUN, lr = [L[1], -L[0], 0], ll = hypot(...lr); lr[0] /= ll; lr[1] /= ll
    const lu = [L[1] * lr[2] - L[2] * lr[1], L[2] * lr[0] - L[0] * lr[2], L[0] * lr[1] - L[1] * lr[0]]
    const R = 225, d0 = -175, d1 = 125, m = UBS
    m[0] = lr[0] / R; m[4] = lr[1] / R; m[8] = lr[2] / R; m[12] = 0
    m[1] = lu[0] / R; m[5] = lu[1] / R; m[9] = lu[2] / R; m[13] = 0
    m[2] = -L[0] / (d1 - d0); m[6] = -L[1] / (d1 - d0); m[10] = -L[2] / (d1 - d0); m[14] = d1 / (d1 - d0)
    m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1
    for (const u of UB) for (let i = 0; i < 16; i++) u[16 + i] = m[i]
    for (const u of UB) for (let i = 0; i < 3; i++) u[48 + i] = SUN[i]
    UBS[32] = 0; UBS[33] = -20; UBS[34] = 0; UBS[35] = 0; UBS[58] = 1
    Q.writeBuffer(uboS, 0, UBS)
  }

  // ---------------------------------------------------------------- world generation
  report('Sculpting the seabed…')
  let D
  {
    const prims = primBuffer()
    const m = mod(device, W_DENS), p = device.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } })
    const size = NX * NY * NZ * 4
    const u = new ArrayBuffer(48), uu = new Uint32Array(u), uf = new Float32Array(u)
    uu[0] = NX; uu[1] = NY; uu[2] = NZ; uf[4] = OX; uf[5] = OY; uf[6] = OZ; uf[7] = VS
    uu[8] = MESAS.length; uu[9] = ARCHES.length; uu[10] = HOLES.length; uu[11] = CLEARS.length
    const bu = buf(new Uint8Array(u), BU.UNIFORM), bp = buf(prims, BU.STORAGE)
    const bd = device.createBuffer({ size, usage: BU.STORAGE | BU.COPY_SRC }), br = device.createBuffer({ size, usage: BU.MAP_READ | BU.COPY_DST })
    const bg = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bu } }, { binding: 1, resource: { buffer: bd } }, { binding: 2, resource: { buffer: bp } }] })
    const e = device.createCommandEncoder(), c = e.beginComputePass()
    c.setPipeline(p); c.setBindGroup(0, bg); c.dispatchWorkgroups(NX / 4, NY / 4, NZ / 4); c.end()
    e.copyBufferToBuffer(bd, 0, br, 0, size)
    Q.submit([e.finish()])
    await br.mapAsync(GPUMapMode.READ)
    D = new Float32Array(br.getMappedRange().slice(0))
    br.unmap(); br.destroy(); bd.destroy()
    // rock connected to the seabed (see upstream main.js)
    const S = NX * NY, R = new Uint8Array(D.length), O = [1, -1, NX, -NX, S, -S], b = new Uint8Array(NX), L = []
    for (let i = 0; i < D.length;) { b.fill(1); for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++, i++) if (D[i] <= 0) b[x] = 0; else if (b[x]) R[i] = 1; else L.push(i) }
    for (let k = 1; k; L.reverse()) { k = 0; for (const i of L) if (!R[i] && O.some((o) => R[i + o])) R[i] = k = 1 }
    for (const i of L) if (!R[i]) D[i] = -D[i]
  }
  // Distance to the rock for the camera push-out, in 1/127 m (> 0 in rock,
  // clamped to +-1 m), kept only in the 4x4x4-voxel bricks near the surface
  // within the camera's reach (~2 MB). CI per brick: 0 all water, 1 all rock,
  // n brick n-2 in CG. (Unchanged from upstream main.js.)
  const CO = 52, CN = 102, CI = new Uint16Array(CN * CN * NY / 4)
  let CG = new Int8Array(64 * 65534)
  {
    let n = 0
    for (let bz = 0; bz < CN; bz++) for (let by = 1; by < NY / 4 - 1; by++) for (let bx = 0; bx < CN; bx++) {
      if (hypot(bx - CN / 2 + 0.5, bz - CN / 2 + 0.5) > 52) continue
      let lo = 127, hi = -127
      for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const i = CO + bx * 4 + x + NX * (by * 4 + y + NY * (CO + bz * 4 + z)), gz = D[i + NX * NY] - D[i - NX * NY]
        const gx = D[i + 1] - D[i - 1], g = D[i + NX] - D[i - NX], l = sqrt(gx * gx + g * g + gz * gz) / 1.5
        const q = round(clamp(D[i] / max(l, 0.05), -1, 1) * 127)
        CG[n * 64 + x + 4 * y + 16 * z] = q; if (q < lo) lo = q; if (q > hi) hi = q
      }
      CI[bx + CN * (by + NY / 4 * bz)] = lo === hi && lo * lo === 16129 ? +(lo > 0) : (n++, n + 1)
    }
    CG = CG.slice(0, n * 64)
  }

  report('Carving canyons…')
  const T = buildTerrain(D)

  // world grid is built by the generator; keep the camera path clear
  const flyPts = []
  {
    const flyLUT = new Float32Array(1025), SPL = new Float64Array(1), P6 = new Float64Array(6)
    const flyRaw = () => {
      const s = SPL[0]; let i = floor(s) | 0; if (i > FLYN - 2) i = FLYN - 2
      const u = s - i, i0 = (i > 0 ? i - 1 : 0) * 6, i1 = i * 6, i2 = (i + 1) * 6, i3 = (i + 2 < FLYN ? i + 2 : FLYN - 1) * 6
      for (let o = 0; o < 6; o++) {
        const a = FLY[i0 + o], b = FLY[i1 + o], c = FLY[i2 + o], d = FLY[i3 + o]
        P6[o] = 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u)
      }
    }
    // arc length table, same sampling as upstream (only the positions are used here)
    const M = 4096, len = new Float32Array(M + 1)
    let px = 0, py = 0, pz = 0
    for (let k = 0; k <= M; k++) {
      SPL[0] = (k / M) * (FLYN - 1); flyRaw()
      if (k) len[k] = len[k - 1] + hypot(P6[0] - px, P6[1] - py, P6[2] - pz)
      px = P6[0]; py = P6[1]; pz = P6[2]
    }
    for (let k = 0, j = 0; k <= 1024; k++) {
      const d = (k / 1024) * len[M]
      while (j < M - 1 && len[j + 1] < d) j++
      flyLUT[k] = ((j + (d - len[j]) / max(len[j + 1] - len[j], 1e-6)) / M) * (FLYN - 1)
    }
    for (let t = 0; t <= 60; t += 0.1) {
      let s = t / 60; s = s * s * (3 - 2 * s) * 0.25 + s * 0.75; s *= 1024
      let k = floor(s) | 0; if (k > 1023) k = 1023
      SPL[0] = flyLUT[k] + (flyLUT[k + 1] - flyLUT[k]) * (s - k); flyRaw()
      flyPts.push([P6[0], P6[1], P6[2]])
    }
    for (const p of POSES) flyPts.push([p[0], -40, p[2]])
  }

  report('Growing kelp…')
  const Wd = makeWorld(D, T, flyPts, POSES)
  // spawn pose: the first preset viewpoint, 1.3 m above the seabed
  const spawnPos = [POSES[0][0], Wd.gy(POSES[0][0], POSES[0][2]) + 1.3, POSES[0][2]]
  const dx = POSES[0][3] - POSES[0][0], dz = POSES[0][5] - POSES[0][2]
  const spawnYaw = atan2(dx, -dz)
  D = Wd.gy = T.smp = null

  report('Building set pieces…')
  // mesh ids: 0-3 boulders, 4-6 sponges, 7-8 coral, 9 tube sponge, 10 whale fluke, 11 ship, 12 manta, 13 fish,
  // 14-20 rock chunks + pebbles, 21-22 coral LOD, 23-25 far LOD of the large rock chunks
  const meshes = [meshChunk(1, 3), meshChunk(7, 3), meshChunk(13, 3), meshChunk(22, 3),
    meshLathe([[0, 0, 0.5], [0.34, 0, 0.6], [0.5, 0.2, 0.85], [0.6, 0.6, 1], [0.55, 0.95, 1], [0.47, 1.08, 1], [0.38, 1.1, 0.9], [0.3, 1.0, 0.45], [0.26, 0.6, 0.15], [0, 0.35, 0.05]], 18, 0.3, 9),
    meshLathe([[0, 0, 0.5], [0.2, 0, 0.6], [0.26, 0.5, 0.85], [0.4, 1.25, 1], [0.4, 1.42, 1], [0.33, 1.48, 0.9], [0.26, 1.38, 0.4], [0.18, 0.8, 0.12], [0, 0.5, 0.05]], 16, 0.35, 8),
    meshLathe([[0, 0, 0.5], [0.5, 0, 0.7], [0.72, 0.18, 1], [0.74, 0.38, 1], [0.62, 0.5, 0.9], [0.48, 0.42, 0.45], [0.4, 0.2, 0.15], [0, 0.14, 0.06]], 18, 0.25, 10),
    meshCoral(0), meshCoral(1), meshTubes()].map((m) => m.build())
  meshes.push(meshFluke(), meshShip().build(), meshManta().build(), meshFish().build(),
    meshChunk(3).build(), meshChunk(11).build(), meshChunk(29).build(), meshChunk(5, 3).build(), meshChunk(17, 3).build(), meshChunk(41, 3).build(), meshChunk(9, 1).build(), meshCoral(0, 1).build(), meshCoral(1, 1).build(), meshChunk(5, 2, 1).build(), meshChunk(17, 2, 1).build(), meshChunk(41, 2, 1).build())
  let nV = 0, nI = 0
  for (const m of meshes) { m.v0 = nV; m.i0 = nI; nV += m.nv; nI += m.ib.length }
  const allV = new Uint8Array(nV * 16), allI = new Uint32Array(nI)
  for (const m of meshes) { allV.set(new Uint8Array(m.vb), m.v0 * 16); allI.set(m.ib, m.i0) }
  const vbMesh = buf(allV, BU.VERTEX), ibMesh = buf(allI, BU.INDEX)
  const vbTerrain = buf(new Uint8Array(T.vb), BU.VERTEX), ibTerrain = buf(T.ib, BU.INDEX)
  const nSolid = Wd.solids.data.length / 12
  const solidData = new Float32Array((nSolid + 1) * 12); solidData.set(Wd.solids.data); solidData.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0], nSolid * 12)
  const ibSolids = buf(solidData, BU.VERTEX)
  const ibChunk = Wd.chunks.map((c) => buf(c.data, BU.VERTEX)), ibProp = Wd.props.map((c) => buf(c.data, BU.VERTEX))
  const ibBig = buf(new Uint8Array(Wd.big.buf), BU.VERTEX), ibBigF = buf(new Uint8Array(Wd.bigF.buf), BU.VERTEX), ibSmall = buf(new Uint8Array(Wd.small.buf), BU.VERTEX)
  const ibFish = buf(Wd.fish, BU.VERTEX), ibManta = buf(Wd.mantas, BU.VERTEX), ibBubbles = buf(Wd.bubbles, BU.VERTEX), ibSnowB = buf(Wd.snow, BU.VERTEX)
  const ibGl = buf(Wd.glints, BU.VERTEX), nGl = Wd.glints.length / 8
  const nFish = Wd.fish.length / 8, nManta = Wd.mantas.length / 8, nBub = Wd.bubbles.length / 8, nSnow = Wd.snow.length / 4
  const MANTA = meshes[12], FISH = meshes[13]
  Q.writeTexture({ texture: tVol }, Wd.volD, { bytesPerRow: NX, rowsPerImage: NY / 2 }, [NX / 2, NY / 2, NZ / 2])
  Q.writeTexture({ texture: tMap }, Wd.gm, { bytesPerRow: 2048 }, [512, 512])

  // ---------------------------------------------------------------- one-time bakes: detail texture, shadow map
  {
    const m = mod(device, W_DETAIL), p = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } })
    const e = device.createCommandEncoder()
    let r = e.beginRenderPass({ colorAttachments: [colorAtt(tDetail.createView({ baseMipLevel: 0, mipLevelCount: 1 }), true)] })
    r.setPipeline(p); r.draw(3); r.end()
    for (let i = 1; i < 11; i++) {
      r = e.beginRenderPass({ colorAttachments: [colorAtt(tDetail.createView({ baseMipLevel: i, mipLevelCount: 1 }), true)] })
      r.setPipeline(pMip8); r.setBindGroup(0, blitBG(tDetail.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }))); r.draw(3); r.end()
    }
    r = e.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: tShadow.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } })
    r.setBindGroup(0, bg0s)
    r.setPipeline(pTerrSh)
    r.setVertexBuffer(0, vbTerrain); r.setVertexBuffer(1, ibSolids); r.setIndexBuffer(ibTerrain, 'uint32')
    r.drawIndexed(T.ib.length, 1, 0, 0, nSolid)
    r.setPipeline(pSolidSh); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32')
    for (let i = 0; i < 12; i++) { const g = Wd.solids.ranges[i]; if (g[1]) r.drawIndexed(meshes[i].ib.length, g[1], meshes[i].i0, meshes[i].v0, g[0]) }
    // small rocks, sponges and corals (~35M triangles) only on High
    if (!LV) for (let i = 0; i < NCHUNK; i++) { r.setVertexBuffer(1, ibChunk[i]); r.drawIndexed(meshes[14 + i].ib.length, Wd.chunks[i].n, meshes[14 + i].i0, meshes[14 + i].v0, 0) }
    if (!LV) for (let i = 0; i < 6; i++) if (Wd.props[i].n) { r.setVertexBuffer(1, ibProp[i]); r.drawIndexed(meshes[4 + i].ib.length, Wd.props[i].n, meshes[4 + i].i0, meshes[4 + i].v0, 0) }
    r.setPipeline(pLeafSh); r.setVertexBuffer(0, ibBig); r.draw(6, Wd.big.n)
    r.end()
    Q.submit([e.finish()])
  }
  // the GPU has its own copies now: let go of the generator's
  for (const o of [Wd.big, Wd.bigF, Wd.small, ...Wd.chunks, ...Wd.props]) o.buf = o.data = 0
  Wd.glints = Wd.volD = Wd.gm = T.vb = T.ib = T.wp = T.wn = 0

  // ---------------------------------------------------------------- render targets (rebuilt on resize)
  let W = 0, H = 0, viewCount = 1, det = 1
  let reqW = width, reqH = height
  let perfSum = 0, perfFrames = 0
  let passScene, passRays, passBlur, bgBlur, passPost, bgRays, bgPost, bloomPass = [], bloomBG = [], targets = []
  const NB = 6
  const rowOrd = new Uint8Array(CELLS)

  function applySize(width, height, views) {
    const vw = max(2, round(width) & ~1), vh = max(2, round(height) & ~1)
    const vc = max(1, views | 0)
    if (vw === W && vh === H && vc === viewCount) return
    W = vw; H = vh; viewCount = vc
    canvas.width = W * viewCount; canvas.height = H
    ctx.configure({ device, format: FMT, alphaMode: 'opaque' })
    for (const t of targets) t.destroy()
    const tMS = tex(AA > 1 ? W : 1, H, HDR, TU.RENDER_ATTACHMENT, { samples: AA }), tDp = tex(W, H, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { samples: AA })
    const tRes = tex(W, H, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), tRay = tex(W / 2, H / 2, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), tRay2 = tex(W / 2, H / 2, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING)
    targets = [tMS, tDp, tRes, tRay, tRay2]
    const bl = []
    for (let i = 0; i < NB; i++) { const t = tex(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING); bl.push(t); targets.push(t) }
    const vDp = tDp.createView(), vRes = tRes.createView(), vRay = tRay.createView(), vRay2 = tRay2.createView(), vBl = bl.map((t) => t.createView())
    passScene = { colorAttachments: [{ view: AA > 1 ? tMS.createView() : vRes, resolveTarget: AA > 1 ? vRes : undefined, loadOp: 'clear', storeOp: AA > 1 ? 'discard' : 'store', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: vDp, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } }
    passRays = { colorAttachments: [colorAtt(vRay, true)] }
    passBlur = { colorAttachments: [colorAtt(vRay2, true)] }
    bgBlur = device.createBindGroup({ layout: pRB.getBindGroupLayout(0), entries: [{ binding: 0, resource: vRay }] })
    passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] }
    bgRays = [0, 1].map((n) => device.createBindGroup({ layout: pRays.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo[n] } }, { binding: 1, resource: sRep }, { binding: 2, resource: sCmp },
      { binding: 3, resource: tShadow.createView() }, { binding: 4, resource: tWater.createView() }, { binding: 5, resource: vDp }, { binding: 6, resource: tVol.createView() }, { binding: 7, resource: sClamp }] }))
    bgPost = [0, 1].map((n) => device.createBindGroup({ layout: pPost.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo[n] } }, { binding: 1, resource: sClamp }, { binding: 2, resource: vRes },
      { binding: 3, resource: vRay2 }, { binding: 4, resource: vBl[0] }, { binding: 5, resource: vDp }] }))
    bloomPass = []; bloomBG = []
    for (let i = 0; i < NB; i++) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i], true)] }); bloomBG.push(blitBG(i ? vBl[i - 1] : vRes)) }
    for (let i = NB - 1; i > 0; i--) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i - 1], false)] }); bloomBG.push(blitBG(vBl[i])) }
    for (const u of UB) { u[52] = W; u[53] = H; u[54] = 1 / W; u[55] = 1 / H }
  }
  applySize(width, height, 1)

  // ---------------------------------------------------------------- timing (GPU timestamp queries)
  let qs, qResolve, qRead = [], tsBegin, tsEnd
  if (hasTS) {
    qs = device.createQuerySet({ type: 'timestamp', count: 2 })
    qResolve = device.createBuffer({ size: 16, usage: BU.QUERY_RESOLVE | BU.COPY_SRC })
    for (let i = 0; i < 6; i++) {
      const b = device.createBuffer({ size: 16, usage: BU.MAP_READ | BU.COPY_DST })
      const o = { b, busy: false, done: null }
      o.done = () => { const a = new BigInt64Array(b.getMappedRange()); F[19] = Number(a[1] - a[0]) / 1e6; b.unmap(); o.busy = false }
      qRead.push(o)
    }
    tsBegin = { querySet: qs, beginningOfPassWriteIndex: 0 }; tsEnd = { querySet: qs, endOfPassWriteIndex: 1 }
  }

  // ---------------------------------------------------------------- frame state
  const submitList = [null]
  // CS[j] = distance to the rock (metres, < 0 in water) at the camera + CE[3j..3j+2]
  // (same lookup as upstream main.js, used to keep the camera out of the rock)
  const CE = new Float64Array([0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375]), CS = new Float64Array(7)
  const cv = (x, y, z) => { const b = CI[(x >> 2) + CN * ((y >> 2) + NY / 4 * (z >> 2))]; return b > 1 ? CG[b * 64 - 128 + (x & 3) + 4 * (y & 3) + 16 * (z & 3)] : b * 254 - 127 }
  function sd(j) {
    const x = (F[CX] + CE[j * 3] - OX) / VS - CO, y = (F[CY] + CE[j * 3 + 1] - OY) / VS, z = (F[CZ] + CE[j * 3 + 2] - OZ) / VS - CO
    const ix = x | 0, iy = y | 0, iz = z | 0, u = x - ix, v = y - iy, a = cv(ix, iy, iz), b = cv(ix, iy + 1, iz), c = cv(ix, iy, iz + 1), d = cv(ix, iy + 1, iz + 1)
    const p = a + (cv(ix + 1, iy, iz) - a) * u, q = b + (cv(ix + 1, iy + 1, iz) - b) * u, r = c + (cv(ix + 1, iy, iz + 1) - c) * u, s = d + (cv(ix + 1, iy + 1, iz + 1) - d) * u
    const e = p + (q - p) * v; CS[j] = (e + (r + (s - r) * v - e) * (z - iz)) / 127
  }
  // push the camera out of the rock (radius 0.5 m), like upstream's collide()
  function pushOut() {
    for (let k = 0; k < 2; k++) {
      sd(0); const s = CS[0] + 0.5; if (s <= 0) break
      for (let j = 1; j < 7; j++) sd(j)
      let gx = CS[1] - CS[2], gy = CS[3] - CS[4], gz = CS[5] - CS[6]; const l = sqrt(gx * gx + gy * gy + gz * gz)
      if (l < 0.075) break
      gx /= l; gy /= l; gz /= l
      F[CX] -= gx * s; F[CY] -= gy * s; F[CZ] -= gz * s
    }
  }

  // first frame: place the XRift camera at the first preset viewpoint
  let placed = false
  let yawOffset = 0
  let offX = 0, offY = 0, offZ = 0

  // Draws the cells of a cell-sorted buffer that are in view and within [minD, maxD)
  // (scaled by `det`, but not for the terrain) as merged runs, nearest rows first.
  function drawCells(r, start, lo, hi, mar, indexed, verts, minD, maxD) {
    const cx = F[CX], cy = F[CY], cz = F[CZ], fx = F[FX], fy = F[FY], fz = F[FZ], rx = F[RX], ry = F[RY], rz = F[RZ], ux = F[UX], uy = F[UY], uz = F[UZ]
    const ds = indexed === 1 ? 1 : det * det
    const tx = TANX, hw = CELLW * 0.5, ex = hw + mar, min2 = minD * minD * ds, max2 = maxD * maxD * ds
    for (let k = 0; k < CELLS; k++) {
      const rw = rowOrd[k], row = rw * CELLS, pz = OZ + (rw + 0.5) * CELLW - cz, hz = max(abs(pz) - hw, 0)
      let run = -1
      for (let x = 0; x <= CELLS; x++) {
        const c = row + x; let v = false
        if (x < CELLS) {
          const l = lo[c], h = hi[c]
          if (l <= h) {
            const px = OX + (x + 0.5) * CELLW - cx, py = (l + h) * 0.5 - cy, ey = (h - l) * 0.5 + mar, hx = max(abs(px) - hw, 0), h2 = hx * hx + hz * hz
            if (h2 < max2 && h2 >= min2) {
              const lim = px * fx + py * fy + pz * fz + ex * abs(fx) + ey * abs(fy) + ex * abs(fz)
              if (lim >= 0 && abs(px * rx + py * ry + pz * rz) - (ex * (abs(rx) + abs(rz)) + ey * abs(ry)) <= lim * tx) v = abs(px * ux + py * uy + pz * uz) - ex * (abs(ux) + abs(uz)) - ey * abs(uy) <= lim * TANY
            }
          }
        }
        if (v) { if (run < 0) run = c } else if (run >= 0) {
          const a = start[run], n = start[c] - a
          if (n > 0) { if (indexed === 1) r.drawIndexed(n * 6, 1, a * 6, 0, nSolid); else if (indexed) r.drawIndexed(indexed.ib.length, n, indexed.i0, indexed.v0, a); else r.draw(verts, n, 0, a) }
          run = -1
        }
      }
    }
  }

  // Point the engine camera at the pose in `view` (inverse of the host camera),
  // rotated by the spawn offset and shifted into the abyssal world.
  function setCamera(view, projection, time) {
    // camera basis from the view matrix (column-major, three layout)
    const e = view
    const r0 = e[0], r1 = e[4], r2 = e[8]
    const u0 = e[1], u1 = e[5], u2 = e[9]
    const b0 = e[2], b1 = e[6], b2 = e[10]
    const c0 = -(e[12] * r0 + e[13] * u0 + e[14] * b0)
    const c1 = -(e[12] * r1 + e[13] * u1 + e[14] * b1)
    const c2 = -(e[12] * r2 + e[13] * u2 + e[14] * b2)
    const fx = -b0, fy = -b1, fz = -b2
    const yaw = atan2(fx, -fz)
    const pitch = Math.asin(clamp(fy, -1, 1))

    if (!placed) {
      placed = true
      // rotate the player's starting pose onto the first preset viewpoint
      yawOffset = spawnYaw - yaw
      const cs = cos(yawOffset), sn = sin(yawOffset)
      offX = spawnPos[0] - (c0 * cs - c2 * sn)
      offY = spawnPos[1] - c1
      offZ = spawnPos[2] - (c0 * sn + c2 * cs)
    }

    const yw = yaw + yawOffset
    const cs = cos(yawOffset), sn = sin(yawOffset)
    F[CX] = offX + (c0 * cs - c2 * sn)
    F[CY] = offY + c1
    F[CZ] = offZ + (c0 * sn + c2 * cs)
    F[YAW] = yw; F[PIT] = pitch

    // keep the camera inside the designed part of the world, then out of the rock
    const rad = sqrt(F[CX] * F[CX] + F[CZ] * F[CZ])
    if (rad > 140) { F[CX] *= 140 / rad; F[CZ] *= 140 / rad }
    pushOut()

    // カメラ基底は view 行列からそのまま使う（ロールも含む）。yaw/pitch に落とすと
    // 頭を傾けたときにワールドの上方向が頭に貼り付いてしまう。
    // ワールドの初期向き合わせ（yawOffset）だけを Y 軸回転で掛ける。
    const rxv = r0, ryv = r1, rzv = r2
    const uxv = u0, uyv = u1, uzv = u2
    const fxv = -b0, fyv = -b1, fzv = -b2
    F[RX] = rxv * cs - rzv * sn; F[RY] = ryv; F[RZ] = rxv * sn + rzv * cs
    F[UX] = uxv * cs - uzv * sn; F[UY] = uyv; F[UZ] = uxv * sn + uzv * cs
    F[FX] = fxv * cs - fzv * sn; F[FY] = fyv; F[FZ] = fxv * sn + fzv * cs

    const sx = projection[0] || 1 / TANH
    const sy = projection[5] || 1 / TANH
    const ox = projection[8] || 0
    const oy = projection[9] || 0
    TANX = 1 / sx; TANY = 1 / sy

    return { sx, sy, ox, oy }
  }

  function writeUniform(n, proj, time) {
    const { sx, sy, ox, oy } = proj
    const m = UB[n]
    const cx = F[CX], cy = F[CY], cz = F[CZ]
    const rx = F[RX], ry = F[RY], rz = F[RZ], ux = F[UX], uy = F[UY], uz = F[UZ], fx = F[FX], fy = F[FY], fz = F[FZ]
    // reverse-Z infinite projection (same depth convention as upstream), plus
    // the off-centre terms of an asymmetric (XR) projection
    m[0] = rx * sx - fx * ox; m[4] = ry * sx - fy * ox; m[8] = rz * sx - fz * ox; m[12] = -(rx * cx + ry * cy + rz * cz) * sx + (fx * cx + fy * cy + fz * cz) * ox
    m[1] = ux * sy - fx * oy; m[5] = uy * sy - fy * oy; m[9] = uz * sy - fz * oy; m[13] = -(ux * cx + uy * cy + uz * cz) * sy + (fx * cx + fy * cy + fz * cz) * oy
    m[2] = 0; m[6] = 0; m[10] = 0; m[14] = NEAR
    m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -(fx * cx + fy * cy + fz * cz)
    m[32] = cx; m[33] = cy; m[34] = cz; m[35] = time
    m[36] = rx; m[37] = ry; m[38] = rz; m[39] = 1 / sx
    m[40] = ux; m[41] = uy; m[42] = uz; m[43] = 1 / sy
    m[44] = fx; m[45] = fy; m[46] = fz; m[47] = NEAR
    const zx = cx - PURPLE[0], zz = cz - PURPLE[1]
    let zt = (44 - sqrt(zx * zx + zz * zz)) / 18; zt = zt < 0 ? 0 : zt > 1 ? 1 : zt
    m[51] = zt * zt * (3 - 2 * zt)
    let ek = (-cy - 8) / 26; ek = ek < 0 ? 0 : ek > 1 ? 1 : ek
    m[56] = EXPO * (0.6 + 0.4 * ek); m[57] = RAYS; m[58] = det
    // post pass draws into the atlas: x offset of this view in the framebuffer
    m[59] = n * W
    m[52] = W; m[53] = H; m[54] = 1 / W; m[55] = 1 / H
    Q.writeBuffer(ubo[n], 0, m)
  }

  function encodeScene(e, n) {
    let r = e.beginRenderPass(passScene)
    r.setBindGroup(0, bg0[n])
    r.setPipeline(pTerrain); r.setVertexBuffer(0, vbTerrain); r.setVertexBuffer(1, ibSolids); r.setIndexBuffer(ibTerrain, 'uint32')
    drawCells(r, T.start, T.lo, T.hi, 1.5, 1, 0, 0, 240)
    r.setPipeline(pSolid); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32')
    for (let i = 0; i < 12; i++) { const g = Wd.solids.ranges[i]; if (g[1]) r.drawIndexed(meshes[i].ib.length, g[1], meshes[i].i0, meshes[i].v0, g[0]) }
    for (let i = 0; i < NCHUNK; i++) {
      const c = Wd.chunks[i], big = i > 2 && i < 6; r.setVertexBuffer(1, ibChunk[i])
      drawCells(r, c.start, c.lo, c.hi, 3, meshes[14 + i], 0, 0, i > 5 ? 30 : big ? 40 : 96)
      if (big) drawCells(r, c.start, c.lo, c.hi, 3, meshes[20 + i], 0, 40, 150)
    }
    for (let i = 0; i < 6; i++) {
      const lod = i === 3 || i === 4; r.setVertexBuffer(1, ibProp[i])
      drawCells(r, Wd.props[i].start, Wd.props[i].lo, Wd.props[i].hi, 3, meshes[4 + i], 0, 0, lod ? 6 : 110)
      if (lod) drawCells(r, Wd.props[i].start, Wd.props[i].lo, Wd.props[i].hi, 3, meshes[18 + i], 0, 6, 110)
    }
    r.setPipeline(pManta); r.setVertexBuffer(1, ibManta); r.drawIndexed(MANTA.ib.length, nManta, MANTA.i0, MANTA.v0, 0)
    r.setPipeline(pFish); r.setVertexBuffer(1, ibFish); r.drawIndexed(FISH.ib.length, nFish, FISH.i0, FISH.v0, 0)
    // kelp and plants: 9-row blades up close, 5 rows mid-range, a decimated set far away
    r.setPipeline(pLeaf); r.setVertexBuffer(0, ibBig); drawCells(r, Wd.big.start, Wd.big.lo, Wd.big.hi, 5, false, 18, 0, 24)
    r.setPipeline(pLeaf5); drawCells(r, Wd.big.start, Wd.big.lo, Wd.big.hi, 5, false, 10, 24, 58)
    r.setPipeline(pLeafF); r.setVertexBuffer(0, ibBigF); drawCells(r, Wd.bigF.start, Wd.bigF.lo, Wd.bigF.hi, 5, false, 6, 58, 150)
    r.setPipeline(pLeafS); r.setVertexBuffer(0, ibSmall); drawCells(r, Wd.small.start, Wd.small.lo, Wd.small.hi, 1.5, false, 6, 0, 70)
    r.setPipeline(pSurf); r.draw(4)
    r.setPipeline(pBack); r.draw(4)
    r.setPipeline(pBub); r.setVertexBuffer(0, ibBubbles); r.draw(4, nBub)
    r.setPipeline(pGl); r.setVertexBuffer(0, ibGl); r.draw(4, nGl)
    r.setPipeline(pSnow); r.setVertexBuffer(0, ibSnowB); r.draw(4, nSnow)
    r.end()
    // light shafts
    r = e.beginRenderPass(passRays); r.setPipeline(pRays); r.setBindGroup(0, bgRays[n]); r.draw(3); r.end()
    r = e.beginRenderPass(passBlur); r.setPipeline(pRB); r.setBindGroup(0, bgBlur); r.draw(3); r.end()
    // bloom
    for (let i = 0; i < bloomPass.length; i++) {
      r = e.beginRenderPass(bloomPass[i]); r.setPipeline(i === 0 ? pDown0 : i < NB ? pDown : pUp); r.setBindGroup(0, bloomBG[i]); r.draw(3); r.end()
    }
  }

  function encodePost(e, n, viewIndex, target) {
    passPost.colorAttachments[0].view = target
    // loadOp 'clear' clears the whole attachment, so only the first view clears
    passPost.colorAttachments[0].loadOp = viewIndex === 0 ? 'clear' : 'load'
    const r = e.beginRenderPass(passPost)
    r.setViewport(viewIndex * W, 0, W, H, 0, 1)
    r.setScissorRect(viewIndex * W, 0, W, H)
    r.setPipeline(pPost); r.setBindGroup(0, bgPost[n]); r.draw(3); r.end()
  }

  /** render one frame: one or two views, side by side */
  function renderFrame(views, time) {
    if (views.length > 2) views = views.slice(0, 2)
    applySize(reqW, reqH, views.length)

    const e = device.createCommandEncoder()
    let slot = null
    if (hasTS) { for (let i = 0; i < qRead.length; i++) if (!qRead[i].busy) { slot = qRead[i]; break } }
    waterPass[0].timestampWrites = slot ? tsBegin : undefined
    passPost.timestampWrites = slot ? tsEnd : undefined
    // animated water texture + mips (shared by all views)
    let r = e.beginRenderPass(waterPass[0]); r.setPipeline(pWater); r.setBindGroup(0, bgWater); r.draw(3); r.end()
    for (let i = 1; i < 5; i++) { r = e.beginRenderPass(waterPass[i]); r.setPipeline(pMip16); r.setBindGroup(0, waterBG[i - 1]); r.draw(3); r.end() }

    const current = ctx.getCurrentTexture().createView()
    for (let i = 0; i < views.length; i++) {
      // each view has its own pose and uniform buffer
      const v = views[i]
      const proj = setCamera(v.view, v.projection, time)
      writeUniform(i, proj, time)
      // rows of the culling grid, nearest first
      let cr = floor((F[CZ] - OZ) / CELLW) | 0; cr = cr < 0 ? 0 : cr > CELLS - 1 ? CELLS - 1 : cr
      let n = 0; rowOrd[n++] = cr
      for (let d = 1; d < CELLS; d++) { if (cr - d >= 0) rowOrd[n++] = cr - d; if (cr + d < CELLS) rowOrd[n++] = cr + d }
      encodeScene(e, i)
      encodePost(e, i, i, current)
    }
    WT[0] = time; Q.writeBuffer(uboW, 0, WT)
    if (slot) { e.resolveQuerySet(qs, 0, 2, qResolve, 0); e.copyBufferToBuffer(qResolve, 0, slot.b, 0, 16) }
    submitList[0] = e.finish()
    Q.submit(submitList)
    if (slot) { slot.busy = true; slot.b.mapAsync(GPUMapMode.READ).then(slot.done) }

    // Keep the GPU frame near 60 fps by drawing kelp and rocks less far away.
    // (The image size is fixed by the host, so upstream's dynamic resolution is
    // replaced by this draw-distance scale.)
    if (hasTS && F[19] > 0) {
      perfSum += F[19]; perfFrames++
      if (perfFrames >= 60) {
        const avg = perfSum / perfFrames
        if (avg > 17) det = max(0.5, det - 0.08)
        else if (avg < 11) det = min(1, det + 0.04)
        perfSum = 0; perfFrames = 0
      }
    }

    const bitmap = canvas.transferToImageBitmap()
    return bitmap
  }

  return {
    spawnPos,
    spawnYaw,
    get size() { return { width: W, height: H, viewCount } },
    /** last GPU frame time in ms (timestamp query; 0 when unavailable) */
    get gpuMs() { return F[19] },
    get detail() { return det },
    get pose() { return { x: F[CX], y: F[CY], z: F[CZ], yaw: F[YAW], pitch: F[PIT] } },
    /** distance to the rock at the camera in metres (< 0 in water) */
    get clearance() { sd(0); return CS[0] },
    setQualityDetail(next) { det = clamp(next, 0.4, 1) },
    resize(w, h) { reqW = w; reqH = h; applySize(reqW, reqH, viewCount) },
    renderFrame,
    dispose() {
      for (const t of targets) t.destroy()
      device.destroy()
    },
  }
}
