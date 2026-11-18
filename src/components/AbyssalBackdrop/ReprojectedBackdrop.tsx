import { useFrame, useThree } from '@react-three/fiber'
import { useGpuWorker } from '@webxr-jp/webgpu-view'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DoubleSide,
  Matrix4,
  type Mesh,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three'
import { resolveViewMatrix, writeViewCamera } from './viewMatrix'

const BACKDROP_RENDER_ORDER = -1e3

/**
 * `@webxr-jp/webgpu-view` の `GpuBackdrop` の代替。
 *
 * 違いは XR のときだけ、**描画に使った姿勢 → いまの姿勢** の回転差で UV を
 * ずらして表示すること（reprojection）。背景は事実上無限遠なので回転の
 * 再投影で十分合い、首振り時のブレが減る。並進は無視する（近景ではわずかに
 * ズレるが、ブレの主因は回転）。
 *
 * 描画時の姿勢は `useGpuWorker` が送信直前に呼ぶ `getViewCameras` で記録する。
 * 次のフレームが届くまでの間、その差分をシェーダで補正する。
 */
const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const fragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uColor;
uniform float uEyeCount;
// XR で目ごとに描いている（タイルを選ぶ）
uniform float uEyeMode;
// 再投影している（描画時の姿勢が記録済み）
uniform float uPerEye;
// EASU で拡大する
uniform float uEasu;
// 1 視点ぶんのテクセルサイズ
uniform vec2 uEyeTexel;
uniform vec3 uHeadPosition;
// 描画時のカメラ基底（view 行列）と投影係数 (sx, sy, ox, oy)
uniform mat4 uPrevView0;
uniform mat4 uPrevView1;
uniform vec4 uPrevProj0;
uniform vec4 uPrevProj1;
// 現在の投影係数 (sx, sy, ox, oy)
uniform vec4 uCurProj0;
uniform vec4 uCurProj1;

vec3 linearToSRGB(vec3 color) {
  return mix(
    pow(color, vec3(0.41666)) * 1.055 - 0.055,
    color * 12.92,
    vec3(lessThanEqual(color, vec3(0.0031308)))
  );
}

/** 目タイル内のローカル uv をアトラスの uv にして 1 タップ。タイル外は端で止める */
vec3 sampleEye(vec2 localUv, float eye) {
  vec2 t = clamp(localUv, 0.5 * uEyeTexel, 1.0 - 0.5 * uEyeTexel);
  return texture2D(uColor, vec2((eye + t.x) / uEyeCount, t.y)).rgb;
}

float luma(vec3 c) {
  return c.r * 0.5 + c.g + c.b * 0.5;
}

/** EASU: 4 象限ぶんの勾配（方向と長さ）を足す */
void accumulateEdge(inout vec2 dir, inout float len, float w, float aL, float bL, float cL, float dL, float eL) {
  float dc = dL - cL;
  float cb = cL - bL;
  float dirX = dL - bL;
  float lenX = max(abs(dc), abs(cb));
  float sLenX = clamp(abs(dirX) / max(lenX, 1.0 / 65536.0), 0.0, 1.0);
  dir.x += dirX * w;
  len += sLenX * sLenX * w;

  float ec = eL - cL;
  float ca = cL - aL;
  float dirY = eL - aL;
  float lenY = max(abs(ec), abs(ca));
  float sLenY = clamp(abs(dirY) / max(lenY, 1.0 / 65536.0), 0.0, 1.0);
  dir.y += dirY * w;
  len += sLenY * sLenY * w;
}

/** EASU: 近似 Lanczos2 の重みで 1 タップ足す */
void accumulateTap(inout vec3 acc, inout float aw, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 color) {
  float vx = off.x * dir.x + off.y * dir.y;
  float vy = -off.x * dir.y + off.y * dir.x;
  float sx = vx * len2.x;
  float sy = vy * len2.y;
  float d2 = min(sx * sx + sy * sy, clp);

  float wB = d2 * (2.0 / 5.0) - 1.0;
  float wA = d2 * lob - 1.0;
  float w = (wB * wB * (25.0 / 16.0) - (25.0 / 16.0 - 1.0)) * (wA * wA);

  acc += color * w;
  aw += w;
}

/**
 * FSR1 EASU（AMD FidelityFX FSR1, MIT）の 12 タップ実装。
 * three の FSR1Node（r184+, TSL / WebGPURenderer 専用）の EASU を GLSL に写したもの。
 * uv は目タイル内の [0,1]、texel は 1/解像度。タイル外は sampleEye が端で止める。
 *
 *   b c
 * e f g h
 * i j k l
 *   n o
 */
vec3 easu(vec2 uv, float eye, vec2 texel) {
  // テクセル中心が整数になる座標系（FSR1 の ip に相当）
  vec2 pp = uv / texel - 0.5;
  vec2 f = fract(pp);
  vec2 o = -f;

  vec3 sB = sampleEye(uv + (vec2(0.0, -1.0) + o) * texel, eye);
  vec3 sC = sampleEye(uv + (vec2(1.0, -1.0) + o) * texel, eye);
  vec3 sE = sampleEye(uv + (vec2(-1.0, 0.0) + o) * texel, eye);
  vec3 sF = sampleEye(uv + (vec2(0.0, 0.0) + o) * texel, eye);
  vec3 sG = sampleEye(uv + (vec2(1.0, 0.0) + o) * texel, eye);
  vec3 sH = sampleEye(uv + (vec2(2.0, 0.0) + o) * texel, eye);
  vec3 sI = sampleEye(uv + (vec2(-1.0, 1.0) + o) * texel, eye);
  vec3 sJ = sampleEye(uv + (vec2(0.0, 1.0) + o) * texel, eye);
  vec3 sK = sampleEye(uv + (vec2(1.0, 1.0) + o) * texel, eye);
  vec3 sL = sampleEye(uv + (vec2(2.0, 1.0) + o) * texel, eye);
  vec3 sN = sampleEye(uv + (vec2(0.0, 2.0) + o) * texel, eye);
  vec3 sO = sampleEye(uv + (vec2(1.0, 2.0) + o) * texel, eye);

  float bL = luma(sB), cL = luma(sC);
  float eL = luma(sE), fL = luma(sF), gL = luma(sG), hL = luma(sH);
  float iL = luma(sI), jL = luma(sJ), kL = luma(sK), lL = luma(sL);
  float nL = luma(sN), oL = luma(sO);

  vec2 dir = vec2(0.0);
  float len = 0.0;

  float w0 = (1.0 - f.x) * (1.0 - f.y);
  float w1 = f.x * (1.0 - f.y);
  float w2 = (1.0 - f.x) * f.y;
  float w3 = f.x * f.y;

  accumulateEdge(dir, len, w0, bL, eL, fL, gL, jL);
  accumulateEdge(dir, len, w1, cL, fL, gL, hL, kL);
  accumulateEdge(dir, len, w2, fL, iL, jL, kL, nL);
  accumulateEdge(dir, len, w3, gL, jL, kL, lL, oL);

  // 勾配が無視できるときは (1, 0) に倒す
  float dirSq = dot(dir, dir);
  bool zro = dirSq < 1.0 / 32768.0;
  float rDirLen = inversesqrt(max(dirSq, 1.0 / 32768.0));
  dir.x = zro ? 1.0 : dir.x;
  dir *= zro ? 1.0 : rDirLen;

  // エッジの強さでカーネルを変形する
  len *= 0.5;
  len *= len;

  // 軸に揃ったエッジで 1.0、斜めで sqrt(2)
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - len * 0.5);

  // 負のローブ: 平坦部で強く (0.5)、エッジで弱く (0.21)
  float lob = 0.5 + (0.25 - 0.04 - 0.5) * len;
  float clp = 1.0 / lob;

  vec3 acc = vec3(0.0);
  float aw = 0.0;
  accumulateTap(acc, aw, vec2(0.0, -1.0) - f, dir, len2, lob, clp, sB);
  accumulateTap(acc, aw, vec2(1.0, -1.0) - f, dir, len2, lob, clp, sC);
  accumulateTap(acc, aw, vec2(-1.0, 0.0) - f, dir, len2, lob, clp, sE);
  accumulateTap(acc, aw, vec2(0.0, 0.0) - f, dir, len2, lob, clp, sF);
  accumulateTap(acc, aw, vec2(1.0, 0.0) - f, dir, len2, lob, clp, sG);
  accumulateTap(acc, aw, vec2(2.0, 0.0) - f, dir, len2, lob, clp, sH);
  accumulateTap(acc, aw, vec2(-1.0, 1.0) - f, dir, len2, lob, clp, sI);
  accumulateTap(acc, aw, vec2(0.0, 1.0) - f, dir, len2, lob, clp, sJ);
  accumulateTap(acc, aw, vec2(1.0, 1.0) - f, dir, len2, lob, clp, sK);
  accumulateTap(acc, aw, vec2(2.0, 1.0) - f, dir, len2, lob, clp, sL);
  accumulateTap(acc, aw, vec2(0.0, 2.0) - f, dir, len2, lob, clp, sN);
  accumulateTap(acc, aw, vec2(1.0, 2.0) - f, dir, len2, lob, clp, sO);

  acc /= aw;

  // リンギング抑止: 最近傍 4 テクセル（f, g, j, k）の範囲に収める
  vec3 mn4 = min(min(sF, sG), min(sJ, sK));
  vec3 mx4 = max(max(sF, sG), max(sJ, sK));
  return clamp(acc, mn4, mx4);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);

  if (uEyeMode > 0.5) {
    // いま描いている目（GpuBackdrop と同じ判定）
    vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    float side = dot(cameraPosition - uHeadPosition, right);
    float eye = side >= 0.0 ? 1.0 : 0.0;

    vec2 uv0 = uv;
    if (uPerEye > 0.5) {
      mat4 pv;
      vec4 pp;
      vec4 cp;
      if (eye < 0.5) { pv = uPrevView0; pp = uPrevProj0; cp = uCurProj0; }
      else { pv = uPrevView1; pp = uPrevProj1; cp = uCurProj1; }

      // 現在のピクセルの視線（view 空間、c = 1）
      float sx1 = cp.x;
      float sy1 = cp.y;
      float ox1 = cp.z;
      float oy1 = cp.w;
      float ndcX = vUv.x * 2.0 - 1.0;
      float ndcY = vUv.y * 2.0 - 1.0;
      float a1 = (ndcX + ox1) / sx1;
      float b1 = (ndcY + oy1) / sy1;

      vec3 r1 = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 u1 = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vec3 f1 = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
      vec3 d = a1 * r1 + b1 * u1 + f1; // 視線のワールド方向

      // 描画時の基底に射影し直す
      vec3 r0 = vec3(pv[0][0], pv[1][0], pv[2][0]);
      vec3 u0 = vec3(pv[0][1], pv[1][1], pv[2][1]);
      vec3 f0 = -vec3(pv[0][2], pv[1][2], pv[2][2]);
      float a0 = dot(d, r0);
      float b0 = dot(d, u0);
      float c0 = dot(d, f0);
      float c = abs(c0) < 1e-5 ? 1e-5 : c0;

      vec2 ndc0 = vec2(pp.x * a0 / c - pp.z, pp.y * b0 / c - pp.w);
      uv0 = clamp(ndc0 * 0.5 + 0.5, 0.0, 1.0); // 目のタイル外は端で止める
    }

    // sampleEye は下向きが +v なので、ここで反転して渡す
    vec2 luv = vec2(uv0.x, 1.0 - uv0.y);
    vec3 color = uEasu > 0.5 ? easu(luv, eye, uEyeTexel) : sampleEye(luv, eye);
    gl_FragColor = vec4(linearToSRGB(color), 1.0);
    return;
  }

  gl_FragColor = vec4(linearToSRGB(texture2D(uColor, uv).rgb), 1.0);
}
`

export interface ReprojectedBackdropProps {
  worker: new (options?: WorkerOptions) => Worker
  workerData?: unknown
  maxWidth?: number
  maxFps?: number
  enabled?: boolean
  stereo?: boolean
  eyeSeparation?: number
  transfer?: 'bitmap' | 'buffer'
  debug?: boolean
  profile?: boolean
  /** 姿勢の再投影（XR のみ）。オフにすると素の GpuBackdrop と同じ */
  reproject?: boolean
  /** XR で FSR1 の EASU を使って拡大する（既定 true） */
  upscale?: boolean
  onReady?: (info: unknown) => void
  onError?: (message: string) => void
  onStats?: (stats: unknown) => void
}

type Camera = PerspectiveCamera
interface FrameState {
  camera: Camera
}

/** 投影行列から、エンジンが使う係数 (sx, sy, ox, oy) を取り出す */
function writeProj(out: Vector4, camera: Camera) {
  const p = camera.projectionMatrix.elements
  out.set(p[0] || 1, p[5] || 1, p[8] || 0, p[9] || 0)
}

export const ReprojectedBackdrop: React.FC<ReprojectedBackdropProps> = ({
  worker,
  workerData,
  maxWidth = 1280,
  maxFps = 60,
  enabled = true,
  stereo = false,
  eyeSeparation = 0.064,
  transfer,
  debug = false,
  profile = false,
  reproject = true,
  upscale = true,
  onReady,
  onError,
  onStats,
}) => {
  const gl = useThree((state) => state.gl)
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)
  const [xrAspect, setXrAspect] = useState<number | null>(null)

  const eyeCount = xrAspect !== null ? 2 : stereo ? 2 : 1
  const displayAspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1
  const imageAspect =
    xrAspect !== null && Number.isFinite(xrAspect) && xrAspect > 0 ? xrAspect : displayAspect

  const resolution = useMemo(() => {
    const width = Math.max(64, Math.min(maxWidth, Math.round((size.width * dpr) / eyeCount)))
    return { width, height: Math.max(1, Math.round(width / imageAspect)) }
  }, [size.width, dpr, maxWidth, eyeCount, imageAspect])

  const eyeCameras = useMemo(() => [new PerspectiveCamera(), new PerspectiveCamera()], [])
  const headPosition = useMemo(() => new Vector3(), [])
  const rightVector = useMemo(() => new Vector3(), [])
  const tmpVector = useMemo(() => new Vector3(), [])

  // 表示中の画像を描いた姿勢。送信時点では「保留」に入れ、
  // 実際にテクスチャが更新された瞬間に昇格させる（1 フレーム分のズレを防ぐ）
  const pendingView = useMemo(() => [new Matrix4(), new Matrix4()], [])
  const pendingProj = useMemo(() => [new Vector4(1, 1, 0, 0), new Vector4(1, 1, 0, 0)], [])
  const prevView = useMemo(() => [new Matrix4(), new Matrix4()], [])
  const prevProj = useMemo(() => [new Vector4(1, 1, 0, 0), new Vector4(1, 1, 0, 0)], [])
  const hasPrev = useRef(false)
  const lastImage = useRef<unknown>(null)

  // ワーカーへ渡すカメラ。XR の目は rig / XROrigin の子ではないので、
  // ライブラリがこのカメラに `updateMatrixWorld()` を呼んでも姿勢が壊れないよう、
  // 「ワールド姿勢をローカル姿勢として持つ」専用のカメラを作って渡す。
  const workerCameras = useMemo(() => [new PerspectiveCamera(), new PerspectiveCamera()], [])
  const tmpView = useMemo(() => new Matrix4(), [])

  const recordPose = useCallback(
    (camera: Camera, index: number, xrParent: Object3D | null) => {
      pendingView[index].copy(resolveViewMatrix(camera, xrParent, tmpView))
      // renderer.js の setCamera が使う係数と同じ並び
      const p = camera.projectionMatrix.elements
      pendingProj[index].set(p[0] || 1, p[5] || 1, p[8] || 0, p[9] || 0)
    },
    [pendingView, pendingProj, tmpView],
  )

  /** 新しい画像が届いたら、その画像を描いた姿勢を「表示中の姿勢」にする */
  const promotePoseIfNewFrame = useCallback(
    (image: unknown) => {
      if (image === lastImage.current || !image) return
      lastImage.current = image
      prevView[0].copy(pendingView[0])
      prevView[1].copy(pendingView[1])
      prevProj[0].copy(pendingProj[0])
      prevProj[1].copy(pendingProj[1])
      hasPrev.current = true
    },
    [pendingView, pendingProj, prevView, prevProj],
  )

  /** record=true のときだけ「描画時の姿勢」として記録する */
  const resolveCameras = useCallback(
    (state: FrameState, record: boolean): Camera[] => {
      const xrCamera = gl.xr.isPresenting ? gl.xr.getCamera() : null
      // XR の目に親は無いので、実際に姿勢を掛ける相手は XR カメラの親
      // （XRift 本番の XROrigin / dev の rig）
      const xrParent = (xrCamera?.parent as Object3D | null) ?? null
      if (xrCamera && xrCamera.cameras.length >= 2) {
        const eyes = xrCamera.cameras as unknown as Camera[]
        headPosition
          .setFromMatrixPosition(eyes[0].matrixWorld)
          .add(tmpVector.setFromMatrixPosition(eyes[1].matrixWorld))
          .multiplyScalar(0.5)
        if (record) eyes.forEach((eye, index) => recordPose(eye, index, xrParent))
        return eyes
      }
      const main = state.camera
      if (!stereo) {
        headPosition.setFromMatrixPosition(main.matrixWorld)
        if (record) recordPose(main, 0, xrParent)
        return [main]
      }
      rightVector.setFromMatrixColumn(main.matrixWorld, 0).normalize()
      const center = tmpVector.setFromMatrixPosition(main.matrixWorld)
      eyeCameras.forEach((eye, index) => {
        eye.copy(main)
        eye.position
          .copy(center)
          .addScaledVector(rightVector, index === 0 ? -eyeSeparation / 2 : eyeSeparation / 2)
        eye.updateMatrixWorld()
        if (record) recordPose(eye, index, null)
      })
      headPosition.copy(center)
      return eyeCameras
    },
    [gl, stereo, eyeSeparation, eyeCameras, headPosition, rightVector, tmpVector, recordPose],
  )

  /**
   * `getViewCameras` は戻り値に `updateMatrixWorld()` を呼ぶ。XR の目の
   * matrixWorld は rig 抜きで上書きされてしまうので、ワールド姿勢を
   * ローカル姿勢として持つ専用カメラを返す。
   */
  const getViewsForWorker = useCallback(
    (state: FrameState) => {
      const cameras = resolveCameras(state, true)
      const xrCamera = gl.xr.isPresenting ? gl.xr.getCamera() : null
      const xrParent = (xrCamera?.parent as Object3D | null) ?? null
      return cameras.map((camera, index) =>
        writeViewCamera(workerCameras[index], camera, xrParent, tmpView),
      )
    },
    [gl, resolveCameras, workerCameras, tmpView],
  )

  const { colorTexture, hasFrame } = useGpuWorker({
    worker,
    workerData,
    width: resolution.width,
    height: resolution.height,
    maxFps,
    enabled,
    getViewCameras: getViewsForWorker as never,
    onReady: onReady as never,
    onError,
    debug,
    profile,
    onStats: onStats as never,
    transfer,
  })

  const geometry = useMemo(() => new PlaneGeometry(2, 2), [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uColor: { value: null },
          uEyeCount: { value: 1 },
          uEyeMode: { value: 0 },
          uPerEye: { value: 0 },
          uEasu: { value: 0 },
          uEyeTexel: { value: new Vector2(1 / 640, 1 / 640) },
          uHeadPosition: { value: new Vector3() },
          uPrevView0: { value: new Matrix4() },
          uPrevView1: { value: new Matrix4() },
          uPrevProj0: { value: new Vector4(1, 1, 0, 0) },
          uPrevProj1: { value: new Vector4(1, 1, 0, 0) },
          uCurProj0: { value: new Vector4(1, 1, 0, 0) },
          uCurProj1: { value: new Vector4(1, 1, 0, 0) },
        },
        vertexShader,
        fragmentShader,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    [],
  )

  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  useEffect(() => {
    gl.xr.enabled = true
  }, [gl])

  const meshRef = useRef<Mesh>(null)

  useFrame((state) => {
    const mesh = meshRef.current
    if (!mesh) return
    const visible = enabled && hasFrame
    mesh.visible = visible
    if (!visible) return

    // テクスチャが更新されていれば、その画像を描いた姿勢を「表示中の姿勢」に昇格
    promotePoseIfNewFrame(colorTexture?.image)

    const cameras = resolveCameras(state as unknown as FrameState, false)
    const presenting = gl.xr.isPresenting
    if (presenting && cameras.length >= 2) {
      const projection = cameras[0].projectionMatrix.elements
      const aspect = projection[5] / projection[0]
      if (xrAspect === null || Math.abs(aspect - xrAspect) > 0.01) setXrAspect(aspect)
    } else if (xrAspect !== null) {
      setXrAspect(null)
    }

    const u = material.uniforms
    u.uColor.value = colorTexture
    u.uEyeCount.value = cameras.length
    const eyeMode = presenting && cameras.length >= 2
    u.uEyeMode.value = eyeMode ? 1 : 0
    // 再投影するのは「XR かつ 描画時の姿勢が記録済み」のときだけ
    u.uPerEye.value = eyeMode && reproject && hasPrev.current ? 1 : 0
    // 拡大は常に XR のときだけ（モニタではほぼ 1:1 なので 12 タップの意味がない）
    u.uEasu.value = eyeMode && upscale ? 1 : 0
    u.uEyeTexel.value.set(1 / Math.max(1, resolution.width), 1 / Math.max(1, resolution.height))
    u.uHeadPosition.value.copy(headPosition)
    u.uPrevView0.value.copy(prevView[0])
    u.uPrevView1.value.copy(prevView[1])
    u.uPrevProj0.value.copy(prevProj[0])
    u.uPrevProj1.value.copy(prevProj[1])
    writeProj(u.uCurProj0.value as Vector4, cameras[0])
    writeProj(u.uCurProj1.value as Vector4, cameras[Math.min(1, cameras.length - 1)])

    if (import.meta.env.DEV) {
      // 実機で「XR 判定・解像度・再投影の有無・補正角」を外から確認するためのフック
      const pv = prevView[0].elements
      const prevFwd = new Vector3(-pv[2], -pv[6], -pv[10]).normalize()
      const curFwd = new Vector3()
        .setFromMatrixColumn(cameras[0].matrixWorldInverse, 2)
        .multiplyScalar(-1)
        .normalize()
      ;(window as unknown as { __abyssalBackdrop?: unknown }).__abyssalBackdrop = {
        presenting,
        cameras: cameras.length,
        perEye: u.uPerEye.value,
        fsr: u.uEasu.value === 1,
        resolution: { ...resolution },
        maxWidth,
        xrAspect,
        correctionDeg: +((prevFwd.angleTo(curFwd) * 180) / Math.PI).toFixed(2),
      }
    }
  })

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={BACKDROP_RENDER_ORDER}
    />
  )
}
