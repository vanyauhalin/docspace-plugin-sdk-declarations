#!/usr/bin/env node
// @ts-check

/**
 * @typedef {import("typedoc").TypeDocOptions} TypeDocOptions
 */

import {spawn} from "node:child_process"
import {Console as NodeConsole} from "node:console"
import {mkdir, mkdtemp, writeFile, rm, rmdir} from "node:fs/promises"
import {existsSync} from "node:fs"
import {tmpdir} from "node:os"
import {join, relative} from "node:path"
import {argv, cwd, env, stderr, stdout} from "node:process"
import {fileURLToPath} from "node:url"
import sade from "sade"
import {Application, JSONOutput} from "typedoc"
import pack from "./package.json" with {type: "json"}

/**
 * @typedef {Object} Config
 * @property {ConfigMeta} meta
 * @property {ConfigSource[]} sources
 */

/**
 * @typedef {Object} ConfigMeta
 * @property {string} owner
 * @property {string} name
 * @property {string} branch
 * @property {string} file
 */

/**
 * @typedef {Object} ConfigSource
 * @property {string} owner
 * @property {string} name
 * @property {string} branch
 * @property {string} entryPoint
 */

/** @type {Config} */
const config = {
  meta: {
    owner: "vanyauhalin",
    name: "docspace-sdk-js",
    branch: "dist",
    file: "meta.json"
  },
  sources: [
    // {
    //   owner: "onlyoffice",
    //   name: "docspace-sdk-js",
    //   branch: "master",
    //   entryPoint: "src/main.ts"
    // },
    {
      owner: "onlyoffice",
      name: "docspace-sdk-js",
      branch: "develop",
      entryPoint: "src/main.ts"
    }
  ]
}

/**
 * @typedef {Partial<Record<string, MetaBranch>>} Meta
 */

/**
 * @typedef {Partial<Record<string, string>>} MetaBranch
 */

/**
 * @typedef {Object} BuildOptions
 * @property {string} force
 */

const console = createConsole()
main()

/**
 * @returns {void}
 */
function main() {
  sade("./makefile.js")
    .command("build")
    .option("--force", "Force build", false)
    .action(async (opts) => {
      if (isForceBuild()) {
        opts.force = true
      }
      await build(opts)
    })
    .parse(argv)
}

/**
 * @returns {boolean}
 */
function isForceBuild() {
  return env.MAKEFILE_BUILD_FORCE === "true"
}

/**
 * @param {BuildOptions} opts
 * @returns {Promise<void>}
 */
async function build(opts) {
  const latest = await fetchLatestMeta(config)

  if (!opts.force) {
    const current = await fetchCurrentMeta(config)
    if (deepEqual(current, latest)) {
      console.info("No updates")
      return
    }
  }

  const rd = rootDir()
  const dd = distDir(rd)
  if (!existsSync(dd)) {
    await mkdir(dd)
  }

  const td = await createTempDir()
  await Promise.all(config.sources.map(async (s) => {
    const b = latest[s.branch]
    if (b === undefined) {
      throw new Error(`Branch ${s.branch} is missing`)
    }

    const h = b[s.name]
    if (h === undefined) {
      throw new Error(`Commit SHA for ${s.name} is missing`)
    }

    const st = join(td, s.branch)
    await mkdir(st)
    await cloneRepo(st, s)

    const sd = join(dd, s.branch)
    if (!existsSync(sd)) {
      await mkdir(sd)
    }

    let o = await generateObject({
      entryPoints: [join(st, s.entryPoint)],
      tsconfig: tsconfigFile(st),
      readme: "none"
    })

    const r = relative(rd, st)
    modifyObject(r, o, s, h)

    const f = join(sd, `${s.name}.json`)
    const c = JSON.stringify(o, null, 2)
    await writeFile(f, c)

    await rf(st)
  }))

  await rmdir(td)
  await writeMeta(config, dd, latest)
}

/**
 * @param {Config} c
 * @returns {Promise<Meta>}
 */
async function fetchLatestMeta(c) {
  /** @type {Meta} */
  const m = {}
  await Promise.all(c.sources.map(async (s) => {
    let b = m[s.branch]
    if (b === undefined) {
      b = {}
      m[s.branch] = b
    }
    b[s.name] = await fetchSHA(s)
  }))
  return m
}

/**
 * @param {Config} c
 * @returns {Promise<Meta>}
 */
async function fetchCurrentMeta(c) {
  const u = `https://raw.githubusercontent.com/${c.meta.owner}/${c.meta.name}/${c.meta.branch}/${c.meta.file}`
  const r = await fetch(u)
  if (r.status !== 200) {
    return {}
  }
  return r.json()
}

/**
 * @param {ConfigSource} s
 * @returns {Promise<string>}
 */
async function fetchSHA(s) {
  const u = `https://api.github.com/repos/${s.owner}/${s.name}/branches/${s.branch}`
  const r = await fetch(u)
  if (r.status !== 200) {
    throw new Error(`Failed to fetch commit SHA for ${s.name}`)
  }
  const j = await r.json()
  return j.commit.sha
}

/**
 * @param {string} d
 * @param {ConfigSource} s
 * @returns {Promise<void>}
 */
function cloneRepo(d, s) {
  return new Promise((res, rej) => {
    const g = spawn("git", [
      "clone",
      "--progress",
      "--depth", "1",
      "--branch", s.branch,
      "--single-branch",
      `https://github.com/${s.owner}/${s.name}.git`,
      d
    ])
    g.on("close", res)
    g.on("error", rej)
  })
}

/**
 * @param {string} d
 * @returns {string}
 */
function tsconfigFile(d) {
  return join(d, "tsconfig.json")
}

/**
 * @param {Partial<TypeDocOptions>} opts
 * @returns {Promise<JSONOutput.ProjectReflection>}
 */
async function generateObject(opts) {
  const a = await Application.bootstrapWithPlugins(opts)
  const p = await a.convert()
  if (p === undefined) {
    throw new Error("Project is missing")
  }
  return a.serializer.projectToObject(p, cwd())
}

/**
 * @param {string} p
 * @param {JSONOutput.ProjectReflection} o
 * @param {ConfigSource} s
 * @param {string} h
 * @returns {void}
 */
function modifyObject(p, o, s, h) {
  for (const k of Object.keys(o.symbolIdMap)) {
    const v = o.symbolIdMap[k]
    v.sourceFileName = v.sourceFileName.replace(p, "")
    v.sourceFileName = sourceReference(s, v.sourceFileName, h)
  }
}

/**
 * @param {ConfigSource} s
 * @param {string} p
 * @param {string} h
 * @returns {string}
 */
function sourceReference(s, p, h) {
  return `https://api.github.com/repos/${s.owner}/${s.name}/contents${p}?ref=${h}`
}

/**
 * @param {Config} c
 * @param {string} d
 * @param {Meta} m
 * @returns {Promise<void>}
 */
async function writeMeta(c, d, m) {
  const f = join(d, c.meta.file)
  await writeFile(f, JSON.stringify(m, undefined, 2))
}

/**
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (typeof a !== typeof b) {
    return false
  }

  if (typeof a === "object") {
    const m = Object.keys(a)
    const n = Object.keys(b)
    if (m.length !== n.length) {
      return false
    }

    for (const k of m) {
      const x = a[k]
      const y = b[k]
      if (!deepEqual(x, y)) {
        return false
      }
    }

    return true
  }

  if (a !== b) {
    return false
  }

  return true
}

/**
 * @returns {string}
 */
function rootDir() {
  const u = new URL(".", import.meta.url)
  return fileURLToPath(u)
}

/**
 * @param {string} r
 * @returns {string}
 */
function distDir(r) {
  return join(r, "dist")
}

/**
 * @returns {Promise<string>}
 */
function createTempDir() {
  const d = join(tmpdir(), pack.name)
  return mkdtemp(`${d}-`)
}

/**
 * @param {string} p
 * @returns {Promise<void>}
 */
async function rf(p) {
  await rm(p, {recursive: true, force: true})
}

/**
 * @returns {Console}
 */
function createConsole() {
  // This exists only to allow the class to be placed at the end of the file.
  class Console extends NodeConsole {
    /**
     * @param  {...any} data
     * @returns {void}
     */
    info(...data) {
      super.info("info:", ...data)
    }

    /**
     * @param  {...any} data
     * @returns {void}
     */
    warn(...data) {
      super.warn("warn:", ...data)
    }
  }

  return new Console(stdout, stderr)
}
