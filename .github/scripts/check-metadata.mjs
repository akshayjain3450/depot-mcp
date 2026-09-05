#!/usr/bin/env node
// Keeps the distribution metadata files in agreement with package.json so a version bump
// cannot be half-applied. Run from the repository root.

import { readFileSync } from 'node:fs';
import process from 'node:process';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

const pkg = read('package.json');
const server = read('server.json');
const manifest = read('manifest.json');

const problems = [];

if (typeof pkg.mcpName !== 'string' || !/^io\.github\.[^/]+\/depot-mcp$/.test(pkg.mcpName)) {
  problems.push(`package.json mcpName should look like io.github.<owner>/depot-mcp, got ${JSON.stringify(pkg.mcpName)}`);
}
if (server.name !== pkg.mcpName) {
  problems.push(`server.json name (${server.name}) must equal package.json mcpName (${pkg.mcpName})`);
}
if (server.version !== pkg.version) {
  problems.push(`server.json version (${server.version}) must equal package.json version (${pkg.version})`);
}
for (const entry of server.packages ?? []) {
  if (entry.registryType === 'npm') {
    if (entry.identifier !== pkg.name) {
      problems.push(`server.json npm identifier (${entry.identifier}) must equal package.json name (${pkg.name})`);
    }
    if (entry.version !== pkg.version) {
      problems.push(`server.json npm package version (${entry.version}) must equal package.json version (${pkg.version})`);
    }
  }
}
if (manifest.version !== pkg.version) {
  problems.push(`manifest.json version (${manifest.version}) must equal package.json version (${pkg.version})`);
}
if (manifest.name !== pkg.name) {
  problems.push(`manifest.json name (${manifest.name}) must equal package.json name (${pkg.name})`);
}
if (!Array.isArray(pkg.files) || !pkg.files.includes('dist')) {
  problems.push('package.json files must include dist');
}
if (pkg.bin?.['depot-mcp'] !== 'dist/index.js') {
  problems.push('package.json bin.depot-mcp must be dist/index.js');
}

if (problems.length > 0) {
  console.error('Metadata check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Metadata OK: ${pkg.name}@${pkg.version} (${pkg.mcpName})`);
