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

// --- subagent-panel integration (DSH 0.2.1-rc.2+ seats) -------------------
// The two seats we extend belong to other plugins. They must stay optional: the
// Sidebar services are obtained through ctx.inject(), never through the hard
// `inject` array, so a build without the right Sidebar cannot fail the plugin.
check(
  'panel section targets the subagent catalog footer',
  /conversation\.session\.header\.actions\.subagent\.footer/.test(source),
)
check('detail body targets the right Sidebar tab seat', /sidebar\.right\.pane\.tab'/.test(source))
check(
  'Sidebar services are injected lazily, not declared as hard dependencies',
  !declared.has('sidebarRight') && !declared.has('sidebarRightTabs') && /ctx\.inject\(\['sidebarRight'/.test(source),
)
check(
  'panel and detail renders are error-boundaried',
  /class DsrBoundary/.test(source) && /guarded\(RemoteRunsPanel/.test(source) && /guarded\(RemoteRunsDetail/.test(source),
)
check('the stop control calls the cancelRun RPC', /'cancelRun'/.test(source))
check(
  'seat availability is logged (registered / absent)',
  /panel section registered/.test(source) && /panel section absent/.test(source),
)
check(
  'the new seats add no portal or global listener',
  !/createPortal/.test(source.slice(source.indexOf('class DsrBoundary'), source.indexOf('function installHeaderRuns')))
    && !/document\.addEventListener/.test(source.slice(source.indexOf('class DsrBoundary'), source.indexOf('function installHeaderRuns'))),
)

console.log(failed === 0 ? '\nPASS client-contract-selftest' : `\nFAIL client-contract-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)
