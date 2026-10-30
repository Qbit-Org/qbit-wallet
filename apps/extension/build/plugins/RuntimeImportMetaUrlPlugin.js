/* eslint-env node */

const BasicEvaluatedExpression = require('webpack/lib/javascript/BasicEvaluatedExpression');

const PLUGIN_NAME = 'RuntimeImportMetaUrlPlugin';
const JAVASCRIPT_MODULE_TYPES = Object.freeze(['javascript/auto', 'javascript/dynamic', 'javascript/esm']);

/**
 * Webpack 5 inlines `import.meta.url` as the module's absolute `file://` path
 * on the build machine, which ships the builder's checkout path and makes two
 * otherwise identical builds from different directories differ.
 *
 * For the modules matched by `test`, this resolves `import.meta.url` at runtime
 * to the URL of the bundle that contains the module (webpack's base URI, i.e.
 * `self.location` in the MV3 service worker). Webpack already resolves
 * `new URL('asset', import.meta.url)` against the same base, and that asset
 * handling is left to webpack.
 *
 * A non-static `import.meta.resolve(specifier)` is left for the runtime, as
 * webpack's own `import.meta` object, which carries the same file URL. In the
 * matched modules it is `undefined` instead, which is what webpack already
 * makes `typeof import.meta.resolve`: a bundle has no module resolver.
 */
class RuntimeImportMetaUrlPlugin {
  constructor({ test } = {}) {
    if (!(test instanceof RegExp)) {
      throw new TypeError(`${PLUGIN_NAME} requires a RegExp \`test\` for the modules it rewrites`);
    }
    this.test = test;
  }

  apply(compiler) {
    const {
      RuntimeGlobals,
      dependencies: { ConstDependency }
    } = compiler.webpack;

    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation, { normalModuleFactory }) => {
      const handler = (parser) => {
        const matches = () => this.test.test(parser.state.module.nameForCondition() || '');

        // Both taps run before webpack's ImportMetaPlugin, which would inline
        // the file URL and let the parser fold conditions on it at build time.
        parser.hooks.expression.for('import.meta.url').tap({ name: PLUGIN_NAME, stage: -100 }, (expression) => {
          if (!matches()) {
            return undefined;
          }
          const dependency = new ConstDependency(RuntimeGlobals.baseURI, expression.range, [RuntimeGlobals.baseURI]);
          dependency.loc = parser.getLocation(expression);
          parser.state.module.addPresentationalDependency(dependency);
          return true;
        });
        parser.hooks.evaluateIdentifier
          .for('import.meta.url')
          .tap({ name: PLUGIN_NAME, stage: -100 }, (expression) =>
            matches() ? new BasicEvaluatedExpression().setRange(expression.range) : undefined
          );
        const replaceWithUndefined = (node) => {
          const dependency = new ConstDependency('undefined', node.range);
          dependency.loc = parser.getLocation(node);
          parser.state.module.addPresentationalDependency(dependency);
        };
        parser.hooks.expression.for('import.meta.resolve').tap({ name: PLUGIN_NAME, stage: -100 }, (expression) => {
          if (!matches()) {
            return undefined;
          }
          replaceWithUndefined(expression);
          return true;
        });
        // Webpack walks a call's callee through its object, `import.meta` itself.
        parser.hooks.call.for('import.meta.resolve').tap({ name: PLUGIN_NAME, stage: -100 }, (expression) => {
          const [specifier] = expression.arguments;
          if (
            !matches() ||
            // A static specifier is left to webpack, which resolves it to its asset URL.
            (specifier && specifier.type !== 'SpreadElement' && parser.evaluateExpression(specifier).isString())
          ) {
            return undefined;
          }
          replaceWithUndefined(expression.callee);
          parser.walkExpressions(expression.arguments);
          return true;
        });
      };

      for (const type of JAVASCRIPT_MODULE_TYPES) {
        normalModuleFactory.hooks.parser.for(type).tap(PLUGIN_NAME, handler);
      }
    });
  }
}

module.exports = RuntimeImportMetaUrlPlugin;
