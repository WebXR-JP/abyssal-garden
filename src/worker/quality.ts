/**
 * 画質レベルの決定（0 High / 1 Medium / 2 Low）。
 *
 * メインスレッドと Worker の両方から使う。Worker には `matchMedia` が無いので、
 * Worker 側は呼ばず、メインスレッドで決めた値を Worker の `name` で渡す
 * （`?worker&inline` の blob はモジュール評価時に品質を読むため、init メッセージでは間に合わない）。
 */
export function pickQuality(explicit?: number) {
  if (typeof explicit === 'number' && explicit >= 0) return Math.min(2, Math.floor(explicit))
  const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer:coarse)').matches : false
  // タッチ / ヘッドセットは Medium でも重い（PICO 4 Ultra の XR で 4fps だった）ので Low にする
  if (coarse) return 2
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8
  return mem <= 4 ? 2 : 0
}
