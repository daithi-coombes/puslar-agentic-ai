'use babel';

import { Indexer, VectorStore } from 'rag-codebase-indexer';
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const ConfigManager = require('../config');

/**
 * ContextManager — Owns the Indexer and VectorStore instances
 * and manages their EventEmitter lifecycle.
 *
 * The view subscribes to indexer/store events for progress UI.
 * ContextManager itself does NOT subscribe — it exposes the
 * instances so consumers can attach their own listeners.
 *
 * Provider-aware: reads provider + model config from ConfigManager,
 * which merges atom.config settings with the static JSON model registry.
 */
class ContextManager {

  constructor() {
    this.indexer = null;
    this.store = null;
    this.lastIndexResult = null;

    this.currentProjectRoot = '';
    this.isIndexed = false;
    this.cacheDir = path.join(
      atom.getConfigDirPath(), 'packages', 'agentic-ai', 'embeddings_cache'
    );

    this.ensureCacheDir();
    this.initializeProjectTracking();
  }

  // ── Cache Directory ────────────────────────────────────────

  /** @private */
  ensureCacheDir() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create cache directory:', error);
    }
  }

  // ── Collection & Embedding Paths ───────────────────────────

  getCollectionName(projectName) {
    const projectPath = atom.project.getPaths()[0];
    const hash = crypto.createHash('md5').update(projectPath).digest('hex');
    const baseCollection = ConfigManager.get('vectorDBs.collection') ?? 'agentic-ai';
    return `${baseCollection}_${projectName}_${hash.substr(-10)}`;
  }

  /** @private */
  getEmbeddingFilePath() {
    const projectName = this.projectName();
    if (!projectName) return null;
    return path.join(this.cacheDir, `embeddings_${projectName}.json`);
  }

  hasCachedEmbeddings() {
    const embedPath = this.getEmbeddingFilePath();
    if (!embedPath) return false;
    try { return fs.existsSync(embedPath); }
    catch (error) { return false; }
  }

  // ── Project Helpers ────────────────────────────────────────

  projectName() {
    const projectPaths = atom.project.getPaths();
    return projectPaths.length > 0 ? path.basename(projectPaths[0]) : undefined;
  }

  initializeProjectTracking() {
    atom.project.onDidChangePaths((projectPaths) => {
      if (projectPaths.length > 0) this.onProjectChange(projectPaths[0]);
      else this.onProjectClosed();
    });
    const currentPaths = atom.project.getPaths();
    if (currentPaths.length > 0) this.onProjectChange(currentPaths[0]);
  }

  /** @private */
  onProjectChange(projectRoot) {
    if (this.currentProjectRoot === projectRoot && this.isIndexed) return;
    this.currentProjectRoot = projectRoot;
    this.lastIndexResult = null;
    const hasCached = this.hasCachedEmbeddings();
    this.isIndexed = hasCached;
    console.log(hasCached
      ? `Project has cached embeddings: ${projectRoot}`
      : `Switched to project: ${projectRoot} (no cache)`);
  }

  /** @private */
  onProjectClosed() {
    this.currentProjectRoot = '';
    this.isIndexed = false;
    this.lastIndexResult = null;
  }

  // ── Provider Helpers ───────────────────────────────────────

  /**
   * Build provider-specific options for Indexer/VectorStore.
   * @private
   */
  _providerOptions(embedConfig) {
    const conn = embedConfig.connection ?? {};
    switch (embedConfig.provider) {
      case 'ollama':
        return { host: conn.baseUrl };
      case 'transformers':
        return {
          device: conn.device ?? 'cpu',
          dtype:  conn.dtype ?? 'fp32',
          quantized: embedConfig.quantized ?? false,
        };
      default:
        return conn;
    }
  }

  // ── Indexing ───────────────────────────────────────────────

  /**
   * Create an Indexer instance from config selections.
   *
   * The returned Indexer is an EventEmitter — callers should attach
   * 'progress' and 'error' listeners BEFORE calling indexCurrentProject().
   *
   * @param {string} [embedProvider] Override provider
   * @param {string} [embedModel]    Override model name
   * @returns {Promise<Indexer>}
   */
  async createIndexer(embedProvider, embedModel) {
    // Dispose previous indexer if any
    if (this.indexer) {
      await this.indexer.dispose();
      this.indexer = null;
    }

    const embedConfig = ConfigManager.getEmbedConfig(embedProvider, embedModel);

    this.indexer = await Indexer.create({
      provider: embedConfig.provider,
      model: embedConfig.name,
      providerOptions: this._providerOptions(embedConfig),
      projectName: this.projectName(),
    });

    this.indexer.on('progress', console.log);
    this.indexer.on('done', console.log);
    this.indexer.on('error', console.error);

    return this.indexer;
  }

  /**
   * Index the current project.
   *
   * Callers should attach listeners to this.indexer BEFORE calling this.
   * The indexer emits 'progress', 'error', and 'done' events.
   *
   * @param {Object}  [options]
   * @param {boolean} [options.force]          Force re-index
   * @param {string}  [options.embedProvider]  Override provider
   * @param {string}  [options.embedModel]     Override model name
   * @return {Promise<IndexResult>}
   */
  async indexCurrentProject(options = {}) {
    const { force = false, embedProvider, embedModel } = options;

    if (!this.currentProjectRoot) {
      throw new Error('No project open to index');
    }

    if (!force && this.hasCachedEmbeddings()) {
      console.log('Using cached embeddings for project');
      this.isIndexed = true;
      return this.lastIndexResult;
    }

    console.log(`Starting RAG indexing for: ${this.currentProjectRoot}`);

    // Create indexer if not already created (callers may pre-create
    // via createIndexer() to attach listeners first)
    if (!this.indexer) {
      await this.createIndexer(embedProvider, embedModel);
    }

    const indexingConfig = ConfigManager.getIndexingConfig();

    try {
      const indexResult = await this.indexer.index({
        projectPath: this.currentProjectRoot,
        cacheDir: this.cacheDir,
        include: indexingConfig.include,
        exclude: indexingConfig.exclude,
        batchSize: indexingConfig.batchSize,
        maxFileSize: 2 * 1024 * 1024,
      });

      this.lastIndexResult = indexResult;
      this.isIndexed = true;
      console.log('RAG indexing complete:', indexResult);
      return indexResult;
    } catch (error) {
      console.error('RAG indexing failed:', error);
      throw new Error(`Indexing failed: ${error.message}`);
    }
  }

  // ── Vector Storage ─────────────────────────────────────────

  /**
   * Connect to VectorStore and ingest embeddings.
   *
   * If no indexResult is provided and lastIndexResult is null,
   * falls back to the cached embeddings file on disk.
   *
   * @param {IndexResult} [indexResult] Override (defaults to lastIndexResult or cache)
   * @returns {Promise<IngestResult>}
   */
  async ingestToStore(indexResult) {
    let result = indexResult || this.lastIndexResult;

    // Fall back to cached embeddings file
    if (!result) {
      const embedPath = this.getEmbeddingFilePath();
      if (!embedPath || !fs.existsSync(embedPath)) {
        throw new Error('No index result available — run indexCurrentProject() first');
      }

      const dimensions = this._readCachedDimensions();
      result = {
        embedFile: embedPath,
        dimensions,
      };
    }

    const store = await this.ensureStore({ dimensions: result.dimensions });
    return await store.ingest(result);
  }

  /**
   * Ensure a VectorStore connection exists, reusing if possible.
   *
   * Dimensions are resolved in order:
   *   1. lastIndexResult.dimensions (just indexed in this session)
   *   2. Cached embeddings JSON on disk (indexed in a previous session)
   *
   * @param {Object} [opts]
   * @param {number} [opts.dimensions] Explicit override
   * @returns {Promise<VectorStore>}
   */
  async ensureStore(opts = {}) {
    if (this.store) return this.store;

    const dimensions = opts.dimensions
      ?? this.lastIndexResult?.dimensions
      ?? this._readCachedDimensions();

    if (!dimensions) {
      throw new Error(
        'Cannot connect to VectorStore: dimensions unknown. ' +
        'Index the project first, or ensure cached embeddings exist.'
      );
    }

    const dbConfig = ConfigManager.getVectorDbConfig();

    this.store = await VectorStore.connect({
      url: dbConfig.chromaUrl ?? dbConfig.url ?? 'http://localhost:8000',
      collection: this.getCollectionName(this.projectName()),
      batchSize: dbConfig.batchSize ?? 200,
      dimensions,
      embedOptions: {
        provider: 'Ollama'
      }
    });

    return this.store;
  }

  /**
   * Read dimensions from the cached embeddings JSON file header.
   * Returns null if the file doesn't exist or can't be parsed.
   * @private
   * @returns {number|null}
   */
  _readCachedDimensions() {
    const embedPath = this.getEmbeddingFilePath();
    if (!embedPath || !fs.existsSync(embedPath)) return null;

    try {
      const raw = fs.readFileSync(embedPath, 'utf-8');
      const data = JSON.parse(raw);
      return data.dimensions ?? null;
    } catch (err) {
      console.warn('Failed to read dimensions from cache:', err.message);
      return null;
    }
  }

  // ── Context Retrieval ─────────────────────────────────────

  isProjectIndexed() {
    const projectPaths = atom.project.getPaths();
    const projectRoot = projectPaths[0];
    if (projectRoot === this.currentProjectRoot && this.isIndexed) return true;
    return this.hasCachedEmbeddings();
  }

  /**
   * Search the vector store for relevant code context.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.currentFile] Active file path for filtering
   * @param {number} [options.topK]        Max results
   * @returns {Promise<SearchResult>}
   */
  async getContext(query, options = {}) {
    const { currentFile, topK } = options;

    const store = await this.ensureStore();
    store.on('start', console.log);
    store.on('progress', console.log);
    store.on('error', console.log);
    store.on('complete', console.log);
    const searchConfig = ConfigManager.getSearchConfig?.() ?? {};

    const searchOptions = {
      topK: topK ?? searchConfig.topK ?? 15,
    };

    if (currentFile && this.currentProjectRoot) {
      searchOptions.filters = {
        filePath: path.relative(this.currentProjectRoot, currentFile),
      };
    }

    return await store.search(query, searchOptions);
  }

  // ── Cache Management ───────────────────────────────────────

  async clearIndex() {
    const embedPath = this.getEmbeddingFilePath();
    if (embedPath && fs.existsSync(embedPath)) {
      try { fs.unlinkSync(embedPath); }
      catch (error) { console.error('Failed to delete cached file:', error); }
    }
    this.isIndexed = false;
    this.lastIndexResult = null;
    return true;
  }

  getCacheInfo() {
    const embedPath = this.getEmbeddingFilePath();
    if (!embedPath || !fs.existsSync(embedPath)) {
      return { exists: false, path: null, size: 0, modified: null };
    }
    try {
      const stats = fs.statSync(embedPath);
      return { exists: true, path: embedPath, size: stats.size, modified: stats.mtime };
    } catch (error) {
      return { exists: false, path: embedPath, size: 0, modified: null };
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async destroy() {
    await this.indexer?.dispose();
    await this.store?.dispose();
    this.indexer = null;
    this.store = null;
    this.currentProjectRoot = '';
    this.isIndexed = false;
    this.lastIndexResult = null;
  }
}

module.exports = ContextManager;
