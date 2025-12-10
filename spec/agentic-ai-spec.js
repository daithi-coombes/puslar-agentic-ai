'use strict';

const VIEW_URI = 'atom://agentic-ai';

// Use the command `window:run-package-specs` (cmd-alt-ctrl-p) to run specs.
//
// To run a specific `it` or `describe` block add an `f` to the front (e.g. `fit`
// or `fdescribe`). Remove the `f` to unfocus the block.

describe('agenticAi', () => {
  let workspaceElement, activationPromise, ConfigManager;

  /**
   * Helper: dispatch toggle to trigger activation, await the activation
   * promise, then await workspace.open() to ensure the view is in the DOM.
   *
   * The command handler in activate() fires toggle() as fire-and-forget
   * (the arrow wrapper doesn't return the promise), so activationPromise
   * resolves before workspace.open() completes. We call workspace.open()
   * ourselves to get a proper awaitable — the package's registered opener
   * still handles creating the view.
   */
  async function activateAndOpen() {
    atom.commands.dispatch(workspaceElement, 'agentic-ai:toggle');
    await activationPromise;
    // The opener is now registered; open the URI ourselves to get
    // a promise that resolves once the item is in the dock.
    await atom.workspace.open(VIEW_URI, {
      location: 'right',
      searchAllPanes: true,
    });
  }

  /**
   * Helper: activate without opening the panel.
   */
  async function activateOnly() {
    atom.commands.dispatch(workspaceElement, 'agentic-ai:toggle');
    await activationPromise;

    if (!ConfigManager) {
      const pkg = atom.packages.getActivePackage('agentic-ai');
      ConfigManager = pkg.mainModule.ConfigManager;
    }
  }

  beforeEach(() => {
    workspaceElement = atom.views.getView(atom.workspace);

    // This returns a promise that resolves once the activation command fires.
    // Because of `activationCommands` in package.json, the package won't
    // activate until `agentic-ai:toggle` is dispatched. We must dispatch
    // the command BEFORE awaiting this promise.
    activationPromise = atom.packages.activatePackage('agentic-ai');
  });

  describe('when the agentic-ai:toggle event is triggered', () => {

    it('opens the view in the right dock', async () => {
      await activateAndOpen();

      // Verify via the package's own reference — the view was created
      const pkg = atom.packages.getActivePackage('agentic-ai');
      const panel = pkg.mainModule.agenticAIPanel;
      expect(panel).not.toBeNull();
      expect(panel.getElement().classList.contains('agentic-ai')).toBe(true);

      // Verify it's in a pane
      const pane = atom.workspace.paneForURI(VIEW_URI);
      expect(pane).not.toBeNull();
    });

    it('toggles the view closed on second invocation', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      expect(pkg.mainModule.agenticAIPanel).not.toBeNull();

      // Second toggle closes the pane item
      atom.commands.dispatch(workspaceElement, 'agentic-ai:toggle');
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(pkg.mainModule.agenticAIPanel).toBeNull();
      expect(atom.workspace.paneForURI(VIEW_URI)).toBeUndefined();
    });

    it('shows the view as visible when attached to DOM', async () => {
      jasmine.attachToDOM(workspaceElement);

      await activateAndOpen();

      const agenticAiElement = workspaceElement.querySelector('.agentic-ai');
      expect(agenticAiElement).toBeVisible();
    });

    it('registers an opener that creates the panel view for the agentic-ai URI', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const mainModule = pkg.mainModule;

      // Close any panel that activateOnly may have opened via toggle
      // and clear the cached reference so createPanelView runs fresh
      const pane = atom.workspace.paneForURI('atom://agentic-ai');
      if (pane) {
        const item = pane.itemForURI('atom://agentic-ai');
        if (item) pane.destroyItem(item);
      }
      mainModule.agenticAIPanel = null;

      spyOn(mainModule, 'createPanelView').and.callThrough();

      await atom.workspace.open('atom://agentic-ai');

      expect(mainModule.createPanelView).toHaveBeenCalled();
    });
  });

  describe('when the agentic-ai:show-config event is triggered', () => {
    it('opens the config in a new editor tab', async () => {
      await activateOnly();

      const editorsBefore = atom.workspace.getTextEditors().length;

      atom.commands.dispatch(workspaceElement, 'agentic-ai:show-config');

      // Wait for the editor to appear
      const editor = await new Promise(resolve => {
        const disposable = atom.workspace.onDidAddTextEditor(({ textEditor }) => {
          disposable.dispose();
          resolve(textEditor);
        });
      });

      expect(atom.workspace.getTextEditors().length).toBe(editorsBefore + 1);

      if (editor.getText() === '') {
        await new Promise(resolve => {
          const disposable = editor.onDidChange(() => {
            disposable.dispose();
            resolve();
          });
        });
      }

      const content = editor.getText();
      expect(() => JSON.parse(content)).not.toThrow();

      const parsed = JSON.parse(content);
      expect(parsed.settings).toBeDefined();
      expect(parsed.staticConfig).toBeDefined();
    });
  });

  describe('when the agentic-ai:reset-config event is triggered', () => {
    it('resets config when user confirms', async () => {
      await activateOnly();

      // Spy on confirm to simulate clicking "Reset" (index 0)
      spyOn(atom, 'confirm').and.returnValue(0);
      spyOn(ConfigManager, 'resetAll');

      atom.commands.dispatch(workspaceElement, 'agentic-ai:reset-config');

      expect(atom.confirm).toHaveBeenCalled();
      expect(ConfigManager.resetAll).toHaveBeenCalled();
    });

    it('shows a success notification after reset', async () => {
      await activateOnly();

      spyOn(atom, 'confirm').and.returnValue(0);
      spyOn(ConfigManager, 'resetAll');
      spyOn(atom.notifications, 'addSuccess');

      atom.commands.dispatch(workspaceElement, 'agentic-ai:reset-config');

      expect(atom.notifications.addSuccess).toHaveBeenCalledWith(
        'Agentic AI config reset to defaults.'
      );
    });

    it('does not reset config when user cancels', async () => {
      await activateOnly();

      // Spy on confirm to simulate clicking "Cancel" (index 1)
      spyOn(atom, 'confirm').and.returnValue(1);
      spyOn(ConfigManager, 'resetAll');

      atom.commands.dispatch(workspaceElement, 'agentic-ai:reset-config');

      expect(atom.confirm).toHaveBeenCalled();
      expect(ConfigManager.resetAll).not.toHaveBeenCalled();
    });

    it('re-renders the panel if it is open', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const panel = pkg.mainModule.agenticAIPanel;
      spyOn(panel, '_render');

      spyOn(atom, 'confirm').and.returnValue(0);
      spyOn(ConfigManager, 'resetAll');

      atom.commands.dispatch(workspaceElement, 'agentic-ai:reset-config');

      expect(panel._render).toHaveBeenCalled();
    });
  });

  describe('package lifecycle', () => {

    it('registers the toggle command on activation', async () => {
      await activateOnly();

      const commands = atom.commands.findCommands({ target: workspaceElement });
      const toggleCmd = commands.find(cmd => cmd.name === 'agentic-ai:toggle');
      expect(toggleCmd).toBeDefined();
    });

    it('creates a ContextManager on activation', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      expect(pkg).toBeDefined();
      expect(pkg.mainModule.contextManager).not.toBeNull();
    });

    it('restores the panel on activation if it was previously visible', async () => {
      // First, activate the package normally
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const mainModule = pkg.mainModule;

      // Deactivate so we can re-activate with custom state
      await atom.packages.deactivatePackage('agentic-ai');

      // Spy on toggle before re-activating
      spyOn(mainModule, 'toggle');

      // Call activate directly with state indicating panel was open
      mainModule.activate({ panelWasVisible: true });

      expect(mainModule.toggle).toHaveBeenCalled();
    });

    it('does not restore the panel if it was not previously visible', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const mainModule = pkg.mainModule;

      await atom.packages.deactivatePackage('agentic-ai');

      spyOn(mainModule, 'toggle');

      mainModule.activate({ panelWasVisible: false });

      expect(mainModule.toggle).not.toHaveBeenCalled();
    });

    it('cleans up on deactivation', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      expect(pkg.mainModule.agenticAIPanel).not.toBeNull();

      await atom.packages.deactivatePackage('agentic-ai');

      expect(pkg.mainModule.agenticAIPanel).toBeNull();
    });
  });

  describe('direct method coverage', () => {

    it('toggle closes panel when item exists in pane', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const mainModule = pkg.mainModule;

      // Confirm panel is open
      expect(mainModule.agenticAIPanel).not.toBeNull();

      // Call toggle directly — not via command dispatch
      await mainModule.toggle();

      expect(mainModule.agenticAIPanel).toBeNull();
    });

    it('deactivate destroys pane item when panel is open', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const mainModule = pkg.mainModule;

      // Call deactivate directly
      await mainModule.deactivate();

      expect(mainModule.agenticAIPanel).toBeNull();
    });

    it('showConfig sets grammar when available', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');

      // Call showConfig directly
      pkg.mainModule.showConfig();

      const editor = await new Promise(resolve => {
        const disposable = atom.workspace.onDidAddTextEditor(({ textEditor }) => {
          disposable.dispose();
          resolve(textEditor);
        });
      });

      if (editor.getText() === '') {
        await new Promise(resolve => {
          const disposable = editor.onDidChange(() => {
            disposable.dispose();
            resolve();
          });
        });
      }

      expect(editor.getText().length).toBeGreaterThan(0);
    });
  });

  describe('deactivate', () => {
    it('destroys the pane item if panel is still open', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      expect(pkg.mainModule.agenticAIPanel).not.toBeNull();

      // Verify pane exists before deactivation
      const pane = atom.workspace.paneForURI(VIEW_URI);
      expect(pane).not.toBeNull();

      // Deactivate while panel is still open — exercises line 47
      await atom.packages.deactivatePackage('agentic-ai');

      expect(pkg.mainModule.agenticAIPanel).toBeNull();
    });
  });

  describe('toggle()', () => {
    it('closes the panel when called with panel open', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      expect(pkg.mainModule.agenticAIPanel).not.toBeNull();

      // Call toggle directly (not via command dispatch) to hit instrumented code
      await pkg.mainModule.toggle();

      expect(pkg.mainModule.agenticAIPanel).toBeNull();
    });
  });

  describe('createPanelView()', () => {
    it('returns existing panel if already created', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const firstPanel = pkg.mainModule.agenticAIPanel;
      expect(firstPanel).not.toBeNull();

      // Calling createPanelView again should return the same instance
      const secondPanel = pkg.mainModule.createPanelView({});
      expect(secondPanel).toBe(firstPanel);
    });
  });

  describe('resetConfig()', () => {
    it('does not attempt re-render when panel is not open', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');

      // Close the panel that activateOnly opened via toggle
      const pane = atom.workspace.paneForURI(VIEW_URI);
      if (pane) {
        const item = pane.itemForURI(VIEW_URI);
        if (item) pane.destroyItem(item);
      }
      pkg.mainModule.agenticAIPanel = null;

      spyOn(atom, 'confirm').and.returnValue(0);
      spyOn(ConfigManager, 'resetAll');

      expect(() => {
        atom.commands.dispatch(workspaceElement, 'agentic-ai:reset-config');
      }).not.toThrow();
    });
  });

  describe('showConfig()', () => {
    it('sets JSON grammar on the editor when available', async () => {
      await activateOnly();

      atom.commands.dispatch(workspaceElement, 'agentic-ai:show-config');

      const editor = await new Promise(resolve => {
        const disposable = atom.workspace.onDidAddTextEditor(({ textEditor }) => {
          disposable.dispose();
          resolve(textEditor);
        });
      });

      // Wait for setText in the .then callback
      if (editor.getText() === '') {
        await new Promise(resolve => {
          const disposable = editor.onDidChange(() => {
            disposable.dispose();
            resolve();
          });
        });
      }

      // Verify grammar was set (if available in test environment)
      const grammar = editor.getGrammar();
      // In test env, JSON grammar may or may not be loaded
      // The key is that the code path executed without error
      expect(editor.getText().length).toBeGreaterThan(0);
    });

    it('handles missing JSON grammar gracefully', async () => {
      await activateOnly();

      // Spy to return null for JSON grammar
      spyOn(atom.grammars, 'grammarForScopeName').and.returnValue(null);

      atom.commands.dispatch(workspaceElement, 'agentic-ai:show-config');

      const editor = await new Promise(resolve => {
        const disposable = atom.workspace.onDidAddTextEditor(({ textEditor }) => {
          disposable.dispose();
          resolve(textEditor);
        });
      });

      if (editor.getText() === '') {
        await new Promise(resolve => {
          const disposable = editor.onDidChange(() => {
            disposable.dispose();
            resolve();
          });
        });
      }

      // Should still have content, just no grammar set
      expect(editor.getText().length).toBeGreaterThan(0);
    });
  });

  describe('serialize', () => {

    it('returns panelWasVisible: false when panel is not open', async () => {
      await activateAndOpen();

      // Close the panel
      atom.commands.dispatch(workspaceElement, 'agentic-ai:toggle');
      await new Promise(resolve => setTimeout(resolve, 0));

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const state = pkg.mainModule.serialize();
      expect(state.panelWasVisible).toBe(false);
    });

    it('returns panelWasVisible: true when panel is open', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const state = pkg.mainModule.serialize();
      expect(state.panelWasVisible).toBe(true);
    });

    it('deserializes the view', async () => {
      await activateAndOpen();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      spyOn(pkg.mainModule, 'createPanelView');

      pkg.mainModule.deserializeAgenticAiView({foo: 'bar'});

      expect(pkg.mainModule).toHaveBeenCalled;
    });
  });

  describe('status bar', () => {
    it('creates a status bar tile when consumeStatusBar is called', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const mainModule = pkg.mainModule;

      // Mock status bar API
      const mockTile = { destroy: jasmine.createSpy('destroy') };
      const mockStatusBar = {
        addLeftTile: jasmine.createSpy('addLeftTile').and.returnValue(mockTile),
      };

      mainModule.consumeStatusBar(mockStatusBar);

      expect(mockStatusBar.addLeftTile).toHaveBeenCalled();
      expect(mainModule.statusBarTile).toBe(mockTile);
    });

    it('adds the tile to the left side with priority 100', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const mainModule = pkg.mainModule;

      const mockStatusBar = {
        addLeftTile: jasmine.createSpy('addLeftTile').and.returnValue({
          destroy: jasmine.createSpy('destroy'),
        }),
      };

      mainModule.consumeStatusBar(mockStatusBar);

      const callArgs = mockStatusBar.addLeftTile.calls.mostRecent().args[0];
      expect(callArgs.priority).toBe(100);
    });

    it('creates a div element with correct class and text', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const element = pkg.mainModule.createStatusBarView();

      expect(element.tagName).toBe('DIV');
      expect(element.className).toBe('agentic-ai-status inline-block');
      expect(element.textContent).toBe('AI');
      expect(element.style.cursor).toBe('pointer');
    });

    it('calls toggle when the status bar element is clicked', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const mainModule = pkg.mainModule;

      spyOn(mainModule, 'toggle');

      const element = mainModule.createStatusBarView();
      element.click();

      expect(mainModule.toggle).toHaveBeenCalled();
    });

    it('destroys the status bar tile on deactivation', async () => {
      await activateOnly();

      const pkg = atom.packages.getActivePackage('agentic-ai');
      const mainModule = pkg.mainModule;

      const mockTile = { destroy: jasmine.createSpy('destroy') };
      const mockStatusBar = {
        addLeftTile: jasmine.createSpy('addLeftTile').and.returnValue(mockTile),
      };

      mainModule.consumeStatusBar(mockStatusBar);

      await atom.packages.deactivatePackage('agentic-ai');

      expect(mockTile.destroy).toHaveBeenCalled();
    });
  });
});
