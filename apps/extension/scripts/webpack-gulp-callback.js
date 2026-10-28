/* eslint-env node */

const statsOptions = {
  all: false,
  colors: false,
  errorDetails: true,
  errors: true,
  moduleTrace: true
};

function createWebpackGulpCallback(done) {
  return (error, stats) => {
    if (error) {
      done(error);
      return;
    }

    if (!stats) {
      done(new Error('Webpack completed without compilation stats.'));
      return;
    }

    if (stats.hasErrors()) {
      const diagnostics = stats.toString(statsOptions).trim();
      const message = diagnostics
        ? `Webpack compilation failed:\n${diagnostics}`
        : 'Webpack compilation failed with no diagnostics.';

      done(new Error(message));
      return;
    }

    done();
  };
}

module.exports = createWebpackGulpCallback;
