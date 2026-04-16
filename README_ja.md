# Forensic Watermark Studio

セキュアで高精度な TypeScript 製電子透かし（フォレンジック・ウォーターマーク）スイートです。
「画像」「動画」「音声」の各種メディアに対して、堅牢で改ざん耐性のある不可視・不可聴透かしを埋め込むためのライブラリと、それをブラウザで即座に検証できる Web UI ツールを提供します。

## 🌟 特徴
- **[画像] 高度な周波数領域ウォーターマーク**: DWT + DCT + SVD による、圧縮やリサイズに強い不可視透かし。
- **[動画・音声] 超堅牢 FSK 音響透かし**: 動画や音声に重畳され、マイク録音（アナログ・ホール）耐性も備えた高周波 FSK 透かし。
- **[共通] HMAC-SHA256 署名検証**: メタデータが真正であることを証明し、改ざんを即座に検知。
- **[共通] 自己修復機能**: リード・ソロモン誤り訂正符号により、一部破壊されたデータも復元可能。
- **ライブラリ・ファースト**: コアロジックはピュア TypeScript。ブラウザ、Node.js、サーバーサイド等あらゆる環境で同一の検証結果を表示します。

## 🚀 使い方 (Web UI デモ)

```bash
# 依存関係のインストール
npm install

# ローカルWebサーバーの起動
npm run dev
```
起動後、ブラウザでファイルをドラッグ＆ドロップするだけで、埋め込みと解析を体験できます。

## 📦 ライブラリとして利用する (`watermark-lib`)

本プロジェクトの心臓部である解析エンジンは、単体ライブラリとして利用可能です。

```typescript
import { analyzeTextWatermarks, verifyWatermarks } from 'ts-forensic-watermark';

// ファイルのバイナリをスキャン
const watermarks = analyzeTextWatermarks(fileUint8Array);

// 署名の真正性を検証
const results = await verifyWatermarks(watermarks, secretKey);
```

詳細な技術仕様や API リファレンスについては、[watermark-lib/README_ja.md](watermark-lib/README_ja.md) をご覧ください。

## 🏗 アーキテクチャ構成
1. **App (React)**: ユーザーインターフェース。Canvas や AudioContext、FFmpeg.wasm のオーケストレーションを担当。
2. **watermark-lib (Core)**: 数学的計算、信号解析、署名検証を担当するビジネスロジック。
3. **FFmpeg.wasm**: ブラウザ内での動画・音声合成エンジン。

## ライセンス
MIT License
