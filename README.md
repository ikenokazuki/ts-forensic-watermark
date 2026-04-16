# Forensic Watermark Studio

A secure and high-precision TypeScript-based forensic watermarking suite.
Provides a robust library and a Web UI tool to embed and analyze tamper-resistant invisible/inaudible watermarks in **images**, **videos**, and **audio**.

## 🌟 Features
- **[Image] Advanced Frequency-Domain Watermarking**: Invisible watermarking resilient to compression and resizing via DWT + DCT + SVD.
- **[Video/Audio] Robust FSK Acoustic Watermarking**: High-frequency FSK watermarking embedded in audio tracks, surviving analog-to-digital (Analog Hole/Microphone recording) conversion.
- **[Cross-Platform] HMAC-SHA256 Signature Verification**: Proves metadata authenticity and immediately detects tampering.
- **[Cross-Platform] Self-Healing (ECC)**: Reed-Solomon Error Correction enables recovery even from partially corrupted data.
- **Library-First Architecture**: Core logic is pure TypeScript. Guarantees consistent verification results across Browser, Node.js, and Server-side environments.

## 🚀 Getting Started (Web UI Demo)

```bash
# Install dependencies
npm install

# Start local dev server
npm run dev
```
Once started, simply drag and drop files into your browser to experience embedding and analysis.

## 📦 Usage as a Library (`watermark-lib`)

The analysis engine at the heart of this project is available as a standalone library.

```typescript
import { analyzeTextWatermarks, verifyWatermarks } from 'ts-forensic-watermark';

// Scan binary data for watermarks
const watermarks = analyzeTextWatermarks(fileUint8Array);

// Verify signature authenticity
const results = await verifyWatermarks(watermarks, secretKey);
```

For detailed technical specifications and API reference, please see [watermark-lib/README_ja.md](watermark-lib/README_ja.md) (Japanese) or the source code.

## 🏗 Architecture
1. **App (React)**: User interface handling orchestration of Canvas, AudioContext, and FFmpeg.wasm.
2. **watermark-lib (Core)**: Business logic handling mathematical transforms, signal analysis, and signature verification.
3. **FFmpeg.wasm**: In-browser engine for video and audio synthesis.

## License
MIT License
