import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { deployPlugins } from "../deploy-plugins.mjs"
import { pluginManifest } from "../plugin-manifest.mjs"

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const approvedTempRoot = process.env.OPENCODE_TOOLS_TEST_TMPDIR ?? join(tmpdir(), "opencode")
await mkdir(approvedTempRoot, { recursive: true })
const root = await mkdtemp(join(approvedTempRoot, "opencode-tools-v2-"))
const env = {
  PATH: process.env.PATH,
  HOME: root,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
}
const args = ["--standalone", root, "--log-level", "debug", "--print-logs"]
const receiptPath = join(root, "receipts.jsonl")
const recordSource = String.raw`import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
const receiptPath = ${JSON.stringify(receiptPath)}
const record = (kind, data = {}) => appendFileSync(receiptPath, JSON.stringify({ kind, pid: process.pid, ...data }) + "\n")
const receipts = () => readFileSync(receiptPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
`
let driver
let terminal = ""
try {
  // The host discovers ancestor config even outside repositories. Refuse a polluted
  // temp base rather than allowing user configuration into this test.
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    for (const base of [dir, join(dir, ".opencode")]) {
      for (const name of ["opencode.json", "opencode.jsonc"]) {
        let present = false
        try { await access(join(base, name)); present = true } catch (error) { if (error.code !== "ENOENT") throw error }
        assert.equal(present, false, `Smoke ancestor config would be loaded: ${join(base, name)}`)
      }
    }
    if (dirname(dir) === dir) break
  }
  const version = execFileSync("opencode", ["--version"], { env, encoding: "utf8" }).trim()
  assert.match(version, /\bv?2\.0\.16\b/, "This acceptance smoke targets installed OpenCode 2.0.16")
  const configRoot = join(env.XDG_CONFIG_HOME, "opencode")
  await deployPlugins(configRoot, { logLevel: "silent" })
  await writeFile(join(configRoot, "cli.json"), JSON.stringify({
    $schema: "https://opencode.ai/v2/cli.json", animations: false,
    attention: { notifications: false, sound: false }, session: { sidebar: "auto" },
  }))

  // Observe native setup, registration, mounting and cleanup at the boundary.
  // Each wrapper delegates to the unchanged built implementation and real ui.slot;
  // it neither supplies a renderer nor invokes a slot itself.
  for (const { key } of pluginManifest) {
    const dir = join(configRoot, `opencode-tools-${key}`)
    await rename(join(dir, "tui.js"), join(dir, "implementation.js"))
    await writeFile(join(dir, "tui.js"), `${recordSource}
import plugin from "./implementation.js"
export default { ...plugin, async setup(context) {
  const ui = new Proxy(context.ui, { get(target, key) {
    if (key !== "slot") return Reflect.get(target, key)
    return claim => {
      const slot = claim.append ?? claim.prepend ?? claim.before ?? claim.after ?? claim.replace
      const dispose = target.slot({ ...claim, render(props) {
        const result = claim.render(props)
        record("render", { id: plugin.id, slot })
        return result
      } })
      record("slot", { id: plugin.id, slot })
      return dispose
    }
  } })
  const client = new Proxy(context.client, { get(target, key) {
    if (key !== "rpc") return Reflect.get(target, key)
    return (...args) => {
      const rpc = target.rpc(...args)
      return new Proxy(rpc, { get(methods, name) {
        if (name !== "fetch") return Reflect.get(methods, name)
        return (input, ...rest) => {
          record("quota-fetch", { id: plugin.id, provider: input.provider })
          return methods.fetch(input, ...rest)
        }
      } })
    }
  } })
  const cleanup = await plugin.setup(new Proxy(context, { get(target, key) {
    return key === "ui" ? ui : key === "client" ? client : Reflect.get(target, key)
  } }))
  record("setup", { id: plugin.id })
  return async () => { await cleanup?.(); record("cleanup", { id: plugin.id }) }
} }
`)
  }

  const probeRoot = join(configRoot, "smoke-probe")
  await mkdir(probeRoot)
  await writeFile(join(probeRoot, "package.json"), JSON.stringify({
    name: "opencode-tools-smoke-probe", type: "module", exports: { ".": "./index.js", "./tui": "./tui.js" },
  }))
  await build({ stdin: { contents: `${recordSource}
import * as Plugin from "@opencode/plugin/promise/plugin"
export default Plugin.define({ id: "opencode-tools.smoke-probe", setup(context) {
  record("server-setup", { version: context.app.version, directory: context.location.directory })
  return () => record("server-cleanup")
} })
`, resolveDir: projectRoot }, bundle: true, platform: "node", format: "esm",
    outfile: join(probeRoot, "index.js"), logLevel: "silent" })
  const probeSource = `${recordSource}
import assert from "node:assert/strict"
import { Plugin } from "@opencode/plugin/tui"
import { QuotaRpc } from "./shared/quota-rpc.ts"
const ids = ${JSON.stringify(pluginManifest.map((entry) => entry.id))}
const companion = "aamkye.opencode-tools-quota-service"
const retired = /(?:opencode-tools-(?:token-report|tokens|session-rename|session-title|lsp|todo)|tokens_(?:today|daily|weekly|monthly|all|session|session_all|between)|session-rename)/
export default Plugin.define({ id: "opencode-tools.smoke-probe", setup(context) {
  record("cli-setup", { version: context.app.version })
  const lifetime = new AbortController()
  const waitFor = async predicate => {
    while (!predicate()) {
      lifetime.signal.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  const task = (async () => {
    await waitFor(() => ids.every(id => receipts().some(r => r.kind === "setup" && r.id === id)))
    assert.deepEqual(receipts().filter(r => r.kind === "quota-fetch").map(r => r.provider).sort(),
      ["openai", "zai"], "Independent Home/Quota bundles must share initial provider requests")
    const location = context.location ?? context.data.location.default()
    const plugins = (await context.client.plugin.list({ location })).data
    record("plugins", { plugins })
    for (const id of [...ids, companion]) {
      const plugin = plugins.find(p => p.id === id)
      assert.ok(plugin, "Missing native plugin: " + id)
      assert.equal(plugin.state?.status, "active", JSON.stringify(plugin))
      assert.equal(plugin.features?.server, true, JSON.stringify(plugin))
      if (id !== companion) assert.equal(plugin.features?.tui, true, JSON.stringify(plugin))
    }
    assert.ok(plugins.every(p => p.state?.status !== "failed" && !retired.test(p.id ?? "")), JSON.stringify(plugins))
    const serverCommands = (await context.client.command.list({ location })).data.map(c => c.name)
    const cliCommands = context.keymap.commands().flatMap(c => [c.id, c.slash?.name].filter(Boolean))
    assert.ok([...serverCommands, ...cliCommands].every(c => !retired.test(c)))
    const quota = []
    for (const provider of ["openai", "zai", "opencode-go"]) {
      const result = await context.client.rpc(QuotaRpc).fetch({ provider }, { location, signal: lifetime.signal })
      assert.equal(result.configured, false, JSON.stringify(result))
      assert.equal(result.result.kind, "authentication-required")
      quota.push(result)
    }
    // Two independently acquired native handles, scoped mutations, both write
    // orders. This observes same-process synchronization, not cross-process CAS.
    const [a, updateA] = context.storage.store("sync-check", { initial: { parents: {} } })
    const [b, updateB] = context.storage.store("sync-check", { initial: { parents: {} } })
    await updateA(draft => { draft.parents.first = { child: 20 } })
    await updateB(draft => { draft.parents.second = { child: 30 } })
    await updateB(draft => { draft.parents.first.child = Math.min(draft.parents.first.child, 10) })
    await updateA(draft => { draft.parents.third = { child: 40 } })
    const expected = { parents: { first: { child: 10 }, second: { child: 30 }, third: { child: 40 } } }
    await waitFor(() => JSON.stringify(a) === JSON.stringify(expected) && JSON.stringify(b) === JSON.stringify(expected))
    record("storage", { scope: "two native handles in one TUI process", value: JSON.parse(JSON.stringify(a)) })
    await waitFor(() => receipts().some(r => r.kind === "render" && r.slot === "home.footer.status"))
    const session = await context.client.session.create({ location, title: "Isolated V2 plugin smoke" })
    context.ui.router.navigate({ type: "session", sessionID: session.id })
    await waitFor(() => ids.filter(id => !id.endsWith("-home")).every(id =>
      receipts().some(r => r.kind === "render" && r.id === id && r.slot === "sidebar.content")))
    record("checks", { plugins, serverCommands, cliCommands, quota, sessionID: session.id })
    writeFileSync(${JSON.stringify(join(root, "ready"))}, "ready")
  })().catch(error => {
    if (!lifetime.signal.aborted) {
      record("failure", { error: error.stack ?? String(error) })
      writeFileSync(${JSON.stringify(join(root, "failed"))}, "failed")
    }
  })
  return async () => { lifetime.abort(); await task; record("cli-cleanup") }
} })
`
  await build({ stdin: { contents: probeSource, resolveDir: projectRoot, sourcefile: "v2-smoke-probe.js" },
    bundle: true, platform: "node", format: "esm", external: ["@opencode/plugin/tui"],
    outfile: join(probeRoot, "tui.js"), logLevel: "silent" })
  const configPath = join(configRoot, "opencode.json")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.plugins.push("./smoke-probe")
  await writeFile(configPath, JSON.stringify(config))

  const python = String.raw`
import os, sys, pty, select, signal, time, fcntl, termios, struct, json
root, args = sys.argv[1], json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.execvpe("opencode", ["opencode"] + args, os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 200, 0, 0))
def terminate(sig, frame):
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
start, stopping, reason, status, forced = time.monotonic(), None, None, None, False
with open(os.path.join(root, "terminal.log"), "wb") as log:
    while status is None:
        if select.select([fd], [], [], 0.05)[0]:
            try: data = os.read(fd, 65536)
            except OSError: data = b""
            log.write(data)
            log.flush()
        now = time.monotonic()
        if stopping is None:
            for name in ["ready", "failed"]:
                if os.path.exists(os.path.join(root, name)): reason = name
            if now - start >= 30: reason = "deadline"
            if reason:
                stopping = now
                os.write(fd, b"\x03")
        elif now - stopping > 3:
            forced = True
            try: os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        elif now - stopping > 1:
            os.write(fd, b"\x03")
        done, result = os.waitpid(pid, os.WNOHANG)
        if done: status = result
os.close(fd)
with open(os.path.join(root, "pty.json"), "w") as out:
    json.dump({"pid": pid, "reason": reason, "exitCode": os.waitstatus_to_exitcode(status), "forced": forced}, out)
`
  driver = spawn("python3", ["-c", python, root, JSON.stringify(args)], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  let driverErrors = ""
  driver.stderr.on("data", (data) => { driverErrors += data })
  const code = await new Promise((resolve, reject) => {
    driver.once("error", reject)
    driver.once("close", resolve)
  })
  terminal = await readFile(join(root, "terminal.log"), "utf8").catch(() => "")
  assert.equal(code, 0, driverErrors)
  const pty = JSON.parse(await readFile(join(root, "pty.json"), "utf8"))
  const receipts = (await readFile(receiptPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)
  assert.deepEqual(receipts.filter((r) => r.kind === "failure"), [], `Native probe failed: ${JSON.stringify(receipts)}`)
  assert.equal(pty.reason, "ready", `PTY stopped before assertions completed: ${JSON.stringify({ pty, receipts })}`)
  assert.equal(pty.forced, false, "Host did not exit normally")
  assert.equal(pty.exitCode, 0)
  for (const kind of ["server-setup", "cli-setup", "server-cleanup", "cli-cleanup", "checks", "storage"]) {
    assert.equal(receipts.filter((r) => r.kind === kind).length, 1, `Missing or duplicate ${kind} receipt`)
  }
  for (const { id, key } of pluginManifest) {
    assert.equal(receipts.filter((r) => r.kind === "cleanup" && r.id === id).length, 1, `Missing cleanup: ${id}`)
    const slots = receipts.filter((r) => r.kind === "slot" && r.id === id).map((r) => r.slot)
    assert.deepEqual(slots, key === "home" ? ["home.footer.status"] : ["sidebar.content", "prompt.footer.status"])
  }
  assert.doesNotMatch(terminal, /message="(?:failed to (?:load|import) plugin|plugin operation failed)"|Cannot find (?:module|package)|SyntaxError|ReferenceError/i)
  console.log(JSON.stringify({ version, args, pty, receipts }, null, 2))
} catch (error) {
  console.error(error)
  console.error("Captured native startup/PTY output:\n" + terminal)
  process.exitCode = 1
} finally {
  if (driver && driver.exitCode === null && driver.signalCode === null) {
    driver.kill("SIGTERM")
    await new Promise((resolve) => driver.once("close", resolve))
  }
  await rm(root, { recursive: true, force: true })
}
