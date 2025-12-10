# Agentic AI for Pulsar IDE

Local AI coding assistant for [Pulsar](https://pulsar-edit.dev/) using RAG (Retrieval-Augmented Generation). Index your codebase, search it with vector embeddings, and get grounded responses from an LLM — all running locally.

> **Status: Development Release** — The core pipeline works end-to-end but is under active development. Expect rough edges. **There is nothing agentic about this plugin... yet.**

![MIT License](https://img.shields.io/badge/license-MIT-blue)
![Pulsar ≥ 1.131.0](https://img.shields.io/badge/pulsar-%E2%89%A5%201.131.0-blueviolet)

## How It Works

The plugin implements a 4-step RAG pipeline through a dock panel UI:

```
                        ┌─────────────────────────────────────────────────────┐
                        │                    PIPELINE                         │
                        │                                                     │
  ① Configure           │  Files → chunker → embed → db → Query → embed(🔒)  │
  ② Index               │                                   → Context → llm   │
  ③ Query               │                                          → Response │
  ④ Respond             │                                                     │
                        └─────────────────────────────────────────────────────┘
```

1. **Configure** — Pick a provider (Ollama or HuggingFace Transformers), select an embedding model and LLM, choose a chunker and vector DB.
2. **Index** — Your project files are chunked, embedded, and stored as vectors. Cached locally so re-indexing is fast.
3. **Query** — Type a question. It's embedded with the same model, then matched against the vector DB. Select which result chunks to include as context.
4. **Respond** — The selected context + your question are sent to the LLM for a grounded, codebase-aware answer.

## Requirements

- **Pulsar** ≥ 1.131.0 (Electron 30 / Node 20)
- **Ollama** running locally (default: `http://127.0.0.1:11434`) — for embeddings and LLM inference
- **ChromaDB** running locally (default: `http://127.0.0.1:8000`) — for vector storage

### Quick Start with Docker

```bash
# Start ChromaDB
docker run -d -p 8000:8000 chromadb/chroma

# Ollama — install from https://ollama.com then pull models:
ollama pull nomic-embed-text    # embedding model
ollama pull deepseek-coder      # LLM for code
```

## Installation

### From Source (Development)

```bash
cd ~/.pulsar/packages
git clone https://github.com/daithi-coombes/puslar-agentic-ai.git agentic-ai
cd agentic-ai
npm install
```

The plugin also depends on [`rag-codebase-indexer`](https://github.com/daithi-coombes/rag-codebase-indexer), which is currently linked locally. See `package.json` for the path — you may need to adjust it or `npm link` the module.

### Reload Pulsar

After installing, reload Pulsar (`Ctrl+Shift+P` → `Window: Reload`) or restart it.

## Usage

1. Open a project in Pulsar
2. Toggle the panel: `Ctrl+Shift+P` → `Agentic AI: Toggle` (or click the `AI` status bar button)
3. **Configure** — select your provider, models, chunker, and vector DB
4. **Index** — click `INDEX PROJECT` to chunk and embed your codebase
5. **Query** — type a question and click `SEARCH` to find relevant code chunks
6. **Respond** — click `GENERATE RESPONSE` to get a grounded answer

## Providers

The plugin supports multiple model providers. Each provider has its own connection settings and model catalog.

| Provider | Type | Models | Notes |
|----------|------|--------|-------|
| **Ollama** | Embed + LLM | nomic-embed-text, deepseek-coder, llama3, mistral, etc. | Requires Ollama server running locally |
| **Transformers** | Embed only | Xenova/all-MiniLM-L6-v2, Xenova/bge-small-en-v1.5, etc. | Runs in-process via Transformers.js, no server needed |

In the Configure step, pick a provider tab first, then select a model. Only providers with models of the relevant type are shown (e.g. Transformers doesn't appear for LLM selection since it only provides embedding models).

### Fetching Live Models

For Ollama, click **↻ Fetch from Ollama** to query `/api/tags` and discover all models on your server. Models are automatically classified as embed or LLM based on the built-in registry. Unknown models appear in both selectors.

## Configuration

Settings are split across two sources:

### Pulsar Settings UI

`Settings → Packages → agentic-ai` gives you:

- **Providers** — enable/disable providers, connection URLs, timeouts
- **Defaults** — default provider and model for embed and LLM
- **Chunkers** — default chunker, chunk size, overlap
- **Vector Database** — ChromaDB URL, collection name, distance metric
- **Search** — top K results, score threshold
- **Indexing** — include/exclude glob patterns, batch size, cache directory

### Static Config (`config/agentic-ai.json`)

Rich per-model options that don't belong in the Settings UI:

- Per-provider model catalogs with `type: "embed"|"llm"`
- Model-specific parameters: `dimensions`, `maxTokens`, `contextWindow`, `temperature`, `quantized`
- Per-chunker default sizes
- Full ChromaDB connection options (SSL, tenant, database, headers)

Edit this file directly to add new models or tweak per-model parameters.

### Commands

| Command | Description |
|---------|-------------|
| `agentic-ai:toggle` | Open/close the panel |
| `agentic-ai:scan-project` | Index the current project |
| `agentic-ai:reset-config` | Reset all settings to defaults |
| `agentic-ai:show-config` | Open a read-only snapshot of the full config |

## Project Structure

```
agentic-ai/
├── config/
│   ├── index.js                  # ConfigManager (atom.config + static JSON)
│   └── agentic-ai.json           # Static model registry & defaults
├── lib/
│   ├── agentic-ai.js             # Package entry point (activate, commands, status bar)
│   ├── context-manager.js        # RAG pipeline: indexing, caching, vector search, context
│   └── views/
│       └── agentic-ai-view.js    # Dock panel UI (4-step wizard)
├── menus/
│   └── agentic-ai.json           # Menu items
├── styles/
│   └── agentic-ai.less           # Stylesheet (Pulsar theme vars, container queries)
├── package.json                  # Manifest, configSchema, deserializers
└── README.md
```

### Key Modules

- **ConfigManager** (`config/index.js`) — Static class wrapping `atom.config` for the `agentic-ai` namespace. Merges Pulsar settings with the static JSON model registry. Provides `listModels()`, `getModelConfig()`, `getEmbedConfig()`, `classifyOllamaModels()`, etc.

- **ContextManager** (`lib/context-manager.js`) — Owns the RAG lifecycle. Handles project tracking, embedding cache (filesystem-based JSON), vector DB storage, and context retrieval. Provider-aware: maps provider IDs to RAG-expected type strings and builds provider-specific options.

- **AgenticAiView** (`lib/views/agentic-ai-view.js`) — Pulsar workspace item implementing the 4-step UI. Two-step provider→model picker in Configure, progress bar in Index, search results with selectable chunks in Query, streaming mock response in Respond. Serializes step + selections across restarts.

## Embedding Cache

Indexed embeddings are cached as JSON files in `~/.pulsar/agentic-ai/embeddings/`. The cache key includes the project name and a path hash, so different checkouts of the same project get separate caches.

Re-opening a previously indexed project loads from cache instantly. Use the `INDEX PROJECT` button to force re-indexing.

## Roadmap

- [x] 4-step pipeline UI (Configure → Index → Query → Respond)
- [x] Provider architecture (Ollama + Transformers)
- [x] Embedding cache with project tracking
- [x] Extensible config (JSON schema + static model registry)
- [x] Wire real LLM calls in Respond step
- [ ] Wire real vector search in Query step
- [ ] Streaming LLM responses
- [ ] Build adapters for additional vector DBs
- [ ] Project-level config overrides
- [ ] Sequence diagrams for code navigation
- [ ] Refactor with TDD
- [ ] First stable release

## Development

```bash
# Link rag-codebase-indexer for local development
cd /path/to/rag-codebase-indexer
npm link
cd ~/.pulsar/packages/agentic-ai
npm link rag-codebase-indexer

# Start services
docker run -d -p 8000:8000 chromadb/chroma
ollama serve

# Reload Pulsar after changes
# Ctrl+Shift+P → Window: Reload
```

Open DevTools (`Ctrl+Shift+I`) to see console logs from ConfigManager, ContextManager, and the view.

## Dependencies

| Package | Purpose |
|---------|---------|
| [ollama](https://www.npmjs.com/package/ollama) | Ollama client SDK |
| [rag-codebase-indexer](https://github.com/daithi-coombes/rag-codebase-indexer) | Chunking, embedding, and vector search |

## License

MIT — see [LICENSE](LICENSE)
