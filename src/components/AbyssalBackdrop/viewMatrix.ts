import { Matrix4, type Object3D, type PerspectiveCamera } from 'three'

/**
 * XR の目から「ワールド → ビュー」行列を作る。
 *
 * three の WebXRManager は `cameraXR.cameras`（左右の目）を rig の子にはせず、
 * `updateCamera` の中で `rig.matrixWorld * camera.matrix` を各目の matrixWorld に
 * 入れている。つまり目自身は親を持たないので、`camera.updateMatrixWorld()` を
 * 呼ぶと rig 抜きの姿勢に戻ってしまう（`@webxr-jp/webgpu-view` は
 * `getViewCameras` の戻り値にこれを呼ぶ）。
 *
 * そこで、そのフレームの姿勢 `camera.matrix` に、実際に姿勢を掛ける相手
 * （目に親があればそれ、無ければ XR カメラの親 = XRift の XROrigin / dev の rig）
 * のワールド行列を掛けて作る。
 */
export function resolveViewMatrix(
  camera: PerspectiveCamera,
  xrParent: Object3D | null,
  out: Matrix4,
): Matrix4 {
  const parent = camera.parent ?? xrParent
  if (parent) {
    parent.updateWorldMatrix(true, false)
    out.multiplyMatrices(parent.matrixWorld, camera.matrix)
  } else {
    out.copy(camera.matrix)
  }
  return out.invert()
}

/**
 * ワーカーへ渡すカメラを `resolveViewMatrix` の姿勢で埋める。
 *
 * `updateMatrixWorld()` を呼ばれても姿勢が壊れないように、ワールド姿勢を
 * そのままローカル姿勢として持たせる（親は無し）。呼び出し側で
 * `out.updateMatrixWorld()` を呼ぶと `matrixWorldInverse` が view と一致する。
 */
export function writeViewCamera(
  out: PerspectiveCamera,
  camera: PerspectiveCamera,
  xrParent: Object3D | null,
  work: Matrix4,
): PerspectiveCamera {
  const view = resolveViewMatrix(camera, xrParent, work)
  out.matrixWorldInverse.copy(view)
  out.matrix.copy(view).invert()
  out.matrix.decompose(out.position, out.quaternion, out.scale)
  out.matrixWorld.copy(out.matrix)
  out.projectionMatrix.copy(camera.projectionMatrix)
  out.projectionMatrixInverse.copy(camera.projectionMatrixInverse)
  out.near = camera.near
  out.far = camera.far
  out.fov = camera.fov
  out.aspect = camera.aspect
  return out
}
