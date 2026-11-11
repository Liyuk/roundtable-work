// Validates the directory that gets published to GitHub Pages.
//
//   node scripts/validate-site.mjs [dir]   default dir: site/
//
// Fails (exit 1) if the directory holds anything but the allowed files, or if a file refers to an
// external or absolute location, or contains a host or secret pattern. No dependencies.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_FILES = ['index.html', 'styles.css', 'app.js'];

// Each rule reports the first match in a file. Quotes in the patterns mark attribute values and strings,
// so ordinary // comments in app.js and styles.css do not match.
export const RULES = [
  ['absolute http(s) URL', /https?:\/\//i],
  ['protocol-relative URL', /(?:["'(`=]\s*)\/\/[^\s/"')`]/],
  ['file: URL', /\bfile:/i],
  ['root-absolute reference', /\b(?:src|href|action|poster|srcset)\s*=\s*["']?\/(?!\/)/i],
  ['root-absolute url()', /url\(\s*["']?\/(?!\/)/i],
  ['local absolute path', /(?:\/home\/|\/Users\/|\/root\/|\/etc\/|\/var\/|\/tmp\/|\b[A-Za-z]:\\)/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,}/],
  ['private key block', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['cloud access key', /\bAKIA[0-9A-Z]{12,}\b/],
  ['IPv4 literal', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
];

// files: { name: text }. Returns a list of problems (empty means valid).
export function validateFiles(files) {
  const problems = [];
  for (const name of Object.keys(files)) {
    if (!ALLOWED_FILES.includes(name)) problems.push(`${name}: not in the allowlist (${ALLOWED_FILES.join(', ')})`);
  }
  for (const name of ALLOWED_FILES) {
    if (!(name in files)) problems.push(`${name}: missing`);
  }
  for (const [name, text] of Object.entries(files)) {
    if (typeof text !== 'string') continue;
    for (const [label, re] of RULES) {
      const m = text.match(re);
      // Report the line, never the matched text, so a real secret is not copied into CI logs.
      if (m) problems.push(`${name}: line ${text.slice(0, m.index).split('\n').length}: ${label}`);
    }
  }
  return problems;
}

// Reads a directory without following links. Subdirectories, symlinks and other special entries are
// reported as problems instead of being read.
export function validateDir(dir) {
  const files = {};
  const problems = [];
  for (const entry of readdirSync(dir)) {
    const stat = lstatSync(join(dir, entry));
    if (!stat.isFile()) problems.push(`${entry}: not a regular file`);
    else files[entry] = readFileSync(join(dir, entry), 'utf8');
  }
  return [...problems, ...validateFiles(files)];
}

function main() {
  const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../site', import.meta.url)));
  let problems;
  try { problems = validateDir(dir); }
  catch (err) { problems = [`cannot read the site directory: ${err.code ?? err.message}`]; }
  if (problems.length) {
    console.error(`Site validation failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log(`Site validation passed: ${ALLOWED_FILES.join(', ')} only; no external references or host/secret patterns.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
