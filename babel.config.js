/**
 * Only used by Jest, and only for `.js` files inside node_modules that
 * `transformIgnorePatterns` explicitly un-ignores (see test/jest-unit.json /
 * test/jest-integration.json) — the project's own TypeScript source and
 * tests still go through ts-jest untouched. Several dependencies
 * (@nestjs/* v12, uuid, jose, openid-client, @apollo/server) ship ESM-only
 * builds; Jest's CommonJS-only module runtime can't `require()` them
 * directly. `@babel/preset-env` with `modules: 'commonjs'` down-levels their
 * `import`/`export`/`import.meta.url` syntax to something Jest can load,
 * without requiring a full native-ESM Jest migration (which would need
 * explicit `.js` extensions on every relative import across this entire
 * CommonJS-compiled codebase — far more invasive than the actual problem).
 */
/**
 * `@nestjs/*` v12's optional-peer-dependency loaders (e.g.
 * `@nestjs/mapped-types/dist/type-helpers.utils.js`,
 * `@nestjs/common/utils/load-package.util.js`) all use the same idiom:
 * `const require = createRequire(import.meta.url); ... require('class-validator')`.
 * We're always running under real CommonJS here (Jest, ts-jest, `node
 * dist/main.js` — never a genuine ESM loader), where an ambient `require`
 * already exists — there's no need to *construct* a new module-scoped one
 * from `import.meta.url`. Rewriting the whole `createRequire(import.meta.url)`
 * call to plain `require` sidesteps `babel-plugin-transform-import-meta`'s
 * generated helper colliding with these files' own local `const require =
 * ...` declaration (a temporal-dead-zone `ReferenceError` otherwise, since
 * the helper and the local shadowing declaration fight over evaluation
 * order). Any `import.meta.url` reference NOT part of that exact pattern
 * still falls through to `babel-plugin-transform-import-meta`, which is
 * plugged in after this one runs.
 */
function isCreateRequireOfImportMetaUrl(node) {
  const { callee, arguments: args } = node;
  const isCreateRequireCall =
    (callee.type === 'Identifier' && callee.name === 'createRequire') ||
    (callee.type === 'MemberExpression' &&
      callee.property.type === 'Identifier' &&
      callee.property.name === 'createRequire');
  if (!isCreateRequireCall || args.length !== 1) {
    return false;
  }
  const [arg] = args;
  return (
    arg.type === 'MemberExpression' &&
    arg.object.type === 'MetaProperty' &&
    arg.property.type === 'Identifier' &&
    arg.property.name === 'url'
  );
}

function replaceCreateRequireOfImportMetaUrl() {
  return {
    visitor: {
      CallExpression(path) {
        if (!isCreateRequireOfImportMetaUrl(path.node)) {
          return;
        }
        const parent = path.parentPath;
        // `const require = createRequire(import.meta.url);` — assigning to a
        // binding literally named `require` triggers preset-env's own
        // shadow-rename pass (it renames the declaration AND any reference
        // I'd insert here to the same generated name, since it can't tell
        // "this new reference means the outer ambient require"). There's
        // nothing to construct in CJS — the ambient `require` already does
        // the job — so just drop the whole declaration instead of replacing
        // its initializer, and let every later `require(...)` call in the
        // file naturally resolve to the ambient one.
        if (
          parent.isVariableDeclarator() &&
          parent.node.id.type === 'Identifier' &&
          parent.node.id.name === 'require'
        ) {
          const declaration = parent.parentPath;
          if (declaration.isVariableDeclaration() && declaration.node.declarations.length === 1) {
            declaration.remove();
          } else {
            parent.remove();
          }
          return;
        }
        // Any other usage (e.g. an inline `createRequire(import.meta.url)(pkg)`
        // call, never bound to a `require`-named variable) is safe to
        // replace directly with the ambient `require`.
        path.replaceWithSourceString('require');
      },
    },
  };
}

module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]],
  // No separate `babel-plugin-transform-import-meta` package needed —
  // `@babel/plugin-transform-modules-commonjs` (bundled in preset-env)
  // already down-levels bare `import.meta.url` on its own; adding the
  // separate package on top double-transforms it and the two generated
  // helpers collide (a real TDZ bug observed here). This plugin only needs
  // to handle the one pattern preset-env's built-in support doesn't:
  // `createRequire(import.meta.url)` assigned to a local `require`-shadowing
  // binding.
  plugins: [replaceCreateRequireOfImportMetaUrl],
};
