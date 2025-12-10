'use babel';

const axios = require('axios');
const { getConfigManager } = require('../../config');

class OllamaClient {
  constructor() {
    this.baseURL          = atom.config.get('agentic-ai.ollamaEndpoint') || 'http://localhost:11434';
    this.defaultModel     = 'deepseek-coder:6.7b';
    this.configuredModel  = atom.config.get('agentic-ai.defaultModel') || null;
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  async checkOllama() {
    try {
      const response = await axios.get(`${this.baseURL}/api/ps`);
      const models   = response.data.models;
      if (models && models.length > 0) {
        if (!this.configuredModel) this.configuredModel = models[0].name;
        return true;
      }
      return false;
    } catch (error) {
      throw new Error(`Ollama not running or accessible: ${error.message}`);
    }
  }

  /**
   * Return all installed models via /api/tags, falling back to /api/ps.
   * /api/tags lists everything installed; /api/ps only lists loaded models.
   */
  async getAvailableModels() {
    try {
      const response = await axios.get(`${this.baseURL}/api/tags`);
      return response.data.models || [];
    } catch (_) {
      try {
        const response = await axios.get(`${this.baseURL}/api/ps`);
        return response.data.models || [];
      } catch (error) {
        throw new Error(`Failed to fetch models: ${error.message}`);
      }
    }
  }

  // ─── Prompt ────────────────────────────────────────────────────────────────

  /**
   * Send a fully-assembled prompt to Ollama.
   *
   * The view builds context + question into a single string in the
   * "Full Prompt" textarea. That string is passed here as-is; we
   * no longer re-wrap it so what the user sees is what the model gets.
   *
   * @param  {string}  fullPrompt    Complete prompt (context + question)
   * @param  {string}  [systemPrompt]
   * @return {Promise<string>}       Model response text
   */
  async sendPrompt(fullPrompt, systemPrompt = null) {
    await this.ensureOllamaReady();

    const model  = this.configuredModel || this.defaultModel;
    const opts   = this._getLLMOptions();

    const system = systemPrompt ||
      `You are an expert software developer. ` +
      `Use the provided code context to give accurate, helpful responses. ` +
      `If the context is not relevant to the question, ignore it.`;

    try {
      const response = await axios.post(`${this.baseURL}/api/generate`, {
        model,
        system,
        prompt:     fullPrompt,
        stream:     false,
        keep_alive: '1h',
        options:    opts
      });
      return response.data.response;
    } catch (error) {
      throw new Error(`Ollama request failed: ${error.message}`);
    }
  }

  /**
   * Load LLM generation options from ~/.pulsar/.../ollama.json.
   * Only whitelisted numeric/boolean keys are passed to Ollama.
   * Falls back to sensible coding defaults.
   *
   * @private
   */
  _getLLMOptions() {
    const DEFAULTS = {
      temperature:    0.1,
      top_p:          0.95,
      num_predict:    1024,
      num_thread:     4,
      num_gpu:        0,
      repeat_penalty: 1.1
    };

    const ALLOWED = [
      'temperature', 'top_p', 'num_predict', 'num_thread',
      'num_gpu', 'repeat_penalty', 'num_ctx', 'num_batch',
      'top_k', 'min_p', 'seed', 'num_keep'
    ];

    try {
      const cfg    = getConfigManager('agentic-ai');
      const loaded = cfg.loadConfig('ollama.json', {});
      const merged = { ...DEFAULTS };
      for (const key of ALLOWED) {
        if (loaded[key] !== undefined) merged[key] = loaded[key];
      }
      return merged;
    } catch (_) {
      return DEFAULTS;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async ensureOllamaReady() {
    if (!this.configuredModel) {
      const ready = await this.checkOllama();
      if (!ready) {
        throw new Error('No Ollama models found. Please start a model with: ollama run <model>');
      }
    }
  }

  setModel(modelName) {
    this.configuredModel = modelName;
  }
}

module.exports = OllamaClient;
