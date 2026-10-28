/* eslint-env node */

const fs = require('node:fs');
const path = require('node:path');

// Runtime code is scanned; styles, fonts, and other design assets cannot issue requests.
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);

const FORBIDDEN_PATTERNS = [
  {
    id: 'telemetry-header',
    pattern: /\bx-(?:address|channel|client|udid2?|version)\b/gi
  },
  {
    id: 'generated-device-id',
    pattern: /device[-_]?(?:id|uuid)/gi
  },
  {
    id: 'device-identifier',
    pattern: /(?<![a-z0-9-])udid2?\b/gi
  },
  {
    id: 'wallet-service-route',
    pattern: /\/v5\/default\/(?:check-website|config)\b/gi
  },
  {
    id: 'remote-wallet-content-route',
    pattern: /\/v5\/(?:announcement\/list|notification\/(?:list|read(?:-all)?)|version\/detail)\b/gi
  },
  {
    id: 'remote-phishing-host',
    pattern: /\b(?:raw\.githubusercontent\.com|cdn\.jsdelivr\.net|metamask\.github\.io)\b/gi
  },
  {
    id: 'remote-phishing-path',
    pattern: /\/v5\/phishing-detect\/hotlist\b/gi
  },
  {
    id: 'remote-session-icon',
    pattern: /\bsession\.icon\b/gi
  }
];

function collectSourceFiles(root) {
  const files = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

function getProductionSourceRoots(repoRoot) {
  const roots = [path.join(repoRoot, 'apps/extension/src')];
  const packagesDir = path.join(repoRoot, 'packages');

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceDir = path.join(packagesDir, entry.name, 'src');
    if (fs.existsSync(sourceDir)) {
      roots.push(sourceDir);
    }
  }

  return roots;
}

function locate(source, index) {
  const prefix = source.slice(0, index);
  const lastNewline = prefix.lastIndexOf('\n');

  return {
    line: prefix.split('\n').length,
    column: index - lastNewline
  };
}

function scanPrivacySources(roots) {
  const violations = [];

  for (const root of roots) {
    for (const file of collectSourceFiles(root)) {
      const source = fs.readFileSync(file, 'utf8');

      for (const rule of FORBIDDEN_PATTERNS) {
        const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
        for (const match of source.matchAll(pattern)) {
          const location = locate(source, match.index);
          violations.push({
            file,
            line: location.line,
            column: location.column,
            rule: rule.id,
            token: match[0]
          });
        }
      }
    }
  }

  return violations.sort((left, right) => {
    return left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column;
  });
}

function formatPrivacyViolations(violations, relativeTo = process.cwd()) {
  return violations
    .map((violation) => {
      const file = path.relative(relativeTo, violation.file) || path.basename(violation.file);
      return `${file}:${violation.line}:${violation.column} [${violation.rule}] ${violation.token}`;
    })
    .join('\n');
}

module.exports = {
  formatPrivacyViolations,
  getProductionSourceRoots,
  scanPrivacySources
};
