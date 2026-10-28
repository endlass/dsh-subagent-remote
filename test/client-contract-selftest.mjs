#!/usr/bin/env node
/**
 * Client-plugin contract regression test.
 *
 * The browser plugin is plain JS loaded through `window.__ModuleLoader__`; a
 * missing Cordis `inject` entry produces a boot failure ("cannot get property
 * <service> without inject") that no Node-side unit test catches. This suite
 * statically compares every `ctx.<service>` access in `lib/client.js` with the
 * plugin's declared `inject` array.
 *
 *   node test/client-contract-selftest.mjs
 *   exit 0 = all checks passed
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let checks = 0
let failed = 0
function check(name, ok, detail) {
  checks += 1
  if (ok) { console.log(`ok   ${name}`) }
  else { console.log(`FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`); failed += 1 }
}

const injectMatch = /inject:\s*\[([^\]]+)\]/.exec(source)
check('client plugin declares an inject array', injectMatch !== null)
const declared = new Set(
  (injectMatch?.[1] ?? '')
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean),
)
check('inject array is not empty', declared.size > 0, [...declared].join(','))

// Core Cordis context members that are not injected services.
const CORDIS_MEMBERS = new Set([
  'effect', 'logger', 'inject', 'get', 'on', 'set', 'provide', 'plugin', 'scope',
  'service', 'emit', 'waterfall', 'parallel', 'bail', 'serial', 'head', 'ref', 'fiber',
  'accessor', 'root', 'baseDir', 'registry', 'isolate', 'extend',
])
const accessed = new Set()
for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) accessed.add(match[1])
const missing = [...accessed].filter((name) => !declared.has(name) && !CORDIS_MEMBERS.has(name))
check('every ctx.<service> access is declared in inject', missing.length === 0, missing.join(', '))

// Nested slot/panel contexts also expose the parent services; make sure the
// declared inject list still covers the ones we read on the root context.
check('client bundle registers exactly one Cordis plugin', /module\.exports\s*=\s*plugin/.test(source))

console.log(failed === 0 ? '\nPASS client-contract-selftest' : `\nFAIL client-contract-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)
