# Architecture

## Purpose
Reusable RAG indexing library for code. Can be used standalone with the `cli` or integrated using `cjs` or `esm` modules.

## Core Responsibilities
- Code parsing (Tree-sitter)
- Embedding generation (Transformers/Ollama)
- Vector storage (ChromaDB)
- Semantic search

## Architecture Decisions

### ADR-003: Dual Export Format
**Decision**: ESM + CJS builds
**Rationale**: Compatibility with different Node.js projects

### ADR-002: Tree-sitter for Chunking
**Decision**: AST-based chunking
**Rationale**: Preserves code structure vs naive splitting
**Alternatives**: Regex-based (rejected - loses context)

### ADR-001: Pluggable Embedders
**Decision**: Abstract embedder interface
**Rationale**: Support both Transformers.js and Ollama
**Trade-offs**: More complexity, but flexibility for users

## Integration Points
```javascript
// How other projects use this library
import { Embed, VectorSearch } from 'rag-codebase-indexer';
```

## Not Responsible For
- UI/UX (consumer's job)
- LLM inference (consumer's job)
- User state management (consumer's job)
