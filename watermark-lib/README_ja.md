# ts-forensic-watermark

フォレンジック電子透かし（ステガノグラフィ）ライブラリです。
知的財産権の保護を目的として作成されています。HMAC-SHA256署名により透かしが改ざんされていないことを証明し、法的に有効であるように配慮しています。

コアロジックはピュアTypeScriptで実装されておりブラウザ等でも動作しますが、**利便性を考慮し Node.js 環境向けに `jimp` と `fluent-ffmpeg` を内包した便利なヘルパー関数**を提供しています。これにより、画像のバッファや動画のファイルパスを渡すだけで、一発で透かしの処理が完了します。

## インストール

```bash
npm install ts-forensic-watermark
```
*(※ `jimp`、`fluent-ffmpeg`、および `ffmpeg-static` が自動的にインストールされます。FFmpegのバイナリも内包されているため、**OSへのFFmpegの事前インストールは一切不要**ですぐに動画処理が可能です)*

## 使い方 (Node.js 向け便利関数)

### 1. 画像への透かし埋め込み・抽出 (Jimp内蔵)

生のバッファ（`Buffer`）を渡すだけで、内部で自動的に画像をデコード・エンコードします。

```typescript
import { embedForensicImage, extractForensicImage } from 'ts-forensic-watermark';
import fs from 'fs';

async function processImage() {
  // --- 埋め込み ---
  const inputBuffer = fs.readFileSync('input.jpg');
  const payload = "SECURE123";
  
  // バッファを渡すだけで透かし入りのPNGバッファが返ってきます
  const watermarkedBuffer = await embedForensicImage(inputBuffer, payload);
  fs.writeFileSync('output.png', watermarkedBuffer);

  // --- 抽出 ---
  const result = await extractForensicImage(watermarkedBuffer);
  if (result && result.payload !== 'RECOVERY_FAILED') {
    console.log('抽出されたデータ:', result.payload); // "SECURE123"
    console.log('信頼度:', result.confidence);
  }
}
```

### 2. 動画への透かし埋め込み (FFmpeg内蔵)

動画ファイルに対して、**H.264 SEI** と **MP4 UUID Box** の両方を一度に注入します。再エンコードなし（`copy`）で処理されるため非常に高速です。

```typescript
import { embedVideoWatermark } from 'ts-forensic-watermark';

async function processVideo() {
  const inputPath = 'input.mp4';
  const outputPath = 'output_watermarked.mp4';
  const payload = JSON.stringify({ userId: "user_001", orderId: "ord_999" });

  // ファイルパスを渡すだけで、SEIとUUID Boxの両方が注入されます
  await embedVideoWatermark(inputPath, outputPath, payload);
  console.log('動画への透かし埋め込みが完了しました');
}
```

### 3. HMAC-SHA256 署名の生成と検証 (改ざん検知)

透かしデータが第三者によって書き換えられていないことを数学的に証明するための、HMAC署名ユーティリティも内包しています。Node.jsの `crypto` モジュールに依存せず、標準の Web Crypto API を使用しているため環境を問わず動作します。

```typescript
import { 
  generateSecurePayload, verifySecurePayload, 
  signJsonMetadata, verifyJsonSignature 
} from 'ts-forensic-watermark';

const SECRET_KEY = "my-super-secret-key";

async function testSignatures() {
  // 1. 高度フォレンジック透かし用の22バイトペイロード (6文字ID + 16文字HMAC)
  const securePayload = await generateSecurePayload("ORD123", SECRET_KEY);
  console.log(securePayload); // 例: "ORD123a1b2c3d4e5f6g7h8"
  
  const isValid = await verifySecurePayload(securePayload, SECRET_KEY);
  console.log("ペイロード検証:", isValid); // true

  // 2. EOE追記やUUID Box用のJSONメタデータ署名
  const metadata = { userId: "user_01", sessionId: "sess_99", timestamp: "2023-10-01T12:00:00Z" };
  
  // 指定したフィールドを結合して署名を生成し、オブジェクトに 'signature' を追加
  const signedMetadata = await signJsonMetadata(metadata, SECRET_KEY, ['userId', 'sessionId']);
  
  const isJsonValid = await verifyJsonSignature(signedMetadata, SECRET_KEY, ['userId', 'sessionId']);
  console.log("JSON署名検証:", isJsonValid); // true
}
```

### 4. オプションによるチューニングとID長変更

透かしの堅牢性や画質への影響を調整するためのオプション（`ForensicOptions`）を指定できます。

```typescript
import { embedForensicImage, extractForensicImage } from 'ts-forensic-watermark';

const options = {
  delta: 120,              // 彫りの深さ (デフォルト: 120)。高くすると圧縮に強くなりますがノイズが増えます。
  varianceThreshold: 25,   // 埋め込む面積の広さ (デフォルト: 25)。低くすると平坦な部分にも埋め込みますがノイズが目立ちます。
  arnoldIterations: 7      // 空間スクランブルの強度 (デフォルト: 7)。抽出時も同じ値が必要です。
};

// 埋め込み
const watermarkedBuffer = await embedForensicImage(imageBuffer, 'MyPayload', options);

// 抽出
const result = await extractForensicImage(watermarkedBuffer, options);
```

また、セキュアペイロード（デフォルト22バイト）のID長を変更することも可能です。

```typescript
import { generateSecurePayload, verifySecurePayload } from 'ts-forensic-watermark';

// 10文字のID + 12文字のHMAC署名 (合計22バイト)
const payload = await generateSecurePayload('USER123456', 'my-secret', 10);
const isValid = await verifySecurePayload(payload, 'my-secret', 10);
```

### 5. Web UI デモの使い方

本プロジェクトのルートディレクトリには、このライブラリをブラウザ上で動かすための **Web UI デモ (React + Vite)** が含まれています。サーバーサイドを一切使わず、ブラウザのローカル環境（Web Crypto API と Canvas API）だけで透かしの生成・埋め込み・抽出・署名検証を行う完全な実装例です。

**起動方法:**
```bash
# プロジェクトのルートディレクトリで実行
npm install
npm run dev
```

**機能:**
1. **署名・埋め込み (Sign & Embed) タブ**: 
   User ID や Session ID などのメタデータを入力し、画像ファイルを選択すると、「高度フォレンジック透かし（不可視）」と「EOFメタデータ（署名付きJSON）」の両方を画像に埋め込んでダウンロードできます。
2. **透かし解析 (Analyze) タブ**: 
   透かしが埋め込まれた画像をドラッグ＆ドロップすると、画像から透かしデータを自動抽出し、HMAC署名を用いてデータが改ざんされていないか（真正性）を検証・表示します。

---

## 各透かし技術の背景とメリット・デメリット

本ライブラリでは、用途に応じて複数の透かし技術を使い分けることができます。

### 1. 高度フォレンジック透かし (DWT + DCT + SVD)
* **技術的背景**: 画像の周波数領域に対して透かしを埋め込む高度なステガノグラフィ技術です。離散ウェーブレット変換 (DWT) で画像を帯域分割し、離散コサイン変換 (DCT) と特異値分解 (SVD) を用いて特異値にデータを埋め込みます。さらに、Arnold変換による空間スクランブルと、Reed-Solomon誤り訂正符号 (ECC) を組み合わせることで、データの欠落を防ぎます。
* **メリット**: 
  * **極めて高い堅牢性**: JPEG圧縮、リサイズ、切り抜き、ノイズ追加などの画像加工や劣化に対して非常に強い耐性を持ちます。
  * **不可視性**: 人間の目には透かしが入っていることがほとんど認識できません。
* **デメリット**: 
  * **計算コスト**: 複雑な数学的変換を伴うため、CPU負荷が高く処理に時間がかかります。
  * **ペイロード制限**: 埋め込めるデータ量が非常に少ない（数十バイト程度）ため、IDや短いハッシュの保存に限られます。

### 2. EOE (End Of File) メタデータ追記
* **技術的背景**: 画像（PNG/JPEG）や音声ファイルの終端（EOFマーカーの後）に、直接テキストやバイナリデータを追記する手法です。多くのメディアデコーダは、ファイル終端以降の余剰データを無視して正常に再生・表示する特性を利用しています。
* **メリット**: 
  * **無劣化かつ高速**: メディアの品質（画質・音質）に一切影響を与えず、処理も一瞬で完了します。
  * **大容量**: JSONなどの比較的大きなデータ（メタデータや署名など）をそのまま埋め込むことができます。
* **デメリット**: 
  * **脆弱性**: 画像編集ソフトでの上書き保存や、SNS等へのアップロードに伴う再エンコードによって、終端データは簡単に切り捨てられ消失します。
  * **秘匿性の低さ**: バイナリエディタ等でファイルを開くと、追記されたデータが容易に発見されてしまいます。

### 3. MP4 UUID ボックス
* **技術的背景**: MP4（ISOBMFF）コンテナフォーマットの標準規格である拡張ボックス（`uuid` box）を利用して、独自のメタデータを格納する手法です。
* **メリット**: 
  * **規格準拠**: 動画の画質・音質に影響を与えず、フォーマットの規格に則った安全なメタデータ付与が可能です。
* **デメリット**: 
  * **再エンコードに弱い**: EOEと同様に、動画共有プラットフォームへのアップロード時やトランスコード処理が行われると、カスタムボックスは削除される可能性が高いです。

### 4. H.264 SEI (Supplemental Enhancement Information)
* **技術的背景**: H.264/H.265ビデオストリームの内部（NALユニット）に直接メタデータを埋め込む手法です。本ライブラリでは、`user_data_unregistered` 形式のペイロード文字列を生成します。
* **メリット**:
  * **ストリームへの密結合**: コンテナ（MP4等）ではなくビデオストリーム自体に埋め込まれるため、コンテナの変換（MP4 -> MKV等）や単純なストリームコピーではデータが保持されます。
* **デメリット**:
  * **再エンコードに弱い**: 動画プラットフォームによる再圧縮（トランスコード）が行われると、通常はSEIメッセージも破棄されます。
  * **外部ツールの必要性**: ビデオストリームのNALユニットを直接操作するため、実際のファイルへの書き込みにはFFmpegなどのマルチプレクサが必要です。

---

## 将来の展望 (Roadmap)

### 音声・動画に対するFSK透かしの実装予定
将来的なアップデートとして、音声データおよび動画のオーディオトラックに対して、**FSK（周波数偏移変調: Frequency-Shift Keying）を用いた音響透かし（Audio Watermarking）機能**の追加を予定しています。

これにより、スピーカーからの再生音をマイクで録音（アナログ変換・再デジタル化）した場合でも透かしデータが残存する、極めて堅牢な音声フォレンジックトラッキングが本ライブラリ単体で可能になる予定です。

---

## アーキテクチャの設計思想

このライブラリは「計算ロジック」と「ファイルI/O」を完全に分離しています。
- **本ライブラリが担当するもの**: ピクセル配列の数学的変換（DWT/DCT/SVD）、誤り訂正符号の計算、バイナリデータの構築。
- **利用側（アプリ側）が担当するもの**: ファイルの読み書き、画像のデコード（Jimp/Canvas）、動画のエンコード（FFmpeg）。

これにより、特定のバックエンド環境に縛られない、極めてポータブルなライブラリとなっています。
