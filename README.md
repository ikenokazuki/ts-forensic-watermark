# Forensic Watermark Web UI & Library

This repository contains a forensic watermarking (steganography) library and a React-based Web UI for embedding and extracting watermarks entirely in the browser.

## Project Structure

- `/watermark-lib`: The core TypeScript library for forensic watermarking (DWT + DCT + SVD). Contains its own detailed README.
- `/src`: The React + Vite Web UI demonstrating the library's capabilities using Web Crypto API and Canvas API.

## Getting Started (Web UI)

To run the Web UI locally:

```bash
npm install
npm run dev
```

## Library Documentation

For detailed instructions on how to use the core library in Node.js or Browser environments, please refer to:
- [English Documentation](./watermark-lib/README.md)
- [日本語ドキュメント](./watermark-lib/README_ja.md)
