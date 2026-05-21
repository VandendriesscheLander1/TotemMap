#!/usr/bin/env node
// Usage: node strip_lua.js input.lua [output.lua]
// If output is omitted, overwrites the input file.
//
// Keeps only the fields parseCatalog() in app.js actually reads:
//   id, weaponType, displayName, description, rarity
// Drops: Icon, bonuses, stats, and any other fields.

const fs = require('fs');

const KEEP = ['id', 'weaponType', 'displayName', 'description', 'rarity'];

const inPath  = process.argv[2];
const outPath = process.argv[3] || inPath;

if (!inPath) {
  console.error('Usage: node strip_lua.js input.lua [output.lua]');
  process.exit(1);
}

const src = fs.readFileSync(inPath, 'utf8');

// Match each top-level animal block: ["Beaver Totem"] = {{ ... }}
const blockRe = /(\["(?:\w+\s+)+Totem"\])\s*=\s*\{\{([\s\S]*?)\}\}\s*(?=,|\n|$)/g;

function stripEntry(entryText) {
  const lines = entryText.split('\n');
  const kept = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    // blank lines inside entries — skip
    if (!line.trim()) continue;
    // check if this line is a simple key = "value" we want to keep
    const m = line.match(/^\s*(\w+)\s*=/);
    if (!m) continue;
    if (KEEP.includes(m[1])) kept.push(line);
  }
  return kept.join('\n');
}

let output = 'return {\n';
const animals = [];

let bm;
blockRe.lastIndex = 0;
while ((bm = blockRe.exec(src)) !== null) {
  const key  = bm[1];   // e.g. ["Beaver Totem"]
  const body = bm[2];

  // split individual entries on "}, {" boundaries
  const rawEntries = body.split(/\}\s*,\s*\{/);
  const cleanEntries = rawEntries.map(e => {
    const stripped = stripEntry(e);
    return stripped ? `        {\n${stripped}\n        }` : null;
  }).filter(Boolean);

  animals.push(`    ${key} = {{\n${cleanEntries.join(',\n')}\n    }}`);
}

output += animals.join(',\n') + '\n}\n';

fs.writeFileSync(outPath, output, 'utf8');
console.log(`Wrote ${outPath} (${animals.length} animal blocks)`);
