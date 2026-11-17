# Abyssal Garden — XRift world

[Noniv/abyssal-garden](https://github.com/Noniv/abyssal-garden)（MIT）を
XRift のワールドとして動かすためのフォークです。

海中世界はすべて **raw WebGPU（WGSL）** で描かれています（three.js も
Babylon も使っていません）。XRift のワールドは React Three Fiber = WebGL の
キャンバスなので、WebGPU の描画は **Worker の中で行い、結果を
[`@webxr-jp/webgpu-view`](https://www.npmjs.com/package/@webxr-jp/webgpu-view)
で R3F の背景として表示**しています。

```mermaid
flowchart LR
  subgraph main["メインスレッド (R3F / WebGL)"]
    cam["XRift のカメラ<br/>（モニタ / XR 左右の目）"]
    quad["GpuBackdrop<br/>全画面の板ポリ"]
    cam -- "view / projection 行列" --> worker
    tex["ImageBitmap → Texture"] --> quad
  end
  subgraph worker["Worker (WebGPU)"]
    worker["Abyssal Garden レンダラ<br/>地形・ケルプ・光の筋・ブルーム"]
    worker -- "transferToImageBitmap()" --> tex
  end
```

- **モニタ**: 画面全体を覆う板ポリに、ワールドのカメラから描いた 1 枚を貼る
- **XR**: 左右の目ぶんを 1 フレームで横に並べて描き（アトラス）、
  目ごとのビューポートに表示する（`@webxr-jp/webgpu-view` が自動で切り替える）
- カメラ行列は毎フレーム XRift 側から渡り、歩くと海中の視点も動く
- カメラは海底の岩にめり込まない（上流の衝突グリッドをそのまま使って押し出す）
- WebGPU が使えない環境では背景が出ないだけで、ワールド自体は起動する

## ファイル構成

```
src/
├── abyssal/
│   ├── engine.js         # 上流の quality / math / shaders / world をまとめたもの
│   ├── renderer.js       # 上流の main.js を Worker 用に書き換えたもの
│   └── LICENSE-abyssal   # 上流の MIT ライセンス
├── worker/
│   └── abyssal.worker.ts # webgpu-view の Worker プロトコル（init/resize/frame/dispose）
├── components/
│   └── AbyssalBackdrop/  # GpuBackdrop のラッパー
├── World.tsx             # スポーン・見えない床・読み込み表示
└── dev.tsx               # ローカル開発用エントリ
```

### 上流との差分

`engine.js` は上流の `source/src/{quality,math,shaders,world}.js`
（[a596354](https://github.com/Noniv/abyssal-garden/commit/a596354)）を
そのまま連結したものです。変更点は 2 つだけです。

1. 先頭の品質レベル（上流は `localStorage` / `matchMedia` から決めていましたが、
   ここでは Worker が `globalThis.__ABYSSAL_QUALITY__` で渡します）
2. `W_POST` のフラグメントシェーダで、XR のアトラス（左右の目を横並び）に
   描くときの x オフセットを `g.mis.w` から引くようにした

それ以外の WGSL とワールド生成は上流のままです。

`renderer.js` は `main.js` から次のものを置き換えています。

| 上流 | このフォーク |
| --- | --- |
| メニュー・ローディングバー・ポインタロック・タッチ操作 | なし（XRift の移動を使う） |
| `requestAnimationFrame` で描画 | `frame` メッセージで描画 |
| カメラを WASD で泳ぐ | XRift のカメラ行列から毎フレーム決める |
| 1 視点 | 1〜2 視点（XR は左右を横並びに描く） |
| 動的解像度 | 描画距離 `det` の自動調整（画像サイズはホストが決めるため） |
| 泳ぎの当たり判定 | カメラを岩から押し出すだけ（歩行は XRift 側） |
| 効果音（Web Audio） | 未移植（下記「制限」参照） |

ワールド生成・シェーダ・パス（影・光の筋・ブルーム・水面）は上流のままです。

## 開発

```bash
npm install
npm run dev        # http://localhost:5173/
npm run typecheck
npm run build      # dist/ に Module Federation の成果物
npx xrift check world
npx xrift upload   # XRift にアップロード（要 xrift login）
```

ブラウザは **WebGPU が使える Chrome / Edge** が必要です。
`npm run dev` は `http://localhost` なので secure context の条件を満たします。

### デバッグ用の URL クエリ

| クエリ | 意味 |
| --- | --- |
| `?quality=0` / `1` / `2` | High / Medium / Low（未指定は端末から自動） |
| `?maxWidth=960` | 1 視点ぶんの描画解像度の上限（既定 1280） |
| `?maxFps=30` | Worker の最大描画頻度（既定 60） |
| `?debug=1` | ready / fps をコンソールに出す |
| `?profile=1` | 1 秒ごとの描画統計（`[abyssal] stats {...}`） |
| `?off=1` | 背景を止める（切り分け用。ワールド生成は走る） |
| `?stereo=1` | モニタでも左右 2 視点（アトラスの確認用） |

## 制限

- **視差は出ません。** `GpuBackdrop` は「カメラに追従する背景」なので、
  メインシーンのオブジェクトとの前後関係は常に「背景が奥」になります。
  移動・回転に応じて海中の視点は動きますが、立体視の奥行きは画像 1 枚ぶんです。
  メインシーンとピクセル単位で合成したい場合は
  `@webxr-jp/webgpu-view/experimental` の `DepthComposite` があります（XR 非対応）。
- **VR は未検証です。** ローカルの `DevEnvironment` には Enter VR が無いため、
  ヘッドセットでの表示は未確認です。左右 2 視点（アトラス）の描画は
  `?stereo=1` でモニタ上に SBS 表示して確認できます。
  実機で確認するときは XRift にアップロードして Enter VR してください。
- **効果音は入っていません。** 上流の Web Audio の音響（`source/src/audio.js`）は
  移植していません。
- **Worker の URL は絶対パス**（`/abyssal.worker-<hash>.js`）です。
  `@webxr-jp/webgpu-view` の `?worker` import がそう出力するためで、
  ワールドをサブパスで配信する場合は `vite.config.ts` の `base` を合わせてください
  （合わないと背景だけが出ません。メインのワールドは動きます）。
- 上流の「動的解像度」の代わりに、GPU 時間を見て描画距離 `det` を
  0.45〜1.0 で自動調整します（`[abyssal] gpu ... / draw distance ...`）。
  手元の Mac（Apple Silicon, Chrome）では High / 1280x938 で
  `det` が 0.70 に落ち着き、**60 fps**（GPU 13 ms）でした。

## ライセンス

このフォークは上流と同じ **MIT** です（`LICENSE`）。
`src/abyssal/` 以下の上流コードは `src/abyssal/LICENSE-abyssal` の条件で利用しています。
