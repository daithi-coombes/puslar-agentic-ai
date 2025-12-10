'use babel';

const { CompositeDisposable, Disposable } = require('atom');
const ConfigManager = require('../../config');
const VIEW_URI = 'atom://agentic-ai';
const fs = require('fs');
const path = require('path');

/**
 * Agentic AI View — Pulsar workspace item (dock panel)
 *
 * Implements the 4-step RAG pipeline UI:
 *   1. Configure  — pick provider → pick model (two-step), chunker, vector DB
 *   2. Index      — chunk → embed → store codebase
 *   3. Query      — embed question, search vectors, pick context
 *   4. Respond    — send context + prompt to LLM
 *
 * All RAG operations go through ContextManager. The view subscribes to
 * Indexer/VectorStore EventEmitter events for live progress updates and
 * detaches listeners on destroy or operation completion.
 */
class AgenticAiView {

  static STEPS = [
    { id: 'configure', label: 'Configure', icon: '⚙' },
    { id: 'index',     label: 'Index',     icon: '◫' },
    { id: 'query',     label: 'Query',     icon: '⌕' },
    { id: 'respond',   label: 'Respond',   icon: '◉' },
  ];

  // ── Construction / Lifecycle ───────────────────────────────

  constructor(serializedState = {}, contextManager = null) {
    if (!serializedState) serializedState = {};
    this.subscriptions = new CompositeDisposable();
    this.contextManager = contextManager;
    this.currentStep = serializedState?.currentStep ?? 'configure';

    this.selections = {
      embedProvider: serializedState.embedProvider ?? null,
      embedModel:    serializedState.embedModel    ?? null,
      llmProvider:   serializedState.llmProvider   ?? null,
      llmModel:      serializedState.llmModel      ?? null,
      chunker:       serializedState.chunker        ?? null,
      vectorDb:      serializedState.vectorDb       ?? null,
    };

    this._ollamaLiveModels = null;

    // Search state
    this._lastQuery = '';
    this._searchResults = [];
    this.selectedResults = new Set();
    this._isSearching = false;

    // Bound handler references for EventEmitter cleanup
    this._boundProgressHandler = null;
    this._boundErrorHandler = null;

    this.element = document.createElement('div');
    this.element.classList.add('agentic-ai', 'native-key-bindings');
    this.element.setAttribute('tabindex', '-1');

    this._buildUI();
    this._applyDefaults();
    this._render();

    this.subscriptions.add(
      atom.config.onDidChange('agentic-ai', () => this._render())
    );
  }

  serialize() {
    return {
      deserializer: 'agentic-ai/AgenticAiView',
      currentStep:  this.currentStep,
      ...this.selections,
    };
  }

  destroy() {
    this._detachListeners();
    this.subscriptions.dispose();
    this.element.remove();
  }

  /**
   * Detach any EventEmitter listeners from indexer/store.
   * Safe to call multiple times.
   * @private
   */
  _detachListeners() {
    if (this._boundProgressHandler) {
      this.contextManager?.indexer?.removeListener('progress', this._boundProgressHandler);
      this.contextManager?.store?.removeListener('progress', this._boundProgressHandler);
      this._boundProgressHandler = null;
    }
    if (this._boundErrorHandler) {
      this.contextManager?.indexer?.removeListener('error', this._boundErrorHandler);
      this._boundErrorHandler = null;
    }
  }

  // ── Workspace Item Protocol ────────────────────────────────

  getTitle()            { return 'Agentic AI'; }
  getURI()              { return VIEW_URI; }
  getIconName()         { return 'hubot'; }
  getDefaultLocation()  { return 'right'; }
  getAllowedLocations() { return ['left', 'right', 'bottom']; }
  getPreferredWidth()   { return 420; }
  getElement()          { return this.element; }

  // ── Defaults ───────────────────────────────────────────────

  _applyDefaults() {
    const s = this.selections;
    if (!s.embedProvider) s.embedProvider = ConfigManager.get('defaults.embedProvider') ?? 'ollama';
    if (!s.embedModel)    s.embedModel    = ConfigManager.get('defaults.embedModel')    ?? 'nomic-embed-text';
    if (!s.llmProvider)   s.llmProvider   = ConfigManager.get('defaults.llmProvider')   ?? 'ollama';
    if (!s.llmModel)      s.llmModel      = ConfigManager.get('defaults.llmModel')      ?? 'deepseek-coder';
    if (!s.chunker)       s.chunker       = ConfigManager.get('chunkers.default')       ?? 'treesitter';
    if (!s.vectorDb)      s.vectorDb      = ConfigManager.get('vectorDBs.default')      ?? 'chromadb';
  }

  // ── Config Helpers ─────────────────────────────────────────

  _cfg(key, fallback = undefined) {
    return atom.config.get(`agentic-ai.${key}`) ?? fallback;
  }

  _schemaEnum(keyPath) {
    try {
      return atom.config.getSchema(`agentic-ai.${keyPath}`)?.enum ?? null;
    } catch (e) { return null; }
  }

  // ── DOM Building ───────────────────────────────────────────

  _buildUI() {
    this.pipelineEl = this._el('div', 'agentic-ai__pipeline');
    this.element.appendChild(this.pipelineEl);

    this.stepBarEl = this._el('div', 'agentic-ai__step-bar');
    this.element.appendChild(this.stepBarEl);

    this.contentEl = this._el('div', 'agentic-ai__content');
    this.element.appendChild(this.contentEl);

    this.navEl = this._el('div', 'agentic-ai__nav');
    this.backBtn = this._el('button', 'agentic-ai__nav-btn agentic-ai__nav-btn--back');
    this.backBtn.textContent = '← Back';
    this.backBtn.addEventListener('click', () => this._navigate(-1));
    this.nextBtn = this._el('button', 'agentic-ai__nav-btn agentic-ai__nav-btn--next');
    this.nextBtn.textContent = 'Next →';
    this.nextBtn.addEventListener('click', () => this._navigate(1));
    this.navEl.append(this.backBtn, this.nextBtn);
    this.element.appendChild(this.navEl);
  }

  // ── Rendering ──────────────────────────────────────────────

  _render() {
    this._renderPipeline();
    this._renderStepBar();
    this._renderContent();
    this._renderNav();
  }

  _renderPipeline() {
    const s = this.selections;

    const embedLabel = s.embedModel
      ? `${s.embedProvider}:${s.embedModel}` : 'embed?';
    const llmLabel = s.llmModel
      ? `${s.llmProvider}:${s.llmModel}` : 'llm?';

    const nodes = [
      { label: 'Files',                    color: 'muted',   filled: true },
      { label: s.chunker || 'chunker?',    color: 'chunker', filled: !!s.chunker },
      { label: embedLabel,                 color: 'embed',   filled: !!s.embedModel },
      { label: s.vectorDb || 'db?',        color: 'db',      filled: !!s.vectorDb },
      { label: 'Query',                    color: 'muted',   filled: true },
      { label: embedLabel,                 color: 'embed',   filled: !!s.embedModel, locked: true },
      { label: 'Context',                  color: 'chunker', filled: true },
      { label: llmLabel,                   color: 'llm',     filled: !!s.llmModel },
      { label: 'Response',                 color: 'muted',   filled: true },
    ];

    this.pipelineEl.innerHTML = '';

    const label = this._el('span', 'agentic-ai__pipeline-label');
    label.textContent = 'PIPELINE';
    this.pipelineEl.appendChild(label);

    const row = this._el('div', 'agentic-ai__pipeline-row');
    nodes.forEach((n, i) => {
      const chip = this._el('span',
        `agentic-ai__pipeline-node agentic-ai__pipeline-node--${n.color}` +
        (n.filled ? ' is-filled' : '') +
        (n.locked ? ' is-locked' : '')
      );
      chip.textContent = n.label;
      row.appendChild(chip);

      if (i < nodes.length - 1) {
        const arrow = this._el('span', 'agentic-ai__pipeline-arrow');
        arrow.textContent = '→';
        row.appendChild(arrow);
      }
    });
    this.pipelineEl.appendChild(row);
  }

  _renderStepBar() {
    this.stepBarEl.innerHTML = '';
    const currentIdx = AgenticAiView.STEPS.findIndex(s => s.id === this.currentStep);

    AgenticAiView.STEPS.forEach((step, i) => {
      const isActive = step.id === this.currentStep;
      const isPast   = i < currentIdx;

      const btn = this._el('button',
        'agentic-ai__step' +
        (isActive ? ' is-active' : '') +
        (isPast   ? ' is-past'   : '')
      );
      btn.addEventListener('click', () => { this.currentStep = step.id; this._render(); });

      const icon = this._el('span', 'agentic-ai__step-icon');
      icon.textContent = isPast ? '✓' : step.icon;
      btn.appendChild(icon);

      const lbl = this._el('span', 'agentic-ai__step-label');
      lbl.textContent = step.label;
      btn.appendChild(lbl);

      this.stepBarEl.appendChild(btn);

      if (i < AgenticAiView.STEPS.length - 1) {
        const line = this._el('span',
          'agentic-ai__step-line' + (isPast ? ' is-past' : '')
        );
        this.stepBarEl.appendChild(line);
      }
    });
  }

  _renderContent() {
    this.contentEl.innerHTML = '';
    switch (this.currentStep) {
      case 'configure': this._renderConfigure(); break;
      case 'index':     this._renderIndex();     break;
      case 'query':     this._renderQuery();     break;
      case 'respond':   this._renderRespond();   break;
    }
  }

  _renderNav() {
    const idx = AgenticAiView.STEPS.findIndex(s => s.id === this.currentStep);
    this.backBtn.disabled = idx === 0;
    this.nextBtn.disabled = idx === AgenticAiView.STEPS.length - 1;
  }

  // ── Step: Configure ────────────────────────────────────────

  _renderConfigure() {
    const section = this._el('div', 'agentic-ai__step-content');

    section.appendChild(this._heading('Pipeline Configuration'));
    section.appendChild(this._subtitle(
      'Pick a provider, then select models. The embedding model is locked across index & query steps.'
    ));

    section.appendChild(this._providerModelPicker({
      title: 'Embedding Model',
      subtitle: 'Used for both indexing AND query embedding.',
      colorClass: 'embed',
      modelType: 'embed',
      selectedProvider: this.selections.embedProvider,
      selectedModel:    this.selections.embedModel,
      onSelectProvider: (p) => {
        this.selections.embedProvider = p;
        this.selections.embedModel = null;
        this._render();
      },
      onSelectModel: (m) => {
        this.selections.embedModel = m;
        this._render();
      },
    }));

    section.appendChild(this._providerModelPicker({
      title: 'LLM Model',
      subtitle: 'Used for final response generation.',
      colorClass: 'llm',
      modelType: 'llm',
      selectedProvider: this.selections.llmProvider,
      selectedModel:    this.selections.llmModel,
      onSelectProvider: (p) => {
        this.selections.llmProvider = p;
        this.selections.llmModel = null;
        this._render();
      },
      onSelectModel: (m) => {
        this.selections.llmModel = m;
        this._render();
      },
    }));

    const row = this._el('div', 'agentic-ai__config-row');

    const chunkerOpts = this._schemaEnum('chunkers.default') ?? ['treesitter'];
    row.appendChild(this._chipPicker({
      title: 'Chunker',
      colorClass: 'chunker',
      options: chunkerOpts,
      selected: this.selections.chunker,
      onSelect: (c) => { this.selections.chunker = c; this._render(); },
    }));

    const dbOpts = this._schemaEnum('vectorDBs.default') ?? ['chromadb'];
    row.appendChild(this._chipPicker({
      title: 'Vector DB',
      colorClass: 'db',
      options: dbOpts,
      selected: this.selections.vectorDb,
      onSelect: (d) => { this.selections.vectorDb = d; this._render(); },
    }));

    section.appendChild(row);

    const detailRow = this._el('div', 'agentic-ai__config-row');
    detailRow.appendChild(this._configDetail({
      title: 'Chunk Settings',
      colorClass: 'chunker',
      items: [
        { label: 'Size',    value: this._cfg('chunkers.chunkSize', 1500) },
        { label: 'Overlap', value: this._cfg('chunkers.chunkOverlap', 200) },
      ],
    }));
    detailRow.appendChild(this._configDetail({
      title: 'Vector DB',
      colorClass: 'db',
      items: [
        { label: 'URL',      value: this._cfg('vectorDBs.chromadbUrl', 'http://127.0.0.1:8000') },
        { label: 'Distance', value: this._cfg('vectorDBs.distanceMetric', 'cosine') },
      ],
    }));
    section.appendChild(detailRow);

    this.contentEl.appendChild(section);
  }

  // ── Step: Index ────────────────────────────────────────────

  _renderIndex() {
    const section = this._el('div', 'agentic-ai__step-content');

    section.appendChild(this._heading('Index Codebase'));
    section.appendChild(this._subtitle(
      'Chunk → Embed → Store. Your project files will be processed with the pipeline from step 1.'
    ));

    section.appendChild(this._lockedBadges([
      { label: 'chunker', value: this.selections.chunker, color: 'chunker' },
      { label: 'embed',   value: this._providerModelLabel('embed'), color: 'embed' },
      { label: 'db',      value: this.selections.vectorDb, color: 'db' },
    ]));

    // Project path
    const projectCard = this._el('div', 'agentic-ai__card');
    const projectLabel = this._el('div', 'agentic-ai__card-title agentic-ai__card-title--chunker');
    projectLabel.textContent = 'PROJECT';
    projectCard.appendChild(projectLabel);

    const projectPath = this._el('div', 'agentic-ai__project-path');
    const paths = atom.project.getPaths();
    const firstPath = paths.length ? paths[0] : null;
    projectPath.textContent = firstPath || '(no project open)';
    projectCard.appendChild(projectPath);
    section.appendChild(projectCard);

    // Progress bar (shared for index + ingest)
    this.progressEl = this._el('div', 'agentic-ai__progress');
    this.progressEl.style.display = 'none';
    const progressBar = this._el('div', 'agentic-ai__progress-bar');
    this.progressFill = this._el('div', 'agentic-ai__progress-fill');
    progressBar.appendChild(this.progressFill);
    this.progressLabel = this._el('span', 'agentic-ai__progress-label');
    this.progressEl.append(this.progressLabel, progressBar);
    section.appendChild(this.progressEl);

    // Check for existing embeddings
    const fileExists = firstPath && this.contextManager?.hasCachedEmbeddings();

    // Index button
    const buttonRowIndex = this._el('div', 'agentic-ai__button-row');
    const canIndex = this.selections.embedModel && this.selections.chunker && this.selections.vectorDb && firstPath;
    const indexBtn = this._el('button',
      'agentic-ai__action-btn agentic-ai__action-btn--index' +
      (!canIndex ? ' is-disabled' : '')
    );
    indexBtn.textContent = fileExists ? '✓ RE-INDEX' : 'INDEX PROJECT';
    indexBtn.disabled = !canIndex;
    indexBtn.addEventListener('click', () => this._handleIndex(indexBtn));
    buttonRowIndex.appendChild(indexBtn);

    // Ingest to DB button
    const buttonRowDB = this._el('div', 'agentic-ai__button-row');
    const canUpdate = fileExists && this.selections.vectorDb && firstPath;
    const updateBtn = this._el('button',
      'agentic-ai__action-btn agentic-ai__action-btn--update' +
      (!canUpdate ? ' is-disabled' : '')
    );
    updateBtn.textContent = 'UPDATE DATABASE';
    updateBtn.disabled = !canUpdate;
    updateBtn.addEventListener('click', () => this._handleUpdateDatabase(updateBtn));
    buttonRowDB.appendChild(updateBtn);

    section.appendChild(buttonRowIndex);
    section.appendChild(buttonRowDB);
    this.contentEl.appendChild(section);
  }

  /**
   * Handle INDEX button.
   *
   * Flow:
   *   1. contextManager.createIndexer() — async factory, loads model
   *   2. indexer.on('progress') — subscribe for live progress bar updates
   *   3. contextManager.indexCurrentProject() — runs scan → chunk → embed → cache
   *   4. Detach listeners on completion or error
   */
  async _handleIndex(btn) {
    btn.disabled = true;
    btn.textContent = 'INDEXING…';
    this.progressEl.style.display = '';
    this.progressLabel.textContent = 'LOADING MODEL…';
    this.progressFill.style.width = '0%';
    this.progressFill.classList.remove('is-complete');

    try {
      // 1. Create the Indexer (loads embedding model)
      const indexer = await this.contextManager.createIndexer(
        this.selections.embedProvider,
        this.selections.embedModel
      );

      // 2. Subscribe to progress events
      this._boundProgressHandler = (evt) => {
        const { phase, status, current, total, message } = evt;

        if (status === 'start') {
          this.progressLabel.textContent = `${phase.toUpperCase()}…`;
          this.progressFill.style.width = '0%';
        } else if (status === 'progress' && total > 0) {
          const pct = Math.round((current / total) * 100);
          this.progressLabel.textContent = message || `${phase}: ${current}/${total}`;
          this.progressFill.style.width = `${pct}%`;
          btn.textContent = `INDEXING… ${pct}%`;
        } else if (status === 'complete') {
          this.progressLabel.textContent = message || `${phase.toUpperCase()} COMPLETE`;
        }
      };

      this._boundErrorHandler = ({ phase, message, recoverable }) => {
        if (recoverable) {
          console.warn(`[${phase}] ${message}`);
        } else {
          atom.notifications.addError(`Indexing failed at ${phase}`, {
            detail: message,
            dismissable: true,
          });
        }
      };

      indexer.on('progress', this._boundProgressHandler);
      indexer.on('error', this._boundErrorHandler);

      // 3. Run the pipeline
      await this.contextManager.indexCurrentProject({
        force: true,
        embedProvider: this.selections.embedProvider,
        embedModel: this.selections.embedModel,
      });

      // 4. Success
      this.progressLabel.textContent = 'COMPLETE';
      this.progressFill.style.width = '100%';
      this.progressFill.classList.add('is-complete');
      btn.textContent = '✓ RE-INDEX';
      btn.disabled = false;

    } catch (err) {
      console.error('Index error:', err);
      this.progressLabel.textContent = 'ERROR';
      this.progressFill.style.width = '0%';
      btn.textContent = 'INDEX PROJECT';
      btn.disabled = false;
      atom.notifications.addError('Indexing failed', { detail: err.message });
    } finally {
      this._detachListeners();
    }
  }

  /**
   * Handle UPDATE DATABASE button — ingest embeddings into VectorStore.
   *
   * Flow:
   *   1. contextManager.ensureStore() — connect to ChromaDB
   *   2. store.on('progress') — subscribe for ingest progress
   *   3. contextManager.ingestToStore() — read cache → bulk insert
   *   4. Detach listeners
   */
  async _handleUpdateDatabase(btn) {
    btn.disabled = true;
    btn.textContent = 'UPDATING…';
    this.progressEl.style.display = '';
    this.progressLabel.textContent = 'CONNECTING TO DATABASE…';
    this.progressFill.style.width = '0%';

    try {
      // 1. Get or create store connection
      const store = await this.contextManager.ensureStore();

      // 2. Subscribe to ingest progress
      this._boundProgressHandler = (evt) => {
        const { phase, status, current, total, detail } = evt;

        if (phase === 'load' && status === 'start') {
          this.progressLabel.textContent = 'LOADING EMBEDDINGS…';
        } else if (phase === 'ingest' && status === 'progress' && total > 0) {
          const pct = Math.round((current / total) * 100);
          this.progressLabel.textContent = `Inserting: ${current}/${total} (${detail?.rate ?? 0}/sec)`;
          this.progressFill.style.width = `${pct}%`;
        } else if (status === 'complete') {
          this.progressLabel.textContent = 'UPDATE COMPLETE';
          this.progressFill.style.width = '100%';
        }
      };

      store.on('progress', this._boundProgressHandler);

      // 3. Ingest
      const stats = await this.contextManager.ingestToStore();

      btn.textContent = '✓ UPDATE DATABASE';
      atom.notifications.addSuccess(`Database updated: ${stats.inserted} chunks inserted`);
    } catch (error) {
      console.error('Update DB error:', error);
      this.progressLabel.textContent = 'ERROR';
      btn.textContent = 'UPDATE DATABASE';
      atom.notifications.addError('Failed to update database', { detail: error.message });
    } finally {
      this._detachListeners();
      btn.disabled = false;
      setTimeout(() => {
        this.progressEl.style.display = 'none';
      }, 2000);
    }
  }

  // ── Step: Query ────────────────────────────────────────────

  _renderQuery() {
    const section = this._el('div', 'agentic-ai__step-content');

    section.appendChild(this._heading('Query & Select Context'));
    section.appendChild(this._subtitle(
      'Your question is embedded with the same model used for indexing, then matched against the vector DB.'
    ));

    section.appendChild(this._lockedBadges([
      { label: 'embed', value: this._providerModelLabel('embed'), color: 'embed' },
      { label: 'db',    value: this.selections.vectorDb, color: 'db' },
    ]));

    const inputWrap = this._el('div', 'agentic-ai__input-wrap');
    const textarea = this._el('textarea', 'agentic-ai__textarea');
    textarea.placeholder = 'Ask about your codebase…';
    textarea.rows = 3;
    textarea.value = this._lastQuery;
    inputWrap.appendChild(textarea);

    const searchBtn = this._el('button', 'agentic-ai__search-btn');
    searchBtn.textContent = 'SEARCH';
    searchBtn.addEventListener('click', () => {
      const query = textarea.value.trim();
      if (query) {
        this._lastQuery = query;
        this._handleSearch(query, searchBtn);
      }
    });

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const query = textarea.value.trim();
        if (query) {
          this._lastQuery = query;
          this._handleSearch(query, searchBtn);
        }
      }
    });

    inputWrap.appendChild(searchBtn);
    section.appendChild(inputWrap);

    this.resultsEl = this._el('div', 'agentic-ai__results');
    section.appendChild(this.resultsEl);

    if (this._searchResults.length > 0) {
      this._renderResultsList();
    }

    this.contentEl.appendChild(section);
  }

  /**
   * Execute a search via ContextManager → VectorStore.search().
   *
   * Maps the new SearchResult shape:
   *   result.code      → document text
   *   result.relevance → 0–1 fused score (replaces 1 - distance)
   *   result.file      → source file
   *   result.type      → chunk type
   *   result.sources   → Set<string> of match strategies
   */
  async _handleSearch(query, searchBtn) {
    if (this._isSearching) return;
    this._isSearching = true;
    searchBtn.textContent = 'SEARCHING…';
    searchBtn.disabled = true;
    this.resultsEl.innerHTML = '';

    const searchingLabel = this._el('div', 'agentic-ai__results-count');
    searchingLabel.textContent = 'SEARCHING…';
    this.resultsEl.appendChild(searchingLabel);

    try {
      const activeEditor = atom.workspace.getActiveTextEditor();
      const currentFile = activeEditor?.getPath?.() ?? null;

      // Search via ContextManager → VectorStore.search()
      const searchResult = await this.contextManager.getContext(query, { currentFile });

      console.log('Search complete:', {
        results: searchResult.results.length,
        stats: searchResult.searchStats,
      });

      // Map new SearchResult.results[] shape to our internal format
      this._searchResults = searchResult.results.map((result, i) => ({
        index: i,
        document: result.code,           // was: searchResult.documents[i]
        metadata: result.metadata,        // was: searchResult.metadatas[i]
        file: result.file,                // was: metadata?.filePath ?? metadata?.source_file
        type: result.type ?? 'code',      // was: metadata?.type ?? metadata?.chunk_type
        lineStart: result.lineStart,      // was: metadata?.lineStart
        lineEnd: result.lineEnd,          // was: metadata?.lineEnd
        similarity: result.relevance,     // was: 1 - distance
        sources: result.sources,          // NEW: Set<'exact'|'semantic'|'keyword'>
      }));

      // Auto-select results above threshold
      this.selectedResults = new Set();
      this._searchResults.forEach((r, i) => {
        if (r.similarity >= 0.5) {
          this.selectedResults.add(i);
        }
      });
      if (this.selectedResults.size === 0 && this._searchResults.length > 0) {
        const autoSelectCount = Math.min(3, this._searchResults.length);
        for (let i = 0; i < autoSelectCount; i++) {
          this.selectedResults.add(i);
        }
      }

      this._renderResultsList();

    } catch (error) {
      console.error('Search error:', error);
      this.resultsEl.innerHTML = '';
      const errorLabel = this._el('div', 'agentic-ai__results-count agentic-ai__error-text');
      errorLabel.textContent = `SEARCH FAILED: ${error.message}`;
      this.resultsEl.appendChild(errorLabel);
      atom.notifications.addError('Search failed', { detail: error.message });
    } finally {
      this._isSearching = false;
      searchBtn.textContent = 'SEARCH';
      searchBtn.disabled = false;
    }
  }

  _renderResultsList() {
    this.resultsEl.innerHTML = '';

    if (this._searchResults.length === 0) {
      const noResults = this._el('div', 'agentic-ai__results-count');
      noResults.textContent = 'NO MATCHING CHUNKS FOUND';
      this.resultsEl.appendChild(noResults);
      return;
    }

    const countLabel = this._el('div', 'agentic-ai__results-count');
    const updateCount = () => {
      countLabel.textContent =
        `${this.selectedResults.size} OF ${this._searchResults.length} CHUNKS SELECTED AS CONTEXT`;
    };
    updateCount();
    this.resultsEl.appendChild(countLabel);

    for (const result of this._searchResults) {
      const i = result.index;

      const item = this._el('button',
        'agentic-ai__result' + (this.selectedResults.has(i) ? ' is-selected' : '')
      );

      item.addEventListener('click', () => {
        if (this.selectedResults.has(i)) this.selectedResults.delete(i);
        else this.selectedResults.add(i);
        item.classList.toggle('is-selected');
        checkbox.textContent = this.selectedResults.has(i) ? '☑' : '☐';
        updateCount();
      });

      const header = this._el('div', 'agentic-ai__result-header');
      const checkbox = this._el('span', 'agentic-ai__result-check');
      checkbox.textContent = this.selectedResults.has(i) ? '☑' : '☐';

      const fileName = this._el('span', 'agentic-ai__result-file');
      let fileLabel = result.file;
      if (result.lineStart && result.lineEnd) {
        fileLabel += `:${result.lineStart}-${result.lineEnd}`;
      }
      fileName.textContent = fileLabel;

      const similarity = result.similarity;
      const scoreClass = similarity > 0.85 ? 'high' : similarity > 0.7 ? 'mid' : 'low';
      const score = this._el('span', `agentic-ai__result-score agentic-ai__result-score--${scoreClass}`);
      score.textContent = `${(similarity * 100).toFixed(0)}% match`;

      header.append(checkbox, fileName, score);
      item.appendChild(header);

      const chunkPreview = this._el('div', 'agentic-ai__result-chunk');
      const typeTag = result.type !== 'code' ? `[${result.type}] ` : '';
      const previewText = result.document.length > 200
        ? result.document.substring(0, 200) + '…'
        : result.document;
      chunkPreview.textContent = typeTag + previewText;
      item.appendChild(chunkPreview);

      this.resultsEl.appendChild(item);
    }
  }

  getSelectedContext() {
    return this._searchResults.filter((_, i) => this.selectedResults.has(i));
  }

  buildContextString() {
    const selected = this.getSelectedContext();
    if (selected.length === 0) return '';

    let context = '--- Relevant Code Context ---\n';
    const byFile = new Map();
    for (const result of selected) {
      const file = result.file;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(result);
    }

    for (const [filePath, items] of byFile.entries()) {
      context += `\n📂 ${filePath}\n`;
      items.forEach((item, index) => {
        if (item.type && item.type !== 'code') {
          context += `[${item.type}] `;
        }
        if (item.lineStart && item.lineEnd) {
          context += `(lines ${item.lineStart}-${item.lineEnd}) `;
        }
        context += `${item.document}\n`;
        if (index < items.length - 1) context += '\n';
      });
    }

    return context;
  }

  // ── Step: Respond ──────────────────────────────────────────

  _renderRespond() {
    const section = this._el('div', 'agentic-ai__step-content');

    section.appendChild(this._heading('Generate Response'));
    section.appendChild(this._subtitle(
      'Your selected context chunks + question are sent to the LLM for a grounded response.'
    ));

    section.appendChild(this._lockedBadges([
      { label: 'llm',   value: this._providerModelLabel('llm'),   color: 'llm' },
      { label: 'embed', value: this._providerModelLabel('embed'), color: 'embed' },
      { label: 'db',    value: this.selections.vectorDb,           color: 'db' },
    ]));

    const selectedContext = this.getSelectedContext();
    if (selectedContext.length > 0) {
      const contextCard = this._el('div', 'agentic-ai__card');
      const contextTitle = this._el('div', 'agentic-ai__card-title agentic-ai__card-title--chunker');
      contextTitle.textContent = 'SELECTED CONTEXT';
      contextCard.appendChild(contextTitle);

      const contextSub = this._el('div', 'agentic-ai__card-subtitle');
      const uniqueFiles = new Set(selectedContext.map(r => r.file));
      contextSub.textContent = `${selectedContext.length} chunks from ${uniqueFiles.size} files`;
      contextCard.appendChild(contextSub);

      const fileList = this._el('div', 'agentic-ai__detail-list');
      for (const file of uniqueFiles) {
        const row = this._el('div', 'agentic-ai__detail-row');
        const lbl = this._el('span', 'agentic-ai__detail-value agentic-ai__detail-value--compact');
        lbl.textContent = file;
        row.appendChild(lbl);
        fileList.appendChild(row);
      }
      contextCard.appendChild(fileList);
      section.appendChild(contextCard);
    }

    const promptCard = this._el('div', 'agentic-ai__card');
    const promptTitle = this._el('div', 'agentic-ai__card-title agentic-ai__card-title--embed');
    promptTitle.textContent = 'FULL PROMPT';
    promptCard.appendChild(promptTitle);

    const promptToggle = this._el('button', 'agentic-ai__refresh-btn');
    promptToggle.textContent = '▸ Show / Edit';
    promptCard.appendChild(promptToggle);

    const promptTextarea = this._el('textarea', 'agentic-ai__textarea');
    promptTextarea.rows = 10;
    promptTextarea.style.display = 'none';
    promptTextarea.value = this._buildFullPrompt();
    promptCard.appendChild(promptTextarea);

    promptToggle.addEventListener('click', () => {
      const hidden = promptTextarea.style.display === 'none';
      promptTextarea.style.display = hidden ? '' : 'none';
      promptToggle.textContent = hidden ? '▾ Hide' : '▸ Show / Edit';
    });

    section.appendChild(promptCard);

    const hasContext = selectedContext.length > 0;
    const canGenerate = !!this.selections.llmModel && !!this._lastQuery;
    const genBtn = this._el('button',
      'agentic-ai__action-btn agentic-ai__action-btn--respond' +
      (!canGenerate ? ' is-disabled' : '')
    );
    genBtn.textContent = 'GENERATE RESPONSE';
    genBtn.disabled = !canGenerate;
    genBtn.addEventListener('click', () =>
      this._handleGenerate(genBtn, responseEl, promptTextarea.value)
    );
    section.appendChild(genBtn);

    if (!hasContext && this._lastQuery) {
      const warnEl = this._el('div', 'agentic-ai__card-subtitle agentic-ai__warn-text');
      warnEl.textContent = '⚠ No context selected — the LLM will respond without code context.';
      section.appendChild(warnEl);
    }
    if (!this._lastQuery) {
      const warnEl = this._el('div', 'agentic-ai__card-subtitle agentic-ai__warn-text');
      warnEl.textContent = '⚠ No query entered — go back to the Query step first.';
      section.appendChild(warnEl);
    }

    const responseEl = this._el('div', 'agentic-ai__response');
    section.appendChild(responseEl);

    this.contentEl.appendChild(section);
  }

  _buildFullPrompt() {
    const context = this.buildContextString();
    const query = this._lastQuery || '';

    if (!context && !query) return '';

    let prompt = '';
    if (context) {
      prompt += context + '\n\n';
    }
    if (query) {
      prompt += `--- Question ---\n${query}\n`;
    }
    return prompt;
  }

  async _handleGenerate(btn, responseEl, fullPrompt) {
    if (!fullPrompt || !fullPrompt.trim()) {
      atom.notifications.addWarning('Nothing to send — enter a query first.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'GENERATING…';
    responseEl.innerHTML = '';

    const cursor = this._el('span', 'agentic-ai__cursor');
    const waitingLabel = this._el('span', 'agentic-ai__waiting-label');
    waitingLabel.textContent = 'Waiting for LLM response…';
    responseEl.append(waitingLabel, cursor);

    try {
      const OllamaClient = require('../clients/ollama-client');
      const client = new OllamaClient();

      if (this.selections.llmModel) {
        client.setModel(this.selections.llmModel);
      }

      const response = await client.sendPrompt(fullPrompt);

      responseEl.innerHTML = '';

      const CHUNK_SIZE = 4;
      const DELAY_MS = 8;
      const textNode = document.createTextNode('');
      responseEl.appendChild(textNode);
      responseEl.appendChild(cursor);

      for (let i = 0; i < response.length; i += CHUNK_SIZE) {
        await new Promise(r => setTimeout(r, DELAY_MS));
        textNode.data = response.slice(0, i + CHUNK_SIZE);
      }

      cursor.remove();
      responseEl.textContent = response;
      this._lastResponse = response;

      atom.notifications.addSuccess('Response generated', {
        detail: `${response.length} chars from ${this.selections.llmModel}`
      });

    } catch (error) {
      console.error('LLM generation error:', error);
      responseEl.innerHTML = '';
      cursor.remove();

      const errorText = this._el('div', 'agentic-ai__error-text');
      errorText.textContent = `Error: ${error.message}`;
      responseEl.appendChild(errorText);

      if (error.message.includes('not running') || error.message.includes('ECONNREFUSED')) {
        atom.notifications.addError('Ollama not reachable', {
          detail: 'Make sure Ollama is running. Start it with: ollama serve',
          dismissable: true
        });
      } else if (error.message.includes('model')) {
        atom.notifications.addError('Model issue', {
          detail: `Model "${this.selections.llmModel}" may not be installed. Run: ollama pull ${this.selections.llmModel}`,
          dismissable: true
        });
      } else {
        atom.notifications.addError('Generation failed', {
          detail: error.message,
          dismissable: true
        });
      }
    } finally {
      btn.textContent = 'GENERATE RESPONSE';
      btn.disabled = false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ── Reusable UI Components
  // ═══════════════════════════════════════════════════════════

  _heading(text) {
    const h = this._el('h2', 'agentic-ai__heading');
    h.textContent = text;
    return h;
  }

  _subtitle(text) {
    const p = this._el('p', 'agentic-ai__subtitle');
    p.textContent = text;
    return p;
  }

  _providerModelPicker({ title, subtitle, colorClass, modelType, selectedProvider, selectedModel, onSelectProvider, onSelectModel }) {
    const card = this._el('div', 'agentic-ai__card');

    const cardTitle = this._el('div', `agentic-ai__card-title agentic-ai__card-title--${colorClass}`);
    cardTitle.textContent = title.toUpperCase();
    card.appendChild(cardTitle);

    if (subtitle) {
      const sub = this._el('div', 'agentic-ai__card-subtitle');
      sub.textContent = subtitle;
      card.appendChild(sub);
    }

    const enabledProviders = ConfigManager.listEnabledProviders();
    const providerRow = this._el('div', 'agentic-ai__provider-tabs');

    for (const pid of enabledProviders) {
      const def = ConfigManager.getProviderDef(pid);
      const hasModels = ConfigManager.listModels(pid, modelType).length > 0;
      if (!hasModels) continue;

      const tab = this._el('button',
        `agentic-ai__provider-tab agentic-ai__provider-tab--${colorClass}` +
        (selectedProvider === pid ? ' is-active' : '')
      );
      tab.textContent = def?.label ?? pid;
      tab.addEventListener('click', () => onSelectProvider(pid));
      providerRow.appendChild(tab);
    }
    card.appendChild(providerRow);

    if (selectedProvider) {
      const knownModels = ConfigManager.listModels(selectedProvider, modelType);
      if (knownModels.length) {
        card.appendChild(this._chipGroup(
          'REGISTERED MODELS',
          knownModels.map(m => m.name),
          selectedModel,
          colorClass,
          onSelectModel
        ));
      }

      if (selectedProvider === 'ollama') {
        const liveModels = this._getOllamaLiveModels(modelType);
        if (liveModels.length) {
          card.appendChild(this._chipGroup(
            'OLLAMA (LIVE)',
            liveModels,
            selectedModel,
            colorClass,
            onSelectModel
          ));
        }

        const refreshBtn = this._el('button', 'agentic-ai__refresh-btn');
        refreshBtn.textContent = '↻ Fetch from Ollama';
        refreshBtn.addEventListener('click', () => this._fetchOllamaModels());
        card.appendChild(refreshBtn);
      }

      if (selectedModel) {
        const modelConfig = ConfigManager.getModelConfig(selectedProvider, selectedModel);
        if (modelConfig) {
          const infoItems = [];
          if (modelConfig.dimensions)    infoItems.push({ label: 'Dims',    value: modelConfig.dimensions });
          if (modelConfig.maxTokens)     infoItems.push({ label: 'Tokens',  value: modelConfig.maxTokens });
          if (modelConfig.contextWindow) infoItems.push({ label: 'Context', value: modelConfig.contextWindow });
          if (modelConfig.temperature != null)  infoItems.push({ label: 'Temp',    value: modelConfig.temperature });

          if (infoItems.length) {
            const info = this._el('div', 'agentic-ai__model-info');
            for (const { label, value } of infoItems) {
              const tag = this._el('span', 'agentic-ai__model-info-tag');
              tag.textContent = `${label}: ${value}`;
              info.appendChild(tag);
            }
            card.appendChild(info);
          }
        }
      }
    }

    return card;
  }

  _getOllamaLiveModels(modelType) {
    if (!this._ollamaLiveModels) return [];
    const { known, unknown } = this._ollamaLiveModels;

    const typed = known
      .filter(m => m.type === modelType)
      .map(m => m.name);

    const extras = unknown ?? [];

    const staticNames = new Set(
      ConfigManager.listModels('ollama', modelType).map(m => m.name)
    );
    return [...typed, ...extras].filter(n => !staticNames.has(n));
  }

  async _fetchOllamaModels() {
    const conn = ConfigManager.getProviderConnection('ollama');
    const baseUrl = conn.baseUrl ?? 'http://127.0.0.1:11434';
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const names = (data.models ?? []).map(m => m.name);
      this._ollamaLiveModels = ConfigManager.classifyOllamaModels(names);
      atom.notifications.addSuccess(`Found ${names.length} Ollama models`);
      this._render();
    } catch (error) {
      atom.notifications.addError('Failed to fetch Ollama models', {
        detail: error.message,
      });
    }
  }

  _chipGroup(label, options, selected, colorClass, onSelect) {
    const group = this._el('div', 'agentic-ai__chip-group');
    const groupLabel = this._el('span', 'agentic-ai__chip-group-label');
    groupLabel.textContent = label;
    group.appendChild(groupLabel);

    const chips = this._el('div', 'agentic-ai__chips');
    for (const opt of options) {
      const chip = this._el('button',
        `agentic-ai__chip agentic-ai__chip--${colorClass}` +
        (selected === opt ? ' is-selected' : '')
      );
      chip.textContent = opt;
      chip.addEventListener('click', () => onSelect(opt));
      chips.appendChild(chip);
    }
    group.appendChild(chips);
    return group;
  }

  _chipPicker({ title, colorClass, options, selected, onSelect }) {
    const card = this._el('div', 'agentic-ai__card agentic-ai__card--half');
    const cardTitle = this._el('div', `agentic-ai__card-title agentic-ai__card-title--${colorClass}`);
    cardTitle.textContent = title.toUpperCase();
    card.appendChild(cardTitle);

    const chips = this._el('div', 'agentic-ai__chips');
    for (const opt of options) {
      const chip = this._el('button',
        `agentic-ai__chip agentic-ai__chip--${colorClass}` +
        (selected === opt ? ' is-selected' : '')
      );
      chip.textContent = opt;
      chip.addEventListener('click', () => onSelect(opt));
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    return card;
  }

  _configDetail({ title, colorClass, items }) {
    const card = this._el('div', 'agentic-ai__card agentic-ai__card--half');
    const cardTitle = this._el('div', `agentic-ai__card-title agentic-ai__card-title--${colorClass}`);
    cardTitle.textContent = title.toUpperCase();
    card.appendChild(cardTitle);

    const list = this._el('div', 'agentic-ai__detail-list');
    for (const { label, value } of items) {
      const row = this._el('div', 'agentic-ai__detail-row');
      const lbl = this._el('span', 'agentic-ai__detail-label');
      lbl.textContent = label;
      row.appendChild(lbl);
      const val = this._el('span', 'agentic-ai__detail-value');
      val.textContent = String(value);
      row.appendChild(val);
      list.appendChild(row);
    }
    card.appendChild(list);

    const editHint = this._el('div', 'agentic-ai__detail-hint');
    editHint.textContent = 'Edit in Settings → Packages → agentic-ai';
    card.appendChild(editHint);

    return card;
  }

  _lockedBadges(items) {
    const wrap = this._el('div', 'agentic-ai__badges');
    for (const { label, value, color } of items) {
      if (!value) continue;
      const badge = this._el('span', `agentic-ai__badge agentic-ai__badge--${color}`);
      badge.innerHTML = `<span class="agentic-ai__badge-label">${label}</span>` +
                        `<span class="agentic-ai__badge-value">${value}</span>` +
                        `<span class="agentic-ai__badge-lock">🔒</span>`;
      wrap.appendChild(badge);
    }
    return wrap;
  }

  _providerModelLabel(type) {
    const provider = this.selections[`${type}Provider`];
    const model    = this.selections[`${type}Model`];
    if (!model) return null;
    return `${provider}:${model}`;
  }

  // ── Utilities ──────────────────────────────────────────────

  advanceToStep(stepId) {
    this.currentStep = stepId;
    this._render();
  }

  _navigate(direction) {
    const idx = AgenticAiView.STEPS.findIndex(s => s.id === this.currentStep);
    const next = idx + direction;
    if (next >= 0 && next < AgenticAiView.STEPS.length) {
      this.currentStep = AgenticAiView.STEPS[next].id;
      this._render();
    }
  }

  _el(tag, className = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }
}

module.exports = { AgenticAiView, VIEW_URI };
