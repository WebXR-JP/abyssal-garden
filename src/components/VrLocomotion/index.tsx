import { useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Euler, Group, type Object3D, Quaternion, Vector3 } from 'three'

/**
 * ローカル開発用の VR 移動。
 *
 * 本番の XRift は VR 中のプレイヤーを `kinematicPosition` の RigidBody で動かし、
 * その子に `XROrigin` を置いているので、スティックで体が動けば視点も一緒に動く
 * （`xrift-frontend` の `LocalPlayerCore` の `{isInVR && children}`）。
 *
 * 一方 `DevEnvironment` には VR 用の入力・移動が無い（キーボードだけ）。
 * そのため `npm run dev` → Enter VR ではコントローラーで一切動けない。
 *
 * ここでは XRift の VR 移動と同じ操作感を dev 用に用意する:
 *   左スティック: 移動（5 m/s、倒しきると 7.5 m/s）
 *   右スティック: 旋回（1.2 rad/s、頭を中心に回る）
 *
 * カメラ（と three の XR カメラ）を自前のグループ（rig）の子にして、その
 * グループを動かす。three の WebXRManager は `camera.parent` を XR の姿勢に
 * 掛けるので、これで視点が動く。本番では XROrigin が既にカメラの親になって
 * いるため、**親があるときは何もしない**（二重に動かさない）。
 */

/** xr-standard のスティック（上と左が負） */
const STICK_X = 2
const STICK_Y = 3
/** XRift の VR 入力と同じ値（DevEnvironment の移動に合わせる） */
const MOVE_DEADZONE = 0.02
const TURN_DEADZONE = 0.05
const WALK_SPEED = 5.0
const DASH_SPEED = 7.5
const DASH_THRESHOLD = 0.85
const TURN_SPEED = 1.2
/** 1 フレームとして扱う最大秒 */
const MAX_DELTA = 0.1
/**
 * セッション開始直後は XRift（本番）の XROrigin がまだカメラを引き取っていない
 * ことがある。プラットフォームの管理下かどうかを判定するまで、少し待つ。
 */
const TAKEOVER_FRAMES = 30

const UP = new Vector3(0, 1, 0)

export const VrLocomotion: React.FC = () => {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)

  const rig = useMemo(() => new Group(), [])
  const head = useMemo(() => new Vector3(), [])
  const quaternion = useMemo(() => new Quaternion(), [])
  const euler = useMemo(() => new Euler(0, 0, 0, 'YXZ'), [])
  const forward = useMemo(() => new Vector3(), [])
  const right = useMemo(() => new Vector3(), [])

  const freeFrames = useRef(0)
  const attached = useRef(false)
  /** rig に入れた three の XR カメラ（外すときに使う） */
  const attachedXr = useRef<Object3D | null>(null)

  const detach = useCallback(() => {
    if (!attached.current) return
    const xr = attachedXr.current
    if (xr && xr.parent === rig) rig.remove(xr)
    if (camera.parent === rig) rig.remove(camera)
    rig.position.set(0, 0, 0)
    rig.rotation.set(0, 0, 0)
    rig.updateMatrixWorld(true)
    attachedXr.current = null
    attached.current = false
  }, [rig, camera])

  useEffect(() => {
    rig.name = 'dev-xr-rig'
    scene.add(rig)
    // 実機でスティックを押さずに姿勢を動かして確認するための穴（?vrDebug=1 のときだけ）
    if (new URLSearchParams(window.location.search).get('vrDebug') === '1') {
      ;(window as unknown as { __vrRig?: Group }).__vrRig = rig
    }
    return () => {
      detach()
      rig.removeFromParent()
    }
  }, [scene, rig, detach])

  useFrame((_state, delta) => {
    const session = gl.xr.isPresenting ? gl.xr.getSession() : null
    const xrCamera = session ? gl.xr.getCamera() : null

    // XRift 本番は XROrigin をカメラの親にして動かす。自分以外の親があるなら任せる
    const managed = !!xrCamera && xrCamera.parent !== null && xrCamera.parent !== rig

    if (!xrCamera || !session || managed) {
      freeFrames.current = 0
      detach()
      return
    }

    if (!attached.current) {
      // 本番の XROrigin が付くのを少し待ってから、自前で持つ
      freeFrames.current++
      if (freeFrames.current < TAKEOVER_FRAMES) return
      xrCamera.getWorldPosition(head)
      // 旋回の中心が頭の真下に来るように置く（原点まわりで回ると目線が振られる）
      rig.position.set(head.x, 0, head.z)
      rig.rotation.set(0, 0, 0)
      // three の XR カメラは親を持たないと render 時に姿勢だけで上書きされる。
      // カメラも XR カメラも rig の子にして、rig の変換が view に乗るようにする
      rig.add(xrCamera)
      rig.add(camera)
      rig.updateMatrixWorld(true)
      attachedXr.current = xrCamera
      attached.current = true
      return
    }

    // 何かに付け替えられていたら付け直す（R3F のカメラ差し替え対策）
    if (camera.parent !== rig) rig.add(camera)
    if (attachedXr.current && attachedXr.current.parent !== rig) rig.add(attachedXr.current)

    const dt = Math.min(Math.max(delta, 0), MAX_DELTA)

    let moveX = 0
    let moveY = 0
    let turnX = 0
    for (const source of session.inputSources) {
      const gamepad = source.gamepad
      if (!gamepad) continue
      const x = gamepad.axes[STICK_X] ?? 0
      const y = gamepad.axes[STICK_Y] ?? 0
      if (source.handedness === 'left') {
        moveX = Math.abs(x) > MOVE_DEADZONE ? x : 0
        moveY = Math.abs(y) > MOVE_DEADZONE ? y : 0
      } else if (source.handedness === 'right') {
        turnX = Math.abs(x) > TURN_DEADZONE ? x : 0
      }
    }

    xrCamera.getWorldPosition(head)
    xrCamera.getWorldQuaternion(quaternion)
    euler.setFromQuaternion(quaternion, 'YXZ')

    // 頭を中心に旋回する（rig 自身の原点まわりだと目線が横に振られる）
    const yawDelta = turnX !== 0 ? -turnX * TURN_SPEED * dt : 0
    if (yawDelta !== 0) {
      const dx = rig.position.x - head.x
      const dz = rig.position.z - head.z
      const cs = Math.cos(yawDelta)
      const sn = Math.sin(yawDelta)
      rig.position.x = head.x + cs * dx + sn * dz
      rig.position.z = head.z - sn * dx + cs * dz
      rig.rotation.y += yawDelta
    }

    // 移動は頭の向き（旋回ぶんを含む）基準。右スティックの上下は使わない
    const yaw = euler.y + yawDelta
    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw))
    right.crossVectors(forward, UP).normalize()

    const magnitude = Math.hypot(moveX, moveY)
    const speed = magnitude >= DASH_THRESHOLD ? DASH_SPEED : WALK_SPEED
    // WebXR のスティックは上（前）が負
    rig.position.addScaledVector(forward, -moveY * speed * dt)
    rig.position.addScaledVector(right, moveX * speed * dt)

    rig.updateMatrixWorld(true)
  })

  return null
}
