#!/usr/bin/env node
/**
 * Client-plugin boot + wiring test.
 *
 * `lib/client.js` is a browser module: `node --check` only proves it parses, and
 * the contract test only proves the `inject` list matches `ctx.*` accesses. This
 * suite actually executes the module against a fake `window.__ModuleLoader__`
 * and a mock Cordis context, then asserts what the plugin registered where:
 *
 *   - the remote-run section lands on the subagent catalog footer seat,
 *   - the run detail tab registers its type plus its body under the same id,
 *   - none of the optional seats is required: a client build without the right
 *     Sidebar, or a build whose footer seat throws, still boots the plugin and
 *     keeps the header indicator.
 *
 *   node test/client-boot-selftest.mjs
 *   exit 0 = all checks passed
 */
import { readFileSync } from 'node:fs'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failed += 1
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
  } else {
    console.log(`ok   ${name}`)
  }
}
function checkTrue(name, value) {
  if (value !== true) {
    failed += 1
    console.error(`FAIL ${name}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// --- minimal browser + React stand-ins ------------------------------------
let factory
const windowStub = { __ModuleLoader__: { load(spec) { factory = spec.factory } } }
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  Component: class Component { constructor(props) { this.props = props } },
  Fragment: 'Fragment',
}
const reactDom = { createPortal: (node) => node }
const requireStub = (name) => (name === 'react' ? React : name === 'react-dom' ? reactDom : {})

// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(windowStub, requireStub)
check('module loader captured the factory', typeof factory, 'function')
const plugin = factory(requireStub)
check('plugin exports one Cordis plugin', typeof plugin.apply, 'function')
check('plugin name', plugin.name, 'dsh-subagent-remote-settings')
check('plugin declares its hard dependencies', plugin.inject, ['slots', 'connection', 'locale'])

// --- mock Cordis context --------------------------------------------------
function createContext(options = {}) {
  const registrations = []
  const types = []
  const logs = []
  const knownSlots = new Set(options.slots ?? [
    'conversation.session.header.actions.subagent.footer',
    'sidebar.right.pane.tab',
    'main',
    'plugins.detail.actions',
    'settings.section',
    'conversation.session.header.actions',
  ])
  const services = options.services ?? {
    sidebarRight: { openTab: (kind, opts) => { types.push({ opened: kind, opts }) } },
    sidebarRightTabs: { register: (definition) => { types.push({ definition }); return () => {} } },
    layout: { selectPanel: () => {} },
    pluginNavigation: { openBundle: () => {} },
  }
  const ctx = {
    slots: {
      inject(name, callback) {
        if (name === options.throwingSlot) throw new Error(`seat ${name} is not declared`)
        if (knownSlots.has(name)) callback()
        return () => {}
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    connection: { rpc: { call: async () => ({}) } },
    logger: {
      info: (message) => { logs.push(String(message)) },
      warn: (message) => { logs.push(String(message)) },
      error: (message) => { logs.push(String(message)) },
    },
    effect: (callback) => { callback(); return () => {} },
  }
  // A Cordis child context: same surface plus the requested services.
  ctx.inject = (names, callback) => {
    if (options.noOptionalServices === true) return () => {}
    if (!names.every((name) => services[name] !== undefined)) return () => {}
    const child = Object.create(ctx)
    for (const name of names) child[name] = services[name]
    callback(child)
    return () => {}
  }
  return { ctx, registrations, types, logs }
}

function byName(registrations, name) {
  return registrations.filter((entry) => entry.definition.name === name)
}

// --- full client build ----------------------------------------------------
const full = createContext()
plugin.apply(full.ctx)

const footer = byName(full.registrations, 'conversation.session.header.actions.subagent.footer')
check('one footer section registered', footer.length, 1)
check('footer section id', footer[0]?.definition.id, 'dsh-subagent-remote-runs')
check('footer section order comes after the catalog', footer[0]?.definition.order, 20)
check('footer section renders a component', typeof footer[0]?.component, 'function')

const body = byName(full.registrations, 'sidebar.right.pane.tab')
check('one detail body registered', body.length, 1)
check('detail body key matches the tab type id', body[0]?.definition.key, 'dsh-subagent-remote-runs')

const types = full.types.filter((entry) => entry.definition !== undefined)
check('one tab type registered', types.length, 1)
check('tab type id', types[0]?.definition.id, 'dsh-subagent-remote-runs')
check('tab kind', types[0]?.definition.kind, 'remote-runs')
check('tab type has a title', typeof types[0]?.definition.title, 'function')
check('tab title resolves', types[0]?.definition.title('sidebar://remote-runs'), '远端任务')

checkTrue('header indicator still registers', byName(full.registrations, 'conversation.session.header.actions').length === 1)
checkTrue('plugin page still registers', byName(full.registrations, 'main').length === 1)
checkTrue('seat availability is logged on boot', full.logs.some((line) => line.includes('panel section registered')))

// --- reduced build: no right Sidebar at all -------------------------------
const reduced = createContext({ noOptionalServices: true })
plugin.apply(reduced.ctx)
check('footer still registers without the Sidebar', byName(reduced.registrations, 'conversation.session.header.actions.subagent.footer').length, 1)
check('no tab type without the Sidebar', reduced.types.length, 0)
checkTrue('header indicator survives the missing Sidebar', byName(reduced.registrations, 'conversation.session.header.actions').length === 1)

// --- hostile build: the footer seat itself throws -------------------------
const hostile = createContext({ throwingSlot: 'conversation.session.header.actions.subagent.footer' })
let threw = false
try {
  plugin.apply(hostile.ctx)
} catch {
  threw = true
}
check('a throwing footer seat does not fail the plugin', threw, false)
checkTrue('the failure is logged with the plugin name', hostile.logs.some((line) => line.includes('panel section') || line.includes('dsh-subagent-remote')))

console.log(failed === 0 ? '\nPASS client-boot-selftest' : `\nFAIL client-boot-selftest (${failed})`)
process.exit(failed === 0 ? 0 : 1)
