import { useFrame, useThree } from '@react-three/fiber'
import { useGpuWorker } from '@webxr-jp/webgpu-view'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DoubleSide,
  Matrix4,
  type Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three'

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
uniform float uPerEye;
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

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);

  if (uPerEye > 0.5) {
    // いま描いている目（GpuBackdrop と同じ判定）
    vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    float side = dot(cameraPosition - uHeadPosition, right);
    int eye = side >= 0.0 ? 1 : 0;

    mat4 pv;
    vec4 pp;
    vec4 cp;
    if (eye == 0) { pv = uPrevView0; pp = uPrevProj0; cp = uCurProj0; }
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
    vec2 uv0 = clamp(ndc0 * 0.5 + 0.5, 0.0, 1.0); // 目のタイル外は端で止める
    uv = vec2(uv0.x, 1.0 - uv0.y);
    uv.x = (float(eye) + uv.x) / uEyeCount;
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

  const recordPose = useCallback(
    (camera: Camera, index: number) => {
      camera.updateMatrixWorld()
      pendingView[index].copy(camera.matrixWorldInverse)
      // renderer.js の setCamera が使う係数と同じ並び
      const p = camera.projectionMatrix.elements
      pendingProj[index].set(p[0] || 1, p[5] || 1, p[8] || 0, p[9] || 0)
    },
    [pendingView, pendingProj],
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
      if (xrCamera && xrCamera.cameras.length >= 2) {
        const eyes = xrCamera.cameras as unknown as Camera[]
        headPosition
          .setFromMatrixPosition(eyes[0].matrixWorld)
          .add(tmpVector.setFromMatrixPosition(eyes[1].matrixWorld))
          .multiplyScalar(0.5)
        if (record) eyes.forEach(recordPose)
        return eyes
      }
      const main = state.camera
      if (!stereo) {
        headPosition.setFromMatrixPosition(main.matrixWorld)
        if (record) recordPose(main, 0)
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
        if (record) recordPose(eye, index)
      })
      headPosition.copy(center)
      return eyeCameras
    },
    [gl, stereo, eyeSeparation, eyeCameras, headPosition, rightVector, tmpVector, recordPose],
  )

  const getViewsForWorker = useCallback(
    (state: FrameState) => resolveCameras(state, true),
    [resolveCameras],
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
          uPerEye: { value: 0 },
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
    // 再投影するのは「XR かつ 描画時の姿勢が記録済み」のときだけ
    u.uPerEye.value = presenting && cameras.length >= 2 && reproject && hasPrev.current ? 1 : 0
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
