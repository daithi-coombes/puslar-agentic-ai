'use strict';

const staticConfig = require('./agentic-ai.json');

/**
 * ConfigManager — Provider-aware config layer.
 *
 * Two data sources:
 *   1. atom.config (configSchema in package.json) — connection settings,
 *      defaults, chunker/vectorDB/search/indexing prefs.  Editable in
 *      Settings → Packages → agentic-ai.  Persisted in config.cson.
 *
 *   2. staticConfig (agentic-ai.json) — rich per-model options grouped
 *      by provider (dimensions, contextWindow, temperature, etc.).
 *      Editable by opening the JSON file directly.
 *
 * The view talks to this class; it never reads atom.config or the JSON
 * file directly.
 */
class ConfigManager {

  static NAMESPACE = 'agentic-ai';

  // ── Basic CRUD (atom.config) ───────────────────────────────

  static get(keyPath) {
    return atom.config.get(`${this.NAMESPACE}.${keyPath}`);
  }

  static set(keyPath, value) {
    return atom.config.set(`${this.NAMESPACE}.${keyPath}`, value);
  }

  static reset(keyPath) {
    return atom.config.unset(`${this.NAMESPACE}.${keyPath}`);
  }

  static observe(keyPath, callback) {
    return atom.config.observe(`${this.NAMESPACE}.${keyPath}`, callback);
  }

  static onDidChange(keyPath, callback) {
    return atom.config.onDidChange(`${this.NAMESPACE}.${keyPath}`, callback);
  }

  // ── Schema helpers ─────────────────────────────────────────

  static getSchemaEnum(keyPath) {
    try {
      const schema = atom.config.getSchema(`${this.NAMESPACE}.${keyPath}`);
      return schema?.enum ?? null;
    } catch (e) {
      return null;
    }
  }

  // ── Array CRUD ─────────────────────────────────────────────

  static addToArray(keyPath, item) {
    const arr = [...(this.get(keyPath) ?? [])];
    if (!arr.includes(item)) {
      arr.push(item);
      this.set(keyPath, arr);
    }
    return arr;
  }

  static removeFromArray(keyPath, item) {
    const arr = (this.get(keyPath) ?? []).filter(i => i !== item);
    this.set(keyPath, arr);
    return arr;
  }

  // ── Provider Registry ──────────────────────────────────────

  /**
   * List all known provider IDs from the static config.
   * @return {string[]}  e.g. ['ollama', 'transformers']
   */
  static listProviders() {
    return Object.keys(staticConfig.providers ?? {});
  }

  /**
   * List only the providers the user has enabled in settings.
   * @return {string[]}
   */
  static listEnabledProviders() {
    return this.listProviders().filter(id =>
      this.get(`providers.${id}.enabled`) !== false
    );
  }

  /**
   * Get the static provider definition (label, description, models map).
   * @param  {string} providerId
   * @return {Object|null}
   */
  static getProviderDef(providerId) {
    return staticConfig.providers?.[providerId] ?? null;
  }

  /**
   * Get the merged connection config for a provider.
   * atom.config values (user overrides) take precedence over the
   * static JSON defaults.
   *
   * @param  {string} providerId
   * @return {Object}
   */
  static getProviderConnection(providerId) {
    const staticConn = staticConfig.providers?.[providerId]?.connection ?? {};
    const settingsConn = this.get(`providers.${providerId}`) ?? {};

    // Settings has flat keys like baseUrl, requestTimeout alongside
    // 'enabled' which we strip out.
    const { enabled, ...overrides } = settingsConn;
    return { ...staticConn, ...overrides };
  }

  // ── Model Registry ─────────────────────────────────────────

  /**
   * List models for a provider, optionally filtered by type.
   *
   * @param  {string}           providerId  e.g. 'ollama'
   * @param  {'embed'|'llm'}    [type]      Filter by model type
   * @return {{ name: string, type: string, provider: string, ...rest }[]}
   */
  static listModels(providerId, type = null) {
    const providerDef = staticConfig.providers?.[providerId];
    if (!providerDef?.models) return [];

    return Object.entries(providerDef.models)
      .filter(([, cfg]) => !type || cfg.type === type)
      .map(([name, cfg]) => ({
        name,
        provider: providerId,
        ...cfg,
      }));
  }

  /**
   * List models across ALL enabled providers, optionally by type.
   * Returns objects with { name, provider, type, ...rest }.
   *
   * @param  {'embed'|'llm'} [type]
   * @return {Array}
   */
  static listAllModels(type = null) {
    const results = [];
    for (const providerId of this.listEnabledProviders()) {
      results.push(...this.listModels(providerId, type));
    }
    return results;
  }

  /**
   * Get the full config for a specific provider + model.
   * Merges the static model config with the provider's connection config.
   *
   * @param  {string} providerId
   * @param  {string} modelName
   * @return {Object|null}
   */
  static getModelConfig(providerId, modelName) {
    const modelDef = staticConfig.providers?.[providerId]?.models?.[modelName];
    if (!modelDef) return null;

    return {
      name: modelName,
      provider: providerId,
      connection: this.getProviderConnection(providerId),
      ...modelDef,
    };
  }

  /**
   * Classify a list of live Ollama model names against the static
   * config registry. Returns { known: [], unknown: [] } where known
   * models include their type.
   *
   * @param  {string[]} ollamaNames  Model names from /api/tags
   * @return {{ known: Object[], unknown: string[] }}
   */
  static classifyOllamaModels(ollamaNames) {
    const registry = staticConfig.providers?.ollama?.models ?? {};
    const known = [];
    const unknown = [];

    for (const name of ollamaNames) {
      // Try exact match first, then prefix match
      const exactKey = Object.keys(registry).find(k => name === k);
      const prefixKey = !exactKey
        ? Object.keys(registry).find(k => name.startsWith(k))
        : null;
      const key = exactKey ?? prefixKey;

      if (key) {
        known.push({ name, provider: 'ollama', ...registry[key] });
      } else {
        unknown.push(name);
      }
    }

    return { known, unknown };
  }

  // ── Convenience Accessors ──────────────────────────────────

  /** Get the full embed config for the selected (or default) provider + model. */
  static getEmbedConfig(selectedProvider = null, selectedModel = null) {
    let provider = selectedProvider ?? this.get('defaults.embedProvider') ?? 'ollama';
    let model    = selectedModel ?? this.get('defaults.embedModel') ?? 'nomic-embed-text';

    // fix up case for rag-codebase-indexer
    if (provider=='ollama') provider = 'Ollama';
    if (provider=='transformers') provider = 'Transformers';

    return this.getModelConfig(provider, model) ?? {
      name: model,
      provider,
      type: 'embed',
      connection: this.getProviderConnection(provider),
    };
  }

  /** Get the full LLM config for the selected (or default) provider + model. */
  static getLlmConfig(selectedProvider = null, selectedModel = null) {
    const provider = selectedProvider ?? this.get('defaults.llmProvider') ?? 'ollama';
    const model    = selectedModel ?? this.get('defaults.llmModel') ?? 'deepseek-coder';
    return this.getModelConfig(provider, model) ?? {
      name: model,
      provider,
      type: 'llm',
      connection: this.getProviderConnection(provider),
    };
  }

  /** Get chunker config. */
  static getChunkerConfig(selectedChunker = null) {
    const type = selectedChunker ?? this.get('chunkers.default') ?? 'treesitter';
    const staticOpts = staticConfig.chunkers?.[type] ?? {};
    return {
      type,
      chunkSize:    this.get('chunkers.chunkSize')    ?? staticOpts.chunkSize ?? 1500,
      chunkOverlap: this.get('chunkers.chunkOverlap') ?? staticOpts.chunkOverlap ?? 200,
    };
  }

  /** Get vector DB config (ChromaDB). */
  static getVectorDbConfig(projectName) {
    const type = this.get('vectorDBs.default') ?? 'chromadb';
    const staticOpts = staticConfig.vectorDBs?.[type] ?? {};
    return {
      type,
      url:            this.get('vectorDBs.chromadbUrl')     ?? staticOpts.url,
      collectionName:     projectName,
      distanceMetric: this.get('vectorDBs.distanceMetric')  ?? staticOpts.distanceMetric,
      ...staticOpts,
    };
  }

  /** Get search/query config. */
  static getSearchConfig() {
    return {
      topK:           this.get('search.topK')           ?? 5,
      scoreThreshold: this.get('search.scoreThreshold') ?? 0.65,
    };
  }

  /** Get indexing config. */
  static getIndexingConfig(projectName) {
    const config = {
      include:   this.get('indexing.include')   ?? staticConfig.indexing?.include,
      exclude:   this.get('indexing.exclude')   ?? staticConfig.indexing?.exclude,
      batchSize: this.get('indexing.batchSize') ?? staticConfig.indexing?.batchSize ?? 50,
      cacheDir:  this.get('indexing.cacheDir'),
    };

    if (projectName) config.projectName = projectName;
    return config;
  }

  // ── Snapshot / Restore ─────────────────────────────────────

  static snapshot() {
    return {
      settings: atom.config.get(this.NAMESPACE),
      staticConfig,
    };
  }

  static restore(flatEntries) {
    for (const [keyPath, value] of Object.entries(flatEntries)) {
      this.set(keyPath, value);
    }
  }

  static resetAll() {
    atom.config.unset(this.NAMESPACE);
  }
}

module.exports = ConfigManager;
