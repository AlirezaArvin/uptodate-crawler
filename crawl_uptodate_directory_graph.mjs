#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://medilib.ir";
const ROOT_URL = `${BASE_URL}/uptodate/`;
const OUTPUT_PATH = path.resolve("uptodate_directory_graph.json");
const CHECKPOINT_PATH = path.resolve(".uptodate_directory_graph.checkpoint.json");
const USER_AGENT =
  "MediLibDirectoryGraphCrawler/1.0 (directory metadata only; no article bodies)";

const options = parseArgs(process.argv.slice(2));
const delayMs = options.delayMs ?? 500;
const concurrency = options.concurrency ?? 2;
const timeoutMs = options.timeoutMs ?? 30_000;

if (!Number.isInteger(delayMs) || delayMs < 250) {
  throw new Error("--delay-ms must be an integer of at least 250");
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error("--concurrency must be an integer from 1 to 4");
}

const startedAt = new Date().toISOString();
let interrupted = false;

const state = await loadOrCreateState();
const nodes = new Map(state.nodes.map((node) => [node.key, node]));
const edges = new Map(
  state.edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge]),
);
const visited = new Set(state.visited);
const queued = new Set([...state.visited, ...state.queue]);
const queue = [...state.queue];
let rawInternalLinkOccurrences = state.rawInternalLinkOccurrences ?? 0;
let pagesSinceCheckpoint = 0;

process.once("SIGINT", () => {
  interrupted = true;
});
process.once("SIGTERM", () => {
  interrupted = true;
});

await verifyRobotsPermission();

console.log(
  `Starting directory crawl: ${visited.size} complete, ${queue.length} queued, ` +
    `${concurrency} workers, ${delayMs} ms minimum stagger.`,
);

while (queue.length > 0 && !interrupted) {
  const batch = queue.splice(0, concurrency);
  const results = await Promise.all(
    batch.map(async (key, index) => {
      if (index > 0) await sleep(index * delayMs);
      return crawlDirectory(key);
    }),
  );

  for (const result of results) {
    if (result.ok) {
      visited.add(result.key);
      pagesSinceCheckpoint += 1;
      for (const discoveredKey of result.discoveredDirectories) {
        if (!queued.has(discoveredKey)) {
          queued.add(discoveredKey);
          queue.push(discoveredKey);
        }
      }
    } else {
      const node = nodes.get(result.key);
      node.fetch_error = result.error;
      node.fetch_attempts = (node.fetch_attempts ?? 0) + 1;
      if (node.fetch_attempts < 3) {
        queue.push(result.key);
      } else {
        visited.add(result.key);
      }
    }
  }

  if (pagesSinceCheckpoint >= 20 || queue.length === 0) {
    await saveCheckpoint();
    pagesSinceCheckpoint = 0;
  }

  if (visited.size % 20 < concurrency) {
    console.log(
      `Progress: ${visited.size} directory pages, ${queue.length} queued, ` +
        `${nodes.size} nodes, ${edges.size} edges.`,
    );
  }
}

if (interrupted) {
  await saveCheckpoint();
  console.log("Interrupted safely; checkpoint saved.");
  process.exitCode = 130;
} else {
  const graph = buildFinalGraph();
  await writeJsonAtomic(OUTPUT_PATH, graph);
  await fs.rm(CHECKPOINT_PATH, { force: true });
  await fs.rm(`${CHECKPOINT_PATH}.tmp`, { force: true });
  console.log(`Complete: ${OUTPUT_PATH}`);
  console.log(JSON.stringify(graph.stats, null, 2));
  if (graph.crawl.failed_directory_pages.length > 0) process.exitCode = 2;
}

async function crawlDirectory(key) {
  const node = nodes.get(key);
  try {
    const response = await fetchWithRetry(node.url);
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== BASE_URL || !isDirectoryPath(finalUrl.pathname)) {
      throw new Error(`Unexpected redirect to ${response.url}`);
    }

    const html = await response.text();
    const anchors = extractAnchors(html, response.url);
    const discoveredDirectories = [];
    let position = 0;

    for (const anchor of anchors) {
      const target = classifyTarget(anchor.url);
      if (!target || target.key === key) continue;

      rawInternalLinkOccurrences += 1;
      const title = anchor.title || fallbackTitle(target);
      ensureNode(target, title);
      addEdge(key, target.key, position);
      position += 1;

      if (target.type === "directory") {
        discoveredDirectories.push(target.key);
      }
    }

    node.fetched = true;
    node.fetch_error = undefined;
    node.outgoing_unique_edges = [...edges.values()].filter(
      (edge) => edge.from === key,
    ).length;
    node.raw_internal_link_occurrences = position;
    return { ok: true, key, discoveredDirectories };
  } catch (error) {
    return { ok: false, key, error: String(error?.message ?? error) };
  }
}

function ensureNode(target, title) {
  const existing = nodes.get(target.key);
  if (!existing) {
    nodes.set(target.key, {
      key: target.key,
      type: target.type,
      id: target.id,
      title,
      url: target.url,
      ...(target.type === "directory" ? { fetched: false } : {}),
    });
    return;
  }

  if (title && existing.title !== title) {
    const aliases = new Set(existing.aliases ?? []);
    aliases.add(title);
    aliases.delete(existing.title);
    if (aliases.size > 0) existing.aliases = [...aliases].sort();
  }
}

function addEdge(from, to, position) {
  const edgeKey = `${from}\u0000${to}`;
  const existing = edges.get(edgeKey);
  if (existing) {
    existing.occurrences += 1;
    existing.positions.push(position);
    return;
  }
  edges.set(edgeKey, {
    from,
    to,
    relation: "contains",
    occurrences: 1,
    positions: [position],
  });
}

function classifyTarget(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (url.origin !== BASE_URL) return null;

  const directory = url.pathname.match(/^\/uptodate\/(\d+)\/?$/i);
  if (directory) {
    const id = Number(directory[1]);
    return {
      key: `directory:${id}`,
      type: "directory",
      id,
      url: `${BASE_URL}/uptodate/${id}`,
    };
  }

  const article = url.pathname.match(/^\/uptodate\/show\/(\d+)\/?$/i);
  if (article) {
    const id = Number(article[1]);
    return {
      key: `article:${id}`,
      type: "article",
      id,
      url: `${BASE_URL}/uptodate/show/${id}`,
    };
  }

  const special = url.pathname.match(
    /^\/uptodate\/show\/(table_of_contents_-1_\d+)\/?$/i,
  );
  if (special) {
    return {
      key: `special:${special[1]}`,
      type: "special_table_of_contents",
      id: special[1],
      url: `${BASE_URL}/uptodate/show/${special[1]}`,
    };
  }

  return null;
}

function extractAnchors(html, baseUrl) {
  const results = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html)) !== null) {
    const attributes = match[1];
    const hrefMatch = attributes.match(
      /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
    );
    if (!hrefMatch) continue;

    const rawHref = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "";
    let resolved;
    try {
      resolved = new URL(decodeEntities(rawHref), baseUrl).href;
    } catch {
      continue;
    }

    results.push({
      url: resolved,
      title: cleanText(match[2]),
    });
  }

  return results;
}

function cleanText(value) {
  return decodeEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    rsquo: "’",
    lsquo: "‘",
    ndash: "–",
    mdash: "—",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const digits = entity.slice(hex ? 2 : 1);
      const codePoint = Number.parseInt(digits, hex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.8",
          "User-Agent": USER_AGENT,
        },
      });
      clearTimeout(timer);
      if (response.ok) return response;

      const retryAfter = Number(response.headers.get("retry-after"));
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      lastError = new Error(`HTTP ${response.status} for ${url}`);
      await sleep(
        Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * attempt ** 2,
      );
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < 4) await sleep(1000 * attempt ** 2);
    }
  }
  throw lastError;
}

async function verifyRobotsPermission() {
  const response = await fetchWithRetry(`${BASE_URL}/robots.txt`);
  const text = await response.text();
  const groups = parseRobots(text);
  const wildcard = groups.get("*") ?? [];
  const disallowed = wildcard
    .filter((rule) => rule.type === "disallow" && rule.path)
    .some((rule) => ROOT_URL.startsWith(new URL(rule.path, BASE_URL).href));
  const explicitlyAllowed = wildcard
    .filter((rule) => rule.type === "allow" && rule.path)
    .some((rule) => ROOT_URL.startsWith(new URL(rule.path, BASE_URL).href));
  if (disallowed && !explicitlyAllowed) {
    throw new Error("robots.txt disallows crawling /uptodate/");
  }
}

function parseRobots(text) {
  const groups = new Map();
  let agents = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line.includes(":")) continue;
    const [rawField, ...rest] = line.split(":");
    const field = rawField.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (field === "user-agent") {
      agents = [value.toLowerCase()];
      if (!groups.has(agents[0])) groups.set(agents[0], []);
    } else if ((field === "allow" || field === "disallow") && agents.length) {
      for (const agent of agents) {
        groups.get(agent).push({ type: field, path: value });
      }
    }
  }
  return groups;
}

async function loadOrCreateState() {
  try {
    const checkpoint = JSON.parse(await fs.readFile(CHECKPOINT_PATH, "utf8"));
    if (checkpoint.version !== 1 || checkpoint.root_url !== ROOT_URL) {
      throw new Error("Checkpoint format or root URL does not match");
    }
    console.log(`Resuming checkpoint from ${checkpoint.updated_at}.`);
    return checkpoint;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      version: 1,
      root_url: ROOT_URL,
      started_at: startedAt,
      updated_at: startedAt,
      queue: ["directory:root"],
      visited: [],
      nodes: [
        {
          key: "directory:root",
          type: "directory",
          id: null,
          title: "UpToDate",
          url: ROOT_URL,
          fetched: false,
        },
      ],
      edges: [],
      rawInternalLinkOccurrences: 0,
    };
  }
}

async function saveCheckpoint() {
  const checkpoint = {
    version: 1,
    root_url: ROOT_URL,
    started_at: state.started_at,
    updated_at: new Date().toISOString(),
    queue,
    visited: [...visited],
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    rawInternalLinkOccurrences,
  };
  await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);
}

function buildFinalGraph() {
  const sortedNodes = [...nodes.values()]
    .map((node) => {
      const copy = { ...node };
      delete copy.fetch_attempts;
      return copy;
    })
    .sort(compareNodes);
  const sortedEdges = [...edges.values()].sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.positions[0] - b.positions[0] ||
      a.to.localeCompare(b.to),
  );
  const failed = sortedNodes
    .filter((node) => node.type === "directory" && node.fetch_error)
    .map((node) => ({ key: node.key, url: node.url, error: node.fetch_error }));
  const counts = countBy(sortedNodes, (node) => node.type);

  return {
    schema_version: 1,
    source: {
      name: "MediLib UpToDate",
      root_url: ROOT_URL,
      scope:
        "Directory hierarchy and directory-to-leaf membership only; article bodies were not fetched.",
    },
    generated_at: new Date().toISOString(),
    roots: ["directory:root"],
    stats: {
      nodes: sortedNodes.length,
      directory_nodes: counts.directory ?? 0,
      article_nodes: counts.article ?? 0,
      special_table_of_contents_nodes:
        counts.special_table_of_contents ?? 0,
      edges: sortedEdges.length,
      raw_internal_link_occurrences: rawInternalLinkOccurrences,
      duplicate_edge_occurrences:
        rawInternalLinkOccurrences - sortedEdges.length,
      directory_pages_fetched: sortedNodes.filter(
        (node) => node.type === "directory" && node.fetched,
      ).length,
    },
    crawl: {
      started_at: state.started_at,
      completed_at: new Date().toISOString(),
      delay_ms: delayMs,
      concurrency,
      robots_txt_checked: true,
      failed_directory_pages: failed,
      status: failed.length === 0 ? "complete" : "complete_with_errors",
    },
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}

function compareNodes(a, b) {
  const order = {
    directory: 0,
    article: 1,
    special_table_of_contents: 2,
  };
  const typeOrder = order[a.type] - order[b.type];
  if (typeOrder !== 0) return typeOrder;
  if (typeof a.id === "number" && typeof b.id === "number") return a.id - b.id;
  return String(a.id).localeCompare(String(b.id));
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function isDirectoryPath(pathname) {
  return /^\/uptodate\/?$/i.test(pathname) || /^\/uptodate\/\d+\/?$/i.test(pathname);
}

function fallbackTitle(target) {
  if (target.type === "directory") return `Directory ${target.id}`;
  if (target.type === "article") return `Article ${target.id}`;
  return target.id;
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rm(filePath, { force: true });
  await fs.rename(temporaryPath, filePath);
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--delay-ms") result.delayMs = Number(args[++index]);
    else if (arg === "--concurrency") result.concurrency = Number(args[++index]);
    else if (arg === "--timeout-ms") result.timeoutMs = Number(args[++index]);
    else throw new Error(`Unknown argument: ${arg}${next ? ` (next: ${next})` : ""}`);
  }
  return result;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
