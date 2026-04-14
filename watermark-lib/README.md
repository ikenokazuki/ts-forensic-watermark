# ts-forensic-watermark

A forensic watermarking (steganography) library in TypeScript.

While the core mathematical logic is pure TypeScript and environment-agnostic, **this library includes convenient Node.js helpers powered by `jimp` and `fluent-ffmpeg`**. This "batteries-included" approach allows you to process image buffers and video files directly with a single function call.

## Installation

```bash
npm install ts-forensic-watermark
```
*(Note: `jimp`, `fluent-ffmpeg`, and `ffmpeg-static` are installed automatically. Because static FFmpeg binaries are included, **you do NOT need to install FFmpeg on your OS**—video processing works out of the box).*

## Usage (Node.js Helpers)

### 1. Image Watermarking (Powered by Jimp)

Simply pass a raw image `Buffer`. The library handles decoding, embedding, and re-encoding automatically.

```typescript
import { embedForensicImage, extractForensicImage } from 'ts-forensic-watermark';
import fs from 'fs';

async function processImage() {
  // --- Embed ---
  const inputBuffer = fs.readFileSync('input.jpg');
  const payload = "SECURE123";
  
  // Returns a new PNG buffer with the watermark embedded
  const watermarkedBuffer = await embedForensicImage(inputBuffer, payload);
  fs.writeFileSync('output.png', watermarkedBuffer);

  // --- Extract ---
  const result = await extractForensicImage(watermarkedBuffer);
  if (result && result.payload !== 'RECOVERY_FAILED') {
    console.log('Extracted Payload:', result.payload); // "SECURE123"
    console.log('Confidence Score:', result.confidence);
  }
}
```

### 2. Video Watermarking (Powered by FFmpeg)

Injects both **H.264 SEI** metadata and an **MP4 UUID Box** into a video file in one go. It uses stream copying (`-c:v copy`), so it is extremely fast and does not degrade video quality.

```typescript
import { embedVideoWatermark } from 'ts-forensic-watermark';

async function processVideo() {
  const inputPath = 'input.mp4';
  const outputPath = 'output_watermarked.mp4';
  const payload = JSON.stringify({ userId: "user_001", orderId: "ord_999" });

  // Pass file paths, and it handles the FFmpeg process automatically
  await embedVideoWatermark(inputPath, outputPath, payload);
  console.log('Video watermarking complete!');
}
```

### 3. HMAC-SHA256 Signatures (Tamper Detection)

The library includes utilities to cryptographically sign your payloads, ensuring they haven't been tampered with. It uses the native Web Crypto API, so it works in Node.js, browsers, and edge environments without relying on Node's `crypto` module.

```typescript
import { 
  generateSecurePayload, verifySecurePayload, 
  signJsonMetadata, verifyJsonSignature 
} from 'ts-forensic-watermark';

const SECRET_KEY = "my-super-secret-key";

async function testSignatures() {
  // 1. Generate a 22-byte secure payload for forensic watermarking (6-char ID + 16-char HMAC)
  const securePayload = await generateSecurePayload("ORD123", SECRET_KEY);
  
  const isValid = await verifySecurePayload(securePayload, SECRET_KEY);
  console.log("Payload Valid:", isValid); // true

  // 2. Sign JSON metadata for EOE or UUID Boxes
  const metadata = { userId: "user_01", sessionId: "sess_99", timestamp: "2023-10-01T12:00:00Z" };
  
  // Generates a signature over specific fields and appends it to the object
  const signedMetadata = await signJsonMetadata(metadata, SECRET_KEY, ['userId', 'sessionId']);
  
  const isJsonValid = await verifyJsonSignature(signedMetadata, SECRET_KEY, ['userId', 'sessionId']);
  console.log("JSON Signature Valid:", isJsonValid); // true
}
```

### 4. Tuning Options & Custom ID Length

You can fine-tune the robustness and visual impact of the watermark using `ForensicOptions`.

```typescript
import { embedForensicImage, extractForensicImage } from 'ts-forensic-watermark';

const options = {
  delta: 120,              // Embedding depth (default: 120). Higher = more robust to compression, but more noise.
  varianceThreshold: 25,   // Embedding area (default: 25). Lower = embeds in flatter areas, but noise becomes more visible.
  arnoldIterations: 7      // Spatial scrambling strength (default: 7). Must match during extraction.
};

// Embed
const watermarkedBuffer = await embedForensicImage(imageBuffer, 'MyPayload', options);

// Extract
const result = await extractForensicImage(watermarkedBuffer, options);
```

You can also customize the ID length of the secure payload (default is 22 bytes total).

```typescript
import { generateSecurePayload, verifySecurePayload } from 'ts-forensic-watermark';

// 10-char ID + 12-char HMAC signature (Total: 22 bytes)
const payload = await generateSecurePayload('USER123456', 'my-secret', 10);
const isValid = await verifySecurePayload(payload, 'my-secret', 10);
```

### 5. Web UI Demo

The root directory of this project includes a **Web UI Demo (React + Vite)** that demonstrates how to use this library entirely in the browser. It is a complete implementation that performs watermark generation, embedding, extraction, and signature verification using only local browser APIs (Web Crypto API and Canvas API) without any backend server.

**How to run:**
```bash
# Run in the project root directory
npm install
npm run dev
```

**Features:**
1. **Sign & Embed Tab**: 
   Enter metadata (like User ID and Session ID), select an image, and the app will embed both a "Forensic Watermark" (invisible) and "EOF Metadata" (signed JSON) into the image, ready for download.
2. **Analyze Tab**: 
   Drag and drop a watermarked image to automatically extract the watermark data and verify its authenticity (tamper detection) using HMAC signatures.

---

## Core API (Browser / Edge Environments)

If you are running in a browser or Edge environment (like Cloudflare Workers), you can bypass the Node.js helpers and use the pure core functions directly on pixel data.

```typescript
import { embedForensic, extractForensic } from 'ts-forensic-watermark';

// Use Canvas API or any other decoder to get raw RGBA pixels
const imageData = {
  data: new Uint8ClampedArray([...]), // RGBA array
  width: 1920,
  height: 1080
};

embedForensic(imageData, "SECURE123");
```

---

## Watermarking Techniques: Background, Pros, and Cons

This library provides multiple watermarking techniques tailored for different use cases.

### 1. Advanced Forensic Watermarking (DWT + DCT + SVD)
* **Technical Background**: A sophisticated steganography technique that embeds data into the frequency domain of an image. It uses Discrete Wavelet Transform (DWT) to separate frequency bands, Discrete Cosine Transform (DCT), and Singular Value Decomposition (SVD) to embed data into the singular values. It also utilizes Arnold Transform for spatial scrambling and Reed-Solomon Error Correction Codes (ECC) to ensure data integrity.
* **Pros**:
  * **Extreme Robustness**: Highly resilient against JPEG compression, resizing, cropping, and noise addition.
  * **Invisibility**: The watermark is perceptually invisible to the human eye.
* **Cons**:
  * **High Computation Cost**: The complex mathematical transformations require significant CPU resources and processing time.
  * **Limited Payload**: Can only store a very small amount of data (e.g., ~22 bytes), making it suitable only for short IDs or hashes.

### 2. EOE (End Of File) Watermarking
* **Technical Background**: Appends raw text or binary data directly to the end of a file buffer (after the official EOF marker). Most media decoders (for PNG, JPEG, MP3) ignore any trailing data after the EOF marker, allowing the file to be read normally.
* **Pros**:
  * **Zero Degradation & High Speed**: Does not affect media quality at all and executes almost instantly.
  * **Large Payload**: Can easily store large amounts of data, such as JSON metadata or full cryptographic signatures.
* **Cons**:
  * **Fragility**: Easily destroyed. Any re-encoding, resizing, or saving via an image editor will strip the appended data.
  * **Low Secrecy**: The appended data can be easily discovered and removed using a simple hex editor.

### 3. MP4 UUID Box
* **Technical Background**: Injects a custom `uuid` extension box into the ISO Base Media File Format (ISOBMFF / MP4) container structure, which is the standard way to add custom metadata to MP4 files.
* **Pros**:
  * **Standard Compliant**: Safely adds metadata without degrading video or audio quality, adhering to MP4 specifications.
* **Cons**:
  * **Vulnerable to Transcoding**: Like EOE, custom UUID boxes are typically stripped when the video is uploaded to social media platforms or processed by transcoders.

### 4. H.264 SEI (Supplemental Enhancement Information)
* **Technical Background**: Embeds metadata directly into the H.264/H.265 video bitstream via NAL units. This library generates the `user_data_unregistered` payload string.
* **Pros**:
  * **Stream-level Binding**: Because it's embedded in the video stream rather than the container, it survives container format changes (e.g., MP4 to MKV) and stream copying.
* **Cons**:
  * **Vulnerable to Transcoding**: Usually stripped when platforms re-encode the video.
  * **Requires External Tools**: Injecting the payload into the actual video file requires a multiplexer like FFmpeg.

---

## Future Roadmap

### FSK Watermarking for Audio and Video
As a future update, we plan to implement **Audio Watermarking using FSK (Frequency-Shift Keying)** for standalone audio files and video audio tracks.

This upcoming feature will allow for extremely robust forensic tracking in audio. FSK watermarks are designed to survive analog "analog hole" conversions, meaning the watermark can still be extracted even if the audio is played through a speaker and re-recorded with a microphone.

---

## Integrating with Node.js (Jimp)

Since this library is dependency-free, you can easily plug it into your existing Node.js stack. See the `examples/` folder for an Express.js + Jimp integration example.
