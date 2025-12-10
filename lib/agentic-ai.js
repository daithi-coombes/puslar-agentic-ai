'use strict';

const { CompositeDisposable }     = require('atom');
const { AgenticAiView, VIEW_URI } = require('./views/agentic-ai-view');
const ContextManager              = require('./context-manager');
const ConfigManager               = require('../config');

module.exports = {
  agenticAIPanel: null,
  contextManager: null,
  subscriptions: null,
  statusBarTile: null,

  activate(state) {
    this.subscriptions = new CompositeDisposable();

    this.contextManager = new ContextManager();

    this.subscriptions.add(
      atom.workspace.addOpener(uri => {
        /* istanbul ignore next */
        if (uri === VIEW_URI) {
          return this.createPanelView(state?.viewState);
        }
      })
    );

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'agentic-ai:toggle':       () => this.toggle(),
        'agentic-ai:reset-config': () => this.resetConfig(),
        'agentic-ai:show-config':  () => this.showConfig(),
      })
    );

    if (state?.panelWasVisible) {
      this.toggle();
    }
  },

  async deactivate() {
    this.subscriptions?.dispose();
    this.statusBarTile?.destroy();

    const pane = atom.workspace.paneForURI(VIEW_URI);
    if (pane) {
      const item = pane.itemForURI(VIEW_URI);
      /* istanbul ignore next */
      if (item) pane.destroyItem(item);
    }

    // Async: disposes Indexer + VectorStore (removes listeners, frees model)
    await this.contextManager?.destroy();
    this.agenticAIPanel = null;
  },

  serialize() {
    const pane = atom.workspace.paneForURI(VIEW_URI);
    const item = pane ? pane.itemForURI(VIEW_URI) : null;

    return {
      panelWasVisible: item !== null,
      viewState: item?.serialize?.() ?? null,
    };
  },

  deserializeAgenticAiView(state) {
    return this.createPanelView(state);
  },

  createPanelView(state) {
    if (!this.agenticAIPanel) {
      this.agenticAIPanel = new AgenticAiView(state, this.contextManager);
    }
    return this.agenticAIPanel;
  },

  async toggle() {
    const pane = atom.workspace.paneForURI(VIEW_URI);

    if (pane) {
      const item = pane.itemForURI(VIEW_URI);
      /* istanbul ignore next */
      if (item) {
        pane.destroyItem(item);
        this.agenticAIPanel = null;
        return;
      }
    }

    await atom.workspace.open(VIEW_URI, {
      location: 'right',
      activatePane: true,
      activateItem: true,
      searchAllPanes: false,
    });
  },

  // ── Config Commands ────────────────────────────────────────

  resetConfig() {
    const confirmed = atom.confirm({
      message: 'Reset Agentic AI Configuration?',
      detail: 'This will reset all settings to their defaults.',
      buttons: ['Reset', 'Cancel'],
    });
    if (confirmed === 0) {
      ConfigManager.resetAll();
      atom.notifications.addSuccess('Agentic AI config reset to defaults.');
      if (this.agenticAIPanel) this.agenticAIPanel._render();
    }
  },

  showConfig() {
    const snapshot = ConfigManager.snapshot();
    atom.workspace.open().then(editor => {
      editor.setText(JSON.stringify(snapshot, null, 2));
      const jsonGrammar = atom.grammars.grammarForScopeName('source.json');
      /* istanbul ignore next */
      if (jsonGrammar) editor.setGrammar(jsonGrammar);
    });
  },

  // ── Status Bar ─────────────────────────────────────────────

  consumeStatusBar(statusBar) {
    this.statusBarTile = statusBar.addLeftTile({
      item: this.createStatusBarView(),
      priority: 100,
    });
  },

  createStatusBarView() {
    const element = document.createElement('div');
    element.className = 'agentic-ai-status inline-block';
    element.textContent = 'AI';
    element.style.cursor = 'pointer';
    element.addEventListener('click', () => this.toggle());
    return element;
  },

  ConfigManager,
};
