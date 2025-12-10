const ConfigManager = require('../config');
const ContextManager = require('../lib/context-manager.js');
const EventEmitter = require('events');
const fs = require('fs');

describe('ContextManager', () => {
  let contextManager;

  beforeEach(() => {
    contextManager = new ContextManager();
    contextManager.cacheDir = '/tmp/test-cache';

    spyOn(atom.project, 'getPaths').and.returnValue(['/home/user/test-project']);
  });

  it('returns project name from atom paths', () => {
    expect(contextManager.projectName()).toBe('test-project');
  });

  describe('getCollectionName()', () => {
    it('will get the collection name', () => {
      expect(contextManager.getCollectionName()).toBe('agentic-ai_undefined_d391ffb4cc');
    });

    it('uses collection name from config when available', () => {
      spyOn(ConfigManager, 'get').and.returnValue('custom-collection');

      const name = contextManager.getCollectionName('my-project');

      expect(name).toContain('custom-collection_my-project_');
    });
  });

  describe('ensureCacheDir()', () => {
    it('will create the cache directory if it does not exist', () => {
      spyOn(fs, 'existsSync').and.returnValue(false);
      spyOn(fs, 'mkdirSync');

      contextManager.ensureCacheDir();

      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/test-cache', { recursive: true });
    });

    it('will not create the directory if it already exists', () => {
      spyOn(fs, 'existsSync').and.returnValue(true);
      spyOn(fs, 'mkdirSync');

      contextManager.ensureCacheDir();

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('will log to console.error if mkdirSync throws', () => {
      const error = new Error('permission denied');
      spyOn(fs, 'existsSync').and.returnValue(false);
      spyOn(fs, 'mkdirSync').and.throwError(error);
      spyOn(console, 'error');

      contextManager.ensureCacheDir();

      expect(console.error).toHaveBeenCalledWith('Failed to create cache directory:', error);
    });
  });

  describe('getEmbeddingFilePath()', () => {
    it('will get the embedding file path', () => {
      expect(contextManager.getEmbeddingFilePath()).toBe('/tmp/test-cache/embeddings_test-project.json');
    });
  });

  describe('hasCachedEmbeddings()', () => {
    it('will return true if cached dir', () => {
      spyOn(fs, 'existsSync').and.returnValue(true);
      expect(contextManager.hasCachedEmbeddings()).toBe(true);
    });

    it('will return false if no cached dir', () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue(undefined);

      expect(contextManager.hasCachedEmbeddings()).toBe(false);
    });

    it('will return false if fs throw error', () => {
      spyOn(fs, 'existsSync').and.throwError(new Error('foo'));

      expect(contextManager.hasCachedEmbeddings()).toBe(false);
    });
  });

  describe('initializeProjectTracking', () => {
    beforeEach(() => {
      delete require.cache[require.resolve('../lib/context-manager.js')];
      const ContextManager = require('../lib/context-manager.js');
      contextManager = new ContextManager();
    });

    it('calls onProjectChange with the first path when project paths change', () => {
      spyOn(contextManager, 'onProjectChange');
      spyOn(contextManager, 'onProjectClosed');
      // getPaths is already spied on from the outer beforeEach — just update the return value
      atom.project.getPaths.and.returnValue([]);

      contextManager.initializeProjectTracking();

      atom.project.setPaths(['/home/user/project-a']);

      expect(contextManager.onProjectChange).toHaveBeenCalledWith('/home/user/project-a');
      expect(contextManager.onProjectClosed).not.toHaveBeenCalled();
    });

    it('calls onProjectClosed when project paths become empty', () => {
      spyOn(contextManager, 'onProjectChange');
      spyOn(contextManager, 'onProjectClosed');
      atom.project.getPaths.and.returnValue(['/home/user/something']);

      contextManager.initializeProjectTracking();
      contextManager.onProjectChange.calls.reset();

      atom.project.setPaths([]);

      expect(contextManager.onProjectClosed).toHaveBeenCalled();
    });

    it('calls onProjectChange immediately if a project is already open', () => {
      spyOn(contextManager, 'onProjectChange');
      spyOn(atom.project, 'onDidChangePaths');
      atom.project.getPaths.and.returnValue(['/home/user/existing-project']);

      contextManager.initializeProjectTracking();

      expect(contextManager.onProjectChange).toHaveBeenCalledWith('/home/user/existing-project');
    });

    it('does not call onProjectChange on init if no project is open', () => {
      spyOn(contextManager, 'onProjectChange');
      spyOn(contextManager, 'onProjectClosed');
      spyOn(atom.project, 'onDidChangePaths');
      atom.project.getPaths.and.returnValue([]);

      contextManager.initializeProjectTracking();

      expect(contextManager.onProjectChange).not.toHaveBeenCalled();
      expect(contextManager.onProjectClosed).not.toHaveBeenCalled();
    });
  });

  describe('onProjectChange()', () => {
    it('sets project state when switching to a new project', () => {
      spyOn(contextManager, 'hasCachedEmbeddings').and.returnValue(false);
      spyOn(console, 'log');

      contextManager.onProjectChange('/home/user/new-project');

      expect(contextManager.currentProjectRoot).toBe('/home/user/new-project');
      expect(contextManager.isIndexed).toBe(false);
      expect(contextManager.lastIndexResult).toBeNull();
    });

    it('sets isIndexed to true when cached embeddings exist', () => {
      spyOn(contextManager, 'hasCachedEmbeddings').and.returnValue(true);
      spyOn(console, 'log');

      contextManager.onProjectChange('/home/user/cached-project');

      expect(contextManager.isIndexed).toBe(true);
    });

    it('skips if same project is already indexed', () => {
      contextManager.currentProjectRoot = '/home/user/same-project';
      contextManager.isIndexed = true;

      spyOn(contextManager, 'hasCachedEmbeddings');

      contextManager.onProjectChange('/home/user/same-project');

      expect(contextManager.hasCachedEmbeddings).not.toHaveBeenCalled();
    });
  });

  describe('onProjectClosed()', () => {
    it('resets all project state', () => {
      contextManager.currentProjectRoot = '/some/path';
      contextManager.isIndexed = true;
      contextManager.lastIndexResult = { some: 'result' };

      contextManager.onProjectClosed();

      expect(contextManager.currentProjectRoot).toBe('');
      expect(contextManager.isIndexed).toBe(false);
      expect(contextManager.lastIndexResult).toBeNull();
    });
  });

  describe('_providerOptions()', () => {
    it('returns host for ollama provider', () => {
      const config = { provider: 'ollama', connection: { baseUrl: 'http://localhost:11434' } };
      expect(contextManager._providerOptions(config)).toEqual({ host: 'http://localhost:11434' });
    });

    it('returns device/dtype/quantized for transformers provider', () => {
      const config = { provider: 'transformers', connection: { device: 'gpu', dtype: 'fp16' }, quantized: true };
      expect(contextManager._providerOptions(config)).toEqual({
        device: 'gpu',
        dtype: 'fp16',
        quantized: true,
      });
    });

    it('uses defaults for transformers when connection is empty', () => {
      const config = { provider: 'transformers' };
      expect(contextManager._providerOptions(config)).toEqual({
        device: 'cpu',
        dtype: 'fp32',
        quantized: false,
      });
    });

    it('returns the raw connection object for unknown providers', () => {
      const conn = { apiKey: '123', endpoint: 'https://api.example.com' };
      const config = { provider: 'openai', connection: conn };
      expect(contextManager._providerOptions(config)).toEqual(conn);
    });
  });

  describe('createIndexer()', () => {
    it('creates a new indexer with config from ConfigManager', async () => {
      const mockIndexer = Object.assign(new EventEmitter(), {
        dispose: jasmine.createSpy('dispose').and.returnValue(Promise.resolve()),
      });

      const { Indexer } = require('rag-codebase-indexer');
      spyOn(Indexer, 'create').and.returnValue(Promise.resolve(mockIndexer));
      spyOn(ConfigManager, 'getEmbedConfig').and.returnValue({
        provider: 'ollama',
        name: 'nomic-embed-text',
        connection: { baseUrl: 'http://localhost:11434' },
      });

      const result = await contextManager.createIndexer('ollama', 'nomic-embed-text');

      expect(Indexer.create).toHaveBeenCalled();
      expect(result).toBe(mockIndexer);
      expect(contextManager.indexer).toBe(mockIndexer);
    });

    it('disposes previous indexer before creating a new one', async () => {
      const oldIndexer = {
        dispose: jasmine.createSpy('dispose').and.returnValue(Promise.resolve()),
      };
      contextManager.indexer = oldIndexer;

      const newIndexer = Object.assign(new EventEmitter(), {
        dispose: jasmine.createSpy('dispose'),
      });

      const { Indexer } = require('rag-codebase-indexer');
      spyOn(Indexer, 'create').and.returnValue(Promise.resolve(newIndexer));
      spyOn(ConfigManager, 'getEmbedConfig').and.returnValue({
        provider: 'ollama', name: 'test', connection: {},
      });

      await contextManager.createIndexer();

      expect(oldIndexer.dispose).toHaveBeenCalled();
    });
  });

  describe('indexCurrentProject()', () => {
    it('throws when no project is open', async () => {
      contextManager.currentProjectRoot = '';

      await expectAsync(contextManager.indexCurrentProject())
        .toBeRejectedWithError('No project open to index');
    });

    it('returns cached result when embeddings exist and force is false', async () => {
      contextManager.currentProjectRoot = '/home/user/test-project';
      contextManager.lastIndexResult = { files: 10 };
      spyOn(contextManager, 'hasCachedEmbeddings').and.returnValue(true);
      spyOn(console, 'log');

      const result = await contextManager.indexCurrentProject();

      expect(result).toEqual({ files: 10 });
      expect(contextManager.isIndexed).toBe(true);
    });

    it('indexes when force is true even with cached embeddings', async () => {
      contextManager.currentProjectRoot = '/home/user/test-project';
      spyOn(contextManager, 'hasCachedEmbeddings').and.returnValue(true);
      spyOn(console, 'log');

      const mockResult = { files: 5, dimensions: 384 };
      const mockIndexer = {
        index: jasmine.createSpy('index').and.returnValue(Promise.resolve(mockResult)),
      };
      contextManager.indexer = mockIndexer;

      spyOn(ConfigManager, 'getIndexingConfig').and.returnValue({
        include: ['**/*.js'], exclude: ['node_modules'], batchSize: 50,
      });

      const result = await contextManager.indexCurrentProject({ force: true });

      expect(mockIndexer.index).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
      expect(contextManager.isIndexed).toBe(true);
      expect(contextManager.lastIndexResult).toEqual(mockResult);
    });

    it('creates indexer if one does not exist', async () => {
      contextManager.currentProjectRoot = '/home/user/test-project';
      contextManager.indexer = null;
      spyOn(contextManager, 'hasCachedEmbeddings').and.returnValue(false);
      spyOn(console, 'log');

      const mockResult = { files: 3 };
      const mockIndexer = Object.assign(new EventEmitter(), {
        index: jasmine.createSpy('index').and.returnValue(Promise.resolve(mockResult)),
        dispose: jasmine.createSpy('dispose'),
      });

      spyOn(contextManager, 'createIndexer').and.callFake(async () => {
        contextManager.indexer = mockIndexer;
        return mockIndexer;
      });
      spyOn(ConfigManager, 'getIndexingConfig').and.returnValue({
        include: [], exclude: [], batchSize: 50,
      });

      await contextManager.indexCurrentProject();

      expect(contextManager.createIndexer).toHaveBeenCalled();
    });

    it('throws a wrapped error when indexing fails', async () => {
      contextManager.currentProjectRoot = '/home/user/test-project';
      spyOn(contextManager, 'hasCachedEmbeddings').and.returnValue(false);
      spyOn(console, 'log');
      spyOn(console, 'error');

      const mockIndexer = {
        index: jasmine.createSpy('index').and.returnValue(
          Promise.reject(new Error('connection refused'))
        ),
      };
      contextManager.indexer = mockIndexer;

      spyOn(ConfigManager, 'getIndexingConfig').and.returnValue({
        include: [], exclude: [], batchSize: 50,
      });

      await expectAsync(contextManager.indexCurrentProject())
        .toBeRejectedWithError('Indexing failed: connection refused');
    });
  });

  describe('ingestToStore()', () => {
    it('ingests provided indexResult', async () => {
      const mockStore = {
        ingest: jasmine.createSpy('ingest').and.returnValue(Promise.resolve({ inserted: 10 })),
      };
      spyOn(contextManager, 'ensureStore').and.returnValue(Promise.resolve(mockStore));

      const indexResult = { dimensions: 384, embedFile: '/tmp/embed.json' };
      const result = await contextManager.ingestToStore(indexResult);

      expect(mockStore.ingest).toHaveBeenCalledWith(indexResult);
      expect(result).toEqual({ inserted: 10 });
    });

    it('falls back to lastIndexResult when no argument given', async () => {
      contextManager.lastIndexResult = { dimensions: 384, embedFile: '/tmp/cached.json' };
      const mockStore = {
        ingest: jasmine.createSpy('ingest').and.returnValue(Promise.resolve({ inserted: 5 })),
      };
      spyOn(contextManager, 'ensureStore').and.returnValue(Promise.resolve(mockStore));

      await contextManager.ingestToStore();

      expect(mockStore.ingest).toHaveBeenCalledWith(contextManager.lastIndexResult);
    });

    it('falls back to cached embeddings file when no result available', async () => {
      contextManager.lastIndexResult = null;
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/test-cache/embed.json');
      spyOn(fs, 'existsSync').and.returnValue(true);
      spyOn(contextManager, '_readCachedDimensions').and.returnValue(384);

      const mockStore = {
        ingest: jasmine.createSpy('ingest').and.returnValue(Promise.resolve({ inserted: 3 })),
      };
      spyOn(contextManager, 'ensureStore').and.returnValue(Promise.resolve(mockStore));

      await contextManager.ingestToStore();

      const ingestArg = mockStore.ingest.calls.mostRecent().args[0];
      expect(ingestArg.embedFile).toBe('/tmp/test-cache/embed.json');
      expect(ingestArg.dimensions).toBe(384);
    });

    it('throws when no result and no cached file', async () => {
      contextManager.lastIndexResult = null;
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue(null);

      await expectAsync(contextManager.ingestToStore())
        .toBeRejectedWithError(/No index result available/);
    });
  });

  describe('ensureStore()', () => {
    it('returns existing store if already connected', async () => {
      const existingStore = { search: jasmine.createSpy('search') };
      contextManager.store = existingStore;

      const result = await contextManager.ensureStore();

      expect(result).toBe(existingStore);
    });

    it('throws when dimensions cannot be resolved', async () => {
      contextManager.store = null;
      contextManager.lastIndexResult = null;
      spyOn(contextManager, '_readCachedDimensions').and.returnValue(null);

      await expectAsync(contextManager.ensureStore())
        .toBeRejectedWithError(/dimensions unknown/);
    });

    it('connects to VectorStore with explicit dimensions', async () => {
      contextManager.store = null;
      const mockStore = { search: jasmine.createSpy('search') };

      const { VectorStore } = require('rag-codebase-indexer');
      spyOn(VectorStore, 'connect').and.returnValue(Promise.resolve(mockStore));
      spyOn(ConfigManager, 'getVectorDbConfig').and.returnValue({
        chromaUrl: 'http://localhost:8000',
        batchSize: 200,
      });
      spyOn(contextManager, 'getCollectionName').and.returnValue('test-collection');

      const result = await contextManager.ensureStore({ dimensions: 384 });

      expect(VectorStore.connect).toHaveBeenCalled();
      expect(result).toBe(mockStore);
      expect(contextManager.store).toBe(mockStore);
    });

    it('resolves dimensions from lastIndexResult', async () => {
      contextManager.store = null;
      contextManager.lastIndexResult = { dimensions: 768 };
      const mockStore = {};

      const { VectorStore } = require('rag-codebase-indexer');
      spyOn(VectorStore, 'connect').and.returnValue(Promise.resolve(mockStore));
      spyOn(ConfigManager, 'getVectorDbConfig').and.returnValue({});
      spyOn(contextManager, 'getCollectionName').and.returnValue('test-collection');

      await contextManager.ensureStore();

      const callArgs = VectorStore.connect.calls.mostRecent().args[0];
      expect(callArgs.dimensions).toBe(768);
    });

    it('resolves dimensions from cached file as fallback', async () => {
      contextManager.store = null;
      contextManager.lastIndexResult = null;
      spyOn(contextManager, '_readCachedDimensions').and.returnValue(384);
      const mockStore = {};

      const { VectorStore } = require('rag-codebase-indexer');
      spyOn(VectorStore, 'connect').and.returnValue(Promise.resolve(mockStore));
      spyOn(ConfigManager, 'getVectorDbConfig').and.returnValue({});
      spyOn(contextManager, 'getCollectionName').and.returnValue('test-collection');

      await contextManager.ensureStore();

      const callArgs = VectorStore.connect.calls.mostRecent().args[0];
      expect(callArgs.dimensions).toBe(384);
    });
  });

  describe('_readCachedDimensions()', () => {
    it('returns dimensions from cached file', () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/test-cache/embed.json');
      spyOn(fs, 'existsSync').and.returnValue(true);
      spyOn(fs, 'readFileSync').and.returnValue(JSON.stringify({ dimensions: 384 }));

      expect(contextManager._readCachedDimensions()).toBe(384);
    });

    it('returns null when no embedding path', () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue(null);

      expect(contextManager._readCachedDimensions()).toBeNull();
    });

    it('returns null when file does not exist', () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/missing.json');
      spyOn(fs, 'existsSync').and.returnValue(false);

      expect(contextManager._readCachedDimensions()).toBeNull();
    });

    it('returns null when dimensions field is missing', () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/test-cache/embed.json');
      spyOn(fs, 'existsSync').and.returnValue(true);
      spyOn(fs, 'readFileSync').and.returnValue(JSON.stringify({ model: 'test' }));

      expect(contextManager._readCachedDimensions()).toBeNull();
    });

    it('returns null and warns when JSON is invalid', () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/test-cache/embed.json');
      spyOn(fs, 'existsSync').and.returnValue(true);
      spyOn(fs, 'readFileSync').and.returnValue('not json{{{');
      spyOn(console, 'warn');

      expect(contextManager._readCachedDimensions()).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe('isProjectIndexed()', () => {
    it('returns true when current project is indexed', () => {
      contextManager.currentProjectRoot = '/home/user/test-project';
      contextManager.isIndexed = true;

      expect(contextManager.isProjectIndexed()).toBe(true);
    });

    it('falls back to checking cached embeddings', () => {
      contextManager.currentProjectRoot = '/home/user/different-project';
      contextManager.isIndexed = false;
      spyOn(contextManager, 'hasCachedEmbeddings').and.returnValue(true);

      expect(contextManager.isProjectIndexed()).toBe(true);
    });

    it('returns false when not indexed and no cache', () => {
      contextManager.currentProjectRoot = '/home/user/different-project';
      contextManager.isIndexed = false;
      spyOn(contextManager, 'hasCachedEmbeddings').and.returnValue(false);

      expect(contextManager.isProjectIndexed()).toBe(false);
    });
  });

  describe('getContext()', () => {
    it('searches the store with default options', async () => {
      const mockStore = Object.assign(new EventEmitter(), {
        search: jasmine.createSpy('search').and.returnValue(
          Promise.resolve({ documents: [], scores: [] })
        ),
      });
      spyOn(contextManager, 'ensureStore').and.returnValue(Promise.resolve(mockStore));
      spyOn(ConfigManager, 'getSearchConfig').and.returnValue({ topK: 10 });

      const result = await contextManager.getContext('how does auth work?');

      expect(mockStore.search).toHaveBeenCalled();
      const searchArgs = mockStore.search.calls.mostRecent().args;
      expect(searchArgs[0]).toBe('how does auth work?');
      expect(searchArgs[1].topK).toBe(10);
    });

    it('applies file filter when currentFile is provided', async () => {
      contextManager.currentProjectRoot = '/home/user/test-project';

      const mockStore = Object.assign(new EventEmitter(), {
        search: jasmine.createSpy('search').and.returnValue(
          Promise.resolve({ documents: [] })
        ),
      });
      spyOn(contextManager, 'ensureStore').and.returnValue(Promise.resolve(mockStore));
      spyOn(ConfigManager, 'getSearchConfig').and.returnValue({});

      await contextManager.getContext('query', {
        currentFile: '/home/user/test-project/lib/auth.js',
      });

      const searchOpts = mockStore.search.calls.mostRecent().args[1];
      expect(searchOpts.filters).toBeDefined();
      expect(searchOpts.filters.filePath).toBe('lib/auth.js');
    });

    it('uses topK override when provided', async () => {
      const mockStore = Object.assign(new EventEmitter(), {
        search: jasmine.createSpy('search').and.returnValue(
          Promise.resolve({ documents: [] })
        ),
      });
      spyOn(contextManager, 'ensureStore').and.returnValue(Promise.resolve(mockStore));
      spyOn(ConfigManager, 'getSearchConfig').and.returnValue({ topK: 10 });

      await contextManager.getContext('query', { topK: 3 });

      const searchOpts = mockStore.search.calls.mostRecent().args[1];
      expect(searchOpts.topK).toBe(3);
    });

    it('uses empty config when getSearchConfig returns null', async () => {
      const mockStore = Object.assign(new EventEmitter(), {
        search: jasmine.createSpy('search').and.returnValue(
          Promise.resolve({ documents: [] })
        ),
      });
      spyOn(contextManager, 'ensureStore').and.returnValue(Promise.resolve(mockStore));
      spyOn(ConfigManager, 'getSearchConfig').and.returnValue(null);

      await contextManager.getContext('query');

      const searchOpts = mockStore.search.calls.mostRecent().args[1];
      expect(searchOpts.topK).toBe(15);
    });

    it('uses default topK when getSearchConfig is undefined', async () => {
      const mockStore = Object.assign(new EventEmitter(), {
        search: jasmine.createSpy('search').and.returnValue(
          Promise.resolve({ documents: [] })
        ),
      });
      spyOn(contextManager, 'ensureStore').and.returnValue(Promise.resolve(mockStore));

      // Temporarily remove getSearchConfig to exercise the ?. branch
      const original = ConfigManager.getSearchConfig;
      ConfigManager.getSearchConfig = undefined;

      await contextManager.getContext('query');

      // Restore
      ConfigManager.getSearchConfig = original;

      const searchOpts = mockStore.search.calls.mostRecent().args[1];
      expect(searchOpts.topK).toBe(15);
    });
  });

  describe('clearIndex()', () => {
    it('deletes the cached file and resets state', async () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/test-cache/embed.json');
      spyOn(fs, 'existsSync').and.returnValue(true);
      spyOn(fs, 'unlinkSync');

      contextManager.isIndexed = true;
      contextManager.lastIndexResult = { some: 'result' };

      const result = await contextManager.clearIndex();

      expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/test-cache/embed.json');
      expect(contextManager.isIndexed).toBe(false);
      expect(contextManager.lastIndexResult).toBeNull();
      expect(result).toBe(true);
    });

    it('resets state even when no cached file exists', async () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue(null);

      const result = await contextManager.clearIndex();

      expect(contextManager.isIndexed).toBe(false);
      expect(result).toBe(true);
    });

    it('handles errors when deleting the file', async () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/test-cache/embed.json');
      spyOn(fs, 'existsSync').and.returnValue(true);
      spyOn(fs, 'unlinkSync').and.throwError(new Error('permission denied'));
      spyOn(console, 'error');

      const result = await contextManager.clearIndex();

      expect(console.error).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  describe('getCacheInfo()', () => {
    it('returns exists:false when no embedding path', () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue(null);

      expect(contextManager.getCacheInfo()).toEqual({
        exists: false, path: null, size: 0, modified: null,
      });
    });

    it('returns exists:false when file does not exist', () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/missing.json');
      spyOn(fs, 'existsSync').and.returnValue(false);

      expect(contextManager.getCacheInfo()).toEqual({
        exists: false, path: null, size: 0, modified: null,
      });
    });

    it('returns file info when cache exists', () => {
      const mockMtime = new Date('2025-06-01T12:00:00Z');
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/test-cache/embed.json');
      spyOn(fs, 'existsSync').and.returnValue(true);
      spyOn(fs, 'statSync').and.returnValue({ size: 4096, mtime: mockMtime });

      expect(contextManager.getCacheInfo()).toEqual({
        exists: true,
        path: '/tmp/test-cache/embed.json',
        size: 4096,
        modified: mockMtime,
      });
    });

    it('returns exists:false when statSync throws', () => {
      spyOn(contextManager, 'getEmbeddingFilePath').and.returnValue('/tmp/test-cache/embed.json');
      spyOn(fs, 'existsSync').and.returnValue(true);
      spyOn(fs, 'statSync').and.throwError(new Error('EACCES'));

      expect(contextManager.getCacheInfo()).toEqual({
        exists: false, path: '/tmp/test-cache/embed.json', size: 0, modified: null,
      });
    });
  });

  describe('destroy()', () => {
    it('resets all state', async () => {
      contextManager.currentProjectRoot = '/some/path';
      contextManager.isIndexed = true;
      contextManager.lastIndexResult = { some: 'result' };

      await contextManager.destroy();

      expect(contextManager.indexer).toBeNull();
      expect(contextManager.store).toBeNull();
      expect(contextManager.currentProjectRoot).toBe('');
      expect(contextManager.isIndexed).toBe(false);
      expect(contextManager.lastIndexResult).toBeNull();
    });

    it('disposes indexer and store if they exist', async () => {
      const mockIndexer = { dispose: jasmine.createSpy('dispose').and.returnValue(Promise.resolve()) };
      const mockStore = { dispose: jasmine.createSpy('dispose').and.returnValue(Promise.resolve()) };
      contextManager.indexer = mockIndexer;
      contextManager.store = mockStore;

      await contextManager.destroy();

      expect(mockIndexer.dispose).toHaveBeenCalled();
      expect(mockStore.dispose).toHaveBeenCalled();
    });
  });
});
