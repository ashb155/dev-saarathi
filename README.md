# Dev-Saarathi — AI Bridge for India's Developers

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/ashb155/dev-saarathi?quickstart=1)

**Dev-Saarathi** is a VS Code extension that lets developers ask coding questions and get AI-powered answers in **11 Indian languages** — by voice or text. It bridges the gap between English-dominated developer tools and India's multilingual developer community.

## Key Features

| Feature | Description |
|---------|-------------|
| **GYAAN Mode** | Type a question in any Indian language → get an AI answer with code |
| **VAANI Mode** | Press the mic button → speak in your language → get a spoken + written answer |
| **11 Languages** | Hindi, Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi, Odia, English |
| **Context-Aware** | Automatically includes your active file, diagnostics, and workspace info |
| **Agentic Actions** | One-click "Apply Code" inserts generated code directly into your editor |
| **Smart Polling** | Exponential backoff (3s → 5s → 8s) for responsive results without overloading |
| **Browser Mic Fallback** | Works in GitHub Codespaces — opens a mic recorder tab when Python/webview mic are unavailable |

## Architecture

```
┌─────────────────────┐     REST API      ┌─────────────────────────────┐
│  VS Code Extension  │ ◄──────────────► │  API Gateway (ap-south-1)   │
│  (TypeScript)       │                   │                             │
│                     │                   │  /trigger   → Lambda        │
│  Webview Chat Panel │                   │  /result    → Lambda        │
│  + Voice Recording  │                   │  /history   → Lambda        │
└─────────────────────┘                   └──────────┬──────────────────┘
                                                     │
                                          ┌──────────▼──────────────────┐
                                          │  Lambda Processor           │
                                          │  • Amazon Transcribe (STT)  │
                                          │  • Bedrock Nova Pro (LLM)   │
                                          │  • Knowledge Base (RAG)     │
                                          │  • Guardrails (safety)      │
                                          │  • S3 (audio storage)       │
                                          │  • DynamoDB (jobs, users)   │
                                          └─────────────────────────────┘
```

## Quick Start

### Option 1: GitHub Codespaces (Recommended for evaluators)

1. Click the **"Open in GitHub Codespaces"** badge above
2. Wait for the container to build (~2 min) — it auto-installs dependencies, compiles, and packages the VSIX
3. Press **F5** to launch the Extension Development Host
4. Click the **Dev-Saarathi** robot icon (🤖) in the Activity Bar
5. **Text:** Type a question in Hindi/Tamil/etc.
6. **Voice:** Click 🎤 Speak Now → a new browser tab opens for mic recording → speak → audio is sent back automatically

### Option 2: Local Development

```bash
git clone https://github.com/ashb155/dev-saarathi.git
cd dev-saarathi
npm install
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host.

**Voice recording** (VAANI) requires Python 3 with `sounddevice` and `numpy`:
```bash
pip install sounddevice numpy
```

## Usage

1. Open the **Dev-Saarathi** panel from the Activity Bar
2. **Text (GYAAN):** Type your question in any supported language and press Enter
3. **Voice (VAANI):** Click 🎤 Speak Now, select duration (5s/7s/10s/15s), speak — recording auto-stops and processes
4. View the AI response with syntax-highlighted code blocks
5. Click **"Apply Code"** to insert generated code into your active editor

## Backend (ds_arch)

The serverless backend lives in a separate repo: [ashb155/ds_arch](https://github.com/ashb155/ds_arch)

| Lambda | Purpose |
|--------|---------|
| `lambda_trigger` | Receives request, uploads audio to S3, creates DynamoDB job, invokes processor async |
| `lambda_processor` | Transcribes audio (Transcribe), detects intent, queries Knowledge Base (RAG), generates response (Bedrock Nova Pro/Lite) |
| `lambda_result` | Returns job status/result and user history |
| `lambda_scraper` | Scrapes documentation for knowledge base ingestion |
| `lambda_ingestion` | Ingests scraped content into Bedrock Knowledge Base |

## Tech Stack

- **Frontend:** TypeScript, VS Code Webview API, Web Audio API
- **Backend:** Python 3.11, AWS Lambda, API Gateway
- **AI/ML:** Amazon Bedrock (Nova Pro + Lite), Amazon Transcribe, Bedrock Knowledge Base, Bedrock Guardrails
- **Storage:** Amazon S3, Amazon DynamoDB
- **Region:** ap-south-1 (Mumbai)

## Project Structure

```
dev-saarathi/
├── src/
│   └── extension.ts          # Main extension (~880 lines)
├── .devcontainer/
│   └── devcontainer.json     # Codespaces config
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
├── esbuild.js                # Bundle config
└── CHANGELOG.md
```

## License

MIT
