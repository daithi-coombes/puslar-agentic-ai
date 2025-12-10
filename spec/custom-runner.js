'use strict';

const path = require('path');
const { createRunner } = require('atom-jasmine3-test-runner');

// ── Jasmine 3 runner options ─────────────────────────────────
const jasmine3Runner = createRunner({
  specHelper: {
    atom: true,
    attachToDom: true,
    ci: true,
    customMatchers: true,
    jasmineFocused: true,
    mockClock: false,
    mockLocalStorage: false,
    unspy: true,
  },
  timeReporter: true,
  suffix: '-spec',
}, () => {
  jasmine.getEnv().configure({ hideDisabled: true });
});

// ── Coverage wrapper ─────────────────────────────────────────
// When COVERAGE=1 is set, we wrap the runner with nyc to
// instrument require()'d files and produce a coverage report.
//
// Usage:
//   COVERAGE=1 pulsar --test spec
//
// Without COVERAGE, the runner behaves exactly as before.

module.exports = function (params) {
  if (!process.env.COVERAGE) {
    return jasmine3Runner(params);
  }

  // Lazy-require nyc so it's only needed when coverage is requested
  const NYC = require('nyc');

  const projectRoot = path.resolve(__dirname, '..');

  const nyc = new NYC({
    cwd: projectRoot,
    instrument: true,
    hookRequire: true,
    hookRunInContext: true,
    hookRunInThisContext: true,
    silent: false,
    all: true,
    include: ['lib/**/*.js'],
    exclude: [
      'spec/**',
      'node_modules/**',
      'config/**',
      'lib/views/container.template.js',
    ],
    reporter: ['text', 'html', 'lcov'],
    reportDir: path.join(projectRoot, 'coverage'),
    tempDirectory: path.join(projectRoot, '.nyc_output'),
    cache: true,
    skipEmpty: true,
  });

  // nyc's API is synchronous for setup
  nyc.reset();
  nyc.wrap();

  // Invalidate any cached versions of source files that were loaded
  // before nyc hooked require — so they get re-required instrumented
  Object.keys(require.cache)
    .filter(f => nyc.exclude.shouldInstrument(f))
    .forEach(m => {
      delete require.cache[m];
    });

  // Run the Jasmine 3 specs. The runner returns a promise that
  // resolves to the exit code.
  const result = jasmine3Runner(params);

  // If the runner returns a promise, chain coverage reporting onto it
  if (result && typeof result.then === 'function') {
    return result.then(async (exitCode) => {
      if (global.__coverage__) {
        nyc.writeCoverageFile();
        await nyc.report();
      }
      return exitCode;
    });
  }

  // If the runner is synchronous, write coverage on process exit.
  // Note: nyc.report() is async so we can't fully await it here,
  // but writeCoverageFile() saves the raw data. Run `nyc report`
  // from the CLI afterwards to generate the formatted reports.
  process.on('exit', () => {
    if (global.__coverage__) {
      nyc.writeCoverageFile();
    }
  });

  return result;
};
