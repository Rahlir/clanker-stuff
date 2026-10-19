// Which SonarQube instances exist and which local repos map to which projects
// on them. Tokens never live here: each instance names the env var holding its
// token, so the file is safe to share.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function configPath(env = process.env) {
  if (env.SONARQUBE_CONFIG) return env.SONARQUBE_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pi-clanker", "sonarqube.json");
}

export async function loadConfig(path = configPath()) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT")
      throw new Error(
        `no config at ${path}. Copy the skill's assets/sonarqube.example.json there and fill in your instances and repos.`,
      );
    throw e;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${e.message}`);
  }
  return validateConfig(raw, path);
}

const INSTANCE_KEYS = new Set(["url", "tokenEnv"]);
const REPO_KEYS = new Set(["remote", "instance", "projects"]);
const PROJECT_KEYS = new Set(["key", "prefix"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Unknown keys are errors rather than ignored: a typo like "prefx" would
// otherwise silently map every issue to the wrong local path.
function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj))
    if (!allowed.has(k)) errors.push(`${where}: unknown key "${k}"`);
}

// Returns { source, instances: Map<name, instance>, repos: [...] } with
// remotes normalized and each repo's `instance` resolved to its object.
// All problems are reported at once so one edit fixes the file.
export function validateConfig(raw, source = "config") {
  if (!isObject(raw)) throw new Error(`${source}: top level must be an object`);
  const errors = [];
  unknownKeys(raw, new Set(["instances", "repos"]), "top level", errors);

  const instances = new Map();
  if (!isObject(raw.instances) || Object.keys(raw.instances).length === 0) {
    errors.push(`"instances" must be a non-empty object`);
  } else {
    for (const [name, inst] of Object.entries(raw.instances)) {
      const where = `instances.${name}`;
      if (!isObject(inst)) {
        errors.push(`${where} must be an object`);
        continue;
      }
      unknownKeys(inst, INSTANCE_KEYS, where, errors);
      if (typeof inst.url !== "string" || !/^https?:\/\/[^/]/.test(inst.url))
        errors.push(`${where}.url must be an http(s) URL`);
      if (typeof inst.tokenEnv !== "string" || !inst.tokenEnv)
        errors.push(`${where}.tokenEnv must name the env var holding the token`);
      instances.set(name, {
        name,
        url: String(inst.url).replace(/\/+$/, ""),
        tokenEnv: inst.tokenEnv,
      });
    }
  }

  const repos = [];
  if (raw.repos !== undefined && !Array.isArray(raw.repos))
    errors.push(`"repos" must be an array`);
  const seenRemotes = new Set();
  for (const [i, repo] of (Array.isArray(raw.repos) ? raw.repos : []).entries()) {
    const where = `repos[${i}]`;
    if (!isObject(repo)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    unknownKeys(repo, REPO_KEYS, where, errors);
    const remote = typeof repo.remote === "string" ? normalizeRemote(repo.remote) : null;
    if (!remote) errors.push(`${where}.remote must be a git remote URL or host/path`);
    else if (seenRemotes.has(remote)) errors.push(`${where}.remote "${remote}" is listed twice`);
    else seenRemotes.add(remote);
    const instance = instances.get(repo.instance);
    if (!instance) errors.push(`${where}.instance must be one of: ${[...instances.keys()].join(", ")}`);

    const projects = [];
    if (!Array.isArray(repo.projects) || repo.projects.length === 0) {
      errors.push(`${where}.projects must be a non-empty array`);
    } else {
      const seenKeys = new Set();
      for (const [j, p] of repo.projects.entries()) {
        const pw = `${where}.projects[${j}]`;
        if (!isObject(p)) {
          errors.push(`${pw} must be an object`);
          continue;
        }
        unknownKeys(p, PROJECT_KEYS, pw, errors);
        if (typeof p.key !== "string" || !p.key) errors.push(`${pw}.key must be a project key`);
        else if (seenKeys.has(p.key)) errors.push(`${pw}.key "${p.key}" is listed twice`);
        else seenKeys.add(p.key);
        // Required even when empty: "" (paths are repo-relative) has to be a
        // conscious choice, because a wrong prefix misplaces every issue.
        if (typeof p.prefix !== "string")
          errors.push(`${pw}.prefix must be a string ("" when Sonar paths are repo-relative)`);
        projects.push({
          key: p.key,
          name: shortName(String(p.key)),
          prefix: normalizePrefix(String(p.prefix ?? "")),
        });
      }
    }
    repos.push({ remote, name: remote?.split("/").pop(), instance, projects });
  }

  if (errors.length) throw new Error(`${source}:\n  - ${errors.join("\n  - ")}`);
  return { source, instances, repos };
}

// Display / --project name: the part after the last "." or ":", which strips
// both common key conventions (`team:service-a`, `team.SONAR.frontend`).
export function shortName(key) {
  return key.split(/[.:]/).pop() || key;
}

export function normalizePrefix(prefix) {
  return prefix.trim().replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

// Reduces every remote spelling to a lowercase `host/path` so SSH, HTTPS and
// the config's bare form compare equal. Returns null for local-path remotes,
// which carry no identity worth matching.
export function normalizeRemote(url) {
  const s = String(url).trim();
  let host;
  let path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    const bare = s.match(/^([^/\s:]+\.[^/\s:]+)\/(.+)$/);
    const m = scp ?? bare;
    if (!m) return null;
    host = m[1];
    path = m[2];
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || !path) return null;
  return `${host}/${path}`.toLowerCase();
}

export function findRepoByRemotes(config, remoteUrls) {
  const wanted = new Set(remoteUrls.map(normalizeRemote).filter(Boolean));
  return config.repos.find((r) => wanted.has(r.remote)) ?? null;
}
