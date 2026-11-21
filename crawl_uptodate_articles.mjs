#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const BASE_URL = "https://medilib.ir";
const ROOT_URL = `${BASE_URL}/uptodate/`;
const DEFAULT_GRAPH = path.resolve("uptodate_directory_graph.json");
const DEFAULT_PROFILE = path.resolve(".medilib-browser-profile");
const USER_AGENT =
  "MediLibArticleCrawler/1.0 (authenticated personal research; one page at a time)";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  await exitCleanly(0);
}

validateOptions(options);

const graph = JSON.parse(await fs.readFile(options.graphPath, "utf8"));
const selection = resolveTargets(graph, options);
let targets = selection.targets;
if (options.maxArticles !== undefined) {
  targets = targets.slice(0, options.maxArticles);
}

if (targets.length === 0) {
  throw new Error("The selected directory/subtree contains no article nodes.");
}

if (options.listTargets) {
  console.log(
    JSON.stringify(
      {
        selection: selection.description,
        article_count: targets.length,
        articles: targets,
      },
      null,
      2,
    ),
  );
  await exitCleanly(0);
}

const outputDir = options.outputDir ?? defaultOutputDir(selection);
if (options.legacyOutputUsed) {
  console.warn(
    `--output now selects an output directory; using ${outputDir}. ` +
      "Prefer --output-dir in future commands.",
  );
}
const { state, manifestPath, articlesDir } = await loadOrCreateState(
  outputDir,
  selection,
  targets,
  options,
);
await saveManifest(manifestPath, state, targets, options, false);
const completedIds = new Set(
  state.articles.map((article) => Number(article.id)),
);
const targetPositions = new Map(
  targets.map((target, index) => [target.id, index]),
);
const pendingTargets = targets.filter((target) => !completedIds.has(target.id));

console.log(`Selection: ${selection.description}`);
console.log(`Output directory: ${outputDir}`);
console.log(`Manifest: ${manifestPath}`);
console.log(
  `Progress: ${completedIds.size}/${targets.length} complete, ` +
    `${pendingTargets.length} pending.`,
);

if (pendingTargets.length === 0 && !options.loginOnly) {
  console.log("Complete: every selected article file is already present.");
  await exitCleanly(0);
}

await verifyRobotsPermission();

let playwright;
try {
  playwright = await import("playwright");
} catch (error) {
  throw new Error(
    "Playwright is not installed. Run `npm install` in this directory first. " +
      `Original error: ${error.message}`,
  );
}

await fs.mkdir(options.profilePath, { recursive: true });
const { context, browserDescription } = await launchPersistentBrowser(
  playwright.chromium,
  options,
);
console.log(`Browser: ${browserDescription}`);

const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(options.timeoutMs);
page.setDefaultNavigationTimeout(options.timeoutMs);

let stopRequested = false;
let contextClosed = false;
let articlesSinceManifest = 0;
const requestStop = () => {
  if (!stopRequested) {
    stopRequested = true;
    console.log("\nStopping after the current article; progress will be preserved.");
  }
};
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

try {
  if (options.loginOnly) {
    await ensureAuthenticated(page, targets[0], options, true);
    console.log(
      `Authentication profile is ready at ${options.profilePath}. ` +
        "Run the crawler again without --login-only.",
    );
  } else {
    for (let index = 0; index < pendingTargets.length; index += 1) {
      if (stopRequested) break;

      const target = pendingTargets[index];
      const overallPosition = targetPositions.get(target.id) + 1;
      console.log(
        `[${overallPosition}/${targets.length}] ${target.id} — ${target.expected_title}`,
      );

      try {
        const article = await crawlArticleWithRetry(page, target, options);
        const articlePath = path.join(articlesDir, `${target.id}.json`);
        await writeArticleFile(articlePath, article);
        upsertArticleSummary(state, article, outputDir, articlePath);
        removeFailure(state, target.id);
        articlesSinceManifest += 1;
        console.log(
          `  saved articles/${target.id}.json — ` +
            `${article.word_count.toLocaleString()} words, ` +
            `${article.references.length} references`,
        );
      } catch (error) {
        upsertFailure(state, target, error);
        console.error(`  failed: ${error.message}`);
        await saveManifest(manifestPath, state, targets, options, stopRequested);
        articlesSinceManifest = 0;
      }

      if (
        articlesSinceManifest >= options.checkpointEvery ||
        index === pendingTargets.length - 1 ||
        stopRequested
      ) {
        await saveManifest(manifestPath, state, targets, options, stopRequested);
        articlesSinceManifest = 0;
      }

      if (index < pendingTargets.length - 1 && !stopRequested) {
        await sleep(options.delayMs);
      }
    }

    await saveManifest(manifestPath, state, targets, options, stopRequested);
    const complete = state.articles.length === targets.length;
    console.log(
      complete
        ? `Complete: ${state.articles.length}/${targets.length} articles saved.`
        : `Stopped: ${state.articles.length}/${targets.length} articles saved; rerun to resume.`,
    );
    if (!complete && !stopRequested) process.exitCode = 2;
    if (stopRequested) process.exitCode = 130;
  }
} finally {
  if (!contextClosed) {
    contextClosed = true;
    await context.close().catch(() => {});
  }
}

async function crawlArticleWithRetry(pageHandle, target, runOptions) {
  let lastError;

  for (let attempt = 1; attempt <= runOptions.retries; attempt += 1) {
    try {
      await ensureAuthenticated(pageHandle, target, runOptions, false);
      const extracted = await pageHandle.evaluate(extractArticleFromPage);

      if (!extracted.title || extracted.blocks.length === 0) {
        throw new Error("The page loaded, but the article body was empty.");
      }

      return {
        id: target.id,
        expected_title: target.expected_title,
        url: target.url,
        final_url: pageHandle.url(),
        page_title: await pageHandle.title(),
        extracted_at: new Date().toISOString(),
        title_matches_expected:
          normalizeTitle(extracted.title) === normalizeTitle(target.expected_title),
        ...extracted,
      };
    } catch (error) {
      lastError = error;
      if (attempt < runOptions.retries) {
        const waitMs = Math.max(runOptions.delayMs, 1500 * attempt ** 2);
        console.warn(`  retry ${attempt}/${runOptions.retries - 1} in ${waitMs} ms`);
        await sleep(waitMs);
      }
    }
  }

  throw lastError;
}

async function ensureAuthenticated(pageHandle, target, runOptions, forcePrompt) {
  const response = await pageHandle.goto(target.url, {
    waitUntil: "domcontentloaded",
    timeout: runOptions.timeoutMs,
  });

  if (response && [429, 500, 502, 503, 504].includes(response.status())) {
    throw new Error(`HTTP ${response.status()} for ${target.url}`);
  }

  await pageHandle.waitForTimeout(600);
  const access = await inspectAccess(pageHandle);

  if (access.ready && !forcePrompt) return;
  if (runOptions.headless) {
    throw new Error(
      "Authentication is required. Run once without --headless (or use --login-only) " +
        "so you can sign in in the opened browser.",
    );
  }

  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log("\nSign in in the opened browser window.");
    console.log("Wait until the requested article is visible in that browser.");
    while (true) {
      const answer = await prompt.question(
        "Return to this PowerShell window and press Enter to verify login " +
          "(or type q to stop): ",
      );
      if (answer.trim().toLowerCase() === "q") {
        throw new Error("Authentication was cancelled by the user.");
      }

      console.log("Login confirmation received; verifying authenticated access...");
      await pageHandle.goto(target.url, {
        waitUntil: "domcontentloaded",
        timeout: runOptions.timeoutMs,
      });
      await pageHandle.waitForTimeout(1000);

      const afterLogin = await inspectAccess(pageHandle);
      if (afterLogin.ready) {
        console.log("Authentication verified. Starting the crawl.");
        return;
      }

      console.warn(
        `Authentication was not detected (current URL: ${pageHandle.url()}).`,
      );
      console.warn(
        "Finish signing in in the browser, then return here and try again.",
      );
    }
  } finally {
    prompt.close();
  }
}

async function inspectAccess(pageHandle) {
  const currentUrl = pageHandle.url();
  const redirectedToAuth = /\/(login|NoAccess)(?:\/|\?|$)/i.test(currentUrl);
  const articleLoaded = await pageHandle
    .evaluate(() => {
      const title =
        document.querySelector("#topicTitle") ??
        document.querySelector("#print-area h1, h1");
      const body =
        document.querySelector("#topicText") ??
        document.querySelector("#topicContent") ??
        document.querySelector("#print-area .utdArticleSection.utdStyle");
      const titleText = (title?.textContent ?? "").trim();
      const bodyText = (body?.textContent ?? "").trim();
      return titleText.length > 0 && bodyText.length >= 100;
    })
    .catch(() => false);
  return {
    ready: articleLoaded && !redirectedToAuth,
    redirectedToAuth,
  };
}

function extractArticleFromPage() {
  const clean = (value) =>
    String(value ?? "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const absoluteUrl = (href) => {
    try {
      return new URL(href, document.baseURI).href;
    } catch {
      return null;
    }
  };

  const uniqueLinks = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.url}\u0000${item.title}`;
      if (!item.url || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const title = clean(
    document.querySelector("#topicTitle")?.textContent ||
      document.querySelector("#print-area h1, h1")?.textContent,
  );
  const topicText =
    document.querySelector("#topicText") ??
    document.querySelector("#topicContent") ??
    document.querySelector("#print-area .utdArticleSection.utdStyle");
  if (!topicText) throw new Error("The article content container was not found.");

  const contributorMap = {};
  for (const term of document.querySelectorAll("#topicContributors dt")) {
    const label = clean(term.textContent).replace(/:$/, "");
    let key = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    if (key === "author") key = "authors";
    if (key === "section_editor") key = "section_editors";
    if (key === "deputy_editor") key = "deputy_editors";
    const names = [];
    let sibling = term.nextElementSibling;
    while (sibling && sibling.tagName.toLowerCase() === "dd") {
      const linkedNames = [...sibling.querySelectorAll("a")]
        .map((anchor) => clean(anchor.textContent))
        .filter(Boolean);
      if (linkedNames.length > 0) names.push(...linkedNames);
      else {
        const value = clean(sibling.textContent);
        if (value) names.push(value);
      }
      sibling = sibling.nextElementSibling;
    }
    if (key && names.length > 0) contributorMap[key] = [...new Set(names)];
  }

  const blocks = [];
  for (const paragraph of topicText.querySelectorAll("p")) {
    const text = clean(paragraph.innerText || paragraph.textContent);
    if (!text) continue;
    const heading = paragraph.querySelector('[role="heading"]');
    if (heading || paragraph.classList.contains("headingAnchor")) {
      const rawLevel = Number(heading?.getAttribute("aria-level"));
      blocks.push({
        type: "heading",
        level: Number.isInteger(rawLevel) && rawLevel > 0 ? rawLevel : 2,
        text,
      });
    } else {
      blocks.push({ type: "paragraph", text });
    }
  }

  const plainText = blocks.map((block) => block.text).join("\n\n");
  const wordCount = plainText.match(/\S+/g)?.length ?? 0;

  const references = [...document.querySelectorAll("#references li")]
    .map((item) => clean(item.innerText || item.textContent))
    .filter(Boolean);

  const graphics = [];
  const relatedTopicLinks = [];
  for (const anchor of topicText.querySelectorAll("a[href]")) {
    const url = absoluteUrl(anchor.getAttribute("href"));
    const linkTitle = clean(anchor.innerText || anchor.textContent);
    if (!url || !linkTitle || !/^https:\/\/medilib\.ir\/uptodate\/show\//i.test(url)) {
      continue;
    }

    const singleId = new URL(url).pathname.match(/^\/uptodate\/show\/(\d+)\/?$/i)?.[1];
    const item = {
      id: singleId ? Number(singleId) : null,
      title: linkTitle,
      url,
    };
    if (/^(table|figure|algorithm|image|picture)\b/i.test(linkTitle)) {
      graphics.push(item);
    } else {
      relatedTopicLinks.push(item);
    }
  }

  const reviewText = clean(
    document.querySelector("#literatureReviewDate")?.innerText ||
      document.querySelector("#literatureReviewDate")?.textContent,
  );
  const reviewMatch = reviewText.match(
    /Literature review current through:\s*(.*?)(?=\.?\s*This topic last updated:|$)/i,
  );
  const updatedMatch = reviewText.match(/This topic last updated:\s*(.*?)\.?$/i);

  return {
    title,
    contributors: contributorMap,
    literature_review_current_through: clean(reviewMatch?.[1]) || null,
    topic_last_updated: clean(updatedMatch?.[1]) || null,
    version:
      clean(document.querySelector("#topicVersionRevision")?.textContent) || null,
    blocks,
    plain_text: plainText,
    word_count: wordCount,
    character_count: plainText.length,
    references,
    graphics: uniqueLinks(graphics),
    related_topic_links: uniqueLinks(relatedTopicLinks),
  };
}

async function launchPersistentBrowser(chromium, runOptions) {
  const common = {
    headless: runOptions.headless,
    viewport: runOptions.headless ? { width: 1440, height: 1000 } : null,
    acceptDownloads: false,
  };

  const candidates =
    runOptions.browserChannel === "auto"
      ? [
          { channel: "chrome", label: "Google Chrome" },
          { channel: "msedge", label: "Microsoft Edge" },
          { channel: undefined, label: "Playwright Chromium" },
        ]
      : [
          {
            channel:
              runOptions.browserChannel === "chromium"
                ? undefined
                : runOptions.browserChannel,
            label: runOptions.browserChannel,
          },
        ];

  const errors = [];
  for (const candidate of candidates) {
    try {
      const context = await chromium.launchPersistentContext(
        runOptions.profilePath,
        {
          ...common,
          ...(candidate.channel ? { channel: candidate.channel } : {}),
        },
      );
      return { context, browserDescription: candidate.label };
    } catch (error) {
      errors.push(`${candidate.label}: ${error.message}`);
    }
  }

  throw new Error(
    "No supported browser could be launched. Install Chrome/Edge, or run " +
      "`npx playwright install chromium`. Details:\n" +
      errors.join("\n"),
  );
}

function resolveTargets(graphValue, runOptions) {
  const nodeByKey = new Map(graphValue.nodes.map((node) => [node.key, node]));
  const outgoing = new Map();
  for (const edge of graphValue.edges) {
    const items = outgoing.get(edge.from) ?? [];
    items.push(edge.to);
    outgoing.set(edge.from, items);
  }

  if (runOptions.articleIds.length > 0) {
    const targetsForIds = runOptions.articleIds.map((id) => {
      const node = nodeByKey.get(`article:${id}`);
      if (!node) throw new Error(`Article ${id} is not present in the graph.`);
      return toTarget(node);
    });
    return {
      description: `explicit article IDs (${targetsForIds.length})`,
      key: `ids_${runOptions.articleIds.join("_")}`,
      roots: [],
      targets: dedupeTargets(targetsForIds),
    };
  }

  let rootKey;
  let description;
  if (runOptions.all) {
    rootKey = "directory:root";
    description = "all articles reachable from the UpToDate root";
  } else {
    rootKey = `directory:${runOptions.directoryId}`;
    const directory = nodeByKey.get(rootKey);
    if (!directory) {
      throw new Error(`Directory ${runOptions.directoryId} is not present in the graph.`);
    }
    description = `${directory.title} (directory ${directory.id})`;
  }

  const targetsForDirectory = [];
  const visitedDirectories = new Set();
  const queue = [rootKey];

  while (queue.length > 0) {
    const directoryKey = queue.shift();
    if (visitedDirectories.has(directoryKey)) continue;
    visitedDirectories.add(directoryKey);

    for (const childKey of outgoing.get(directoryKey) ?? []) {
      const node = nodeByKey.get(childKey);
      if (!node) continue;
      if (node.type === "article") targetsForDirectory.push(toTarget(node));
      else if (node.type === "directory" && !runOptions.directOnly) queue.push(childKey);
    }
  }

  return {
    description:
      description + (runOptions.directOnly ? " (direct articles only)" : " (recursive)"),
    key: runOptions.all ? "all" : `directory_${runOptions.directoryId}`,
    roots: [rootKey],
    targets: dedupeTargets(targetsForDirectory),
  };
}

function toTarget(node) {
  return {
    id: Number(node.id),
    expected_title: node.title,
    url: node.url,
  };
}

function dedupeTargets(items) {
  const byId = new Map();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

async function loadOrCreateState(
  directoryPath,
  selectionValue,
  targetItems,
  runOptions,
) {
  const now = new Date().toISOString();
  const manifestPath = path.join(directoryPath, "manifest.json");
  const articlesDir = path.join(directoryPath, "articles");
  await fs.mkdir(articlesDir, { recursive: true });

  let stateValue;
  if (!runOptions.force) {
    try {
      const existing = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (
        existing.schema_version !== 2 ||
        existing.storage?.format !== "one_json_file_per_article"
      ) {
        throw new Error(
          "The existing manifest is not a version 2 per-article archive. " +
            "Choose another --output-dir or use --force.",
        );
      }
      const oldIds = existing.source?.selection?.target_ids ?? [];
      const newIds = targetItems.map((target) => target.id);
      if (JSON.stringify(oldIds) !== JSON.stringify(newIds)) {
        throw new Error(
          "The existing output was created for a different target set. " +
            "Choose another --output-dir or use --force.",
        );
      }
      existing.crawl.status = "in_progress";
      existing.crawl.updated_at = now;
      existing.crawl.failures ??= [];
      existing.articles ??= [];
      stateValue = existing;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (!stateValue) {
    stateValue = {
      schema_version: 2,
      source: {
        name: "MediLib UpToDate",
        root_url: ROOT_URL,
        graph_path: runOptions.graphPath,
        selection: {
          description: selectionValue.description,
          roots: selectionValue.roots,
          target_ids: targetItems.map((target) => target.id),
        },
        scope:
          "Authenticated extraction of article metadata, structured body text, " +
          "references, graphics links, and related-topic links.",
      },
      storage: {
        format: "one_json_file_per_article",
        articles_directory: "articles",
        filename_template: "{article_id}.json",
        manifest_checkpoint_every: runOptions.checkpointEvery,
        force_refresh_started_at: runOptions.force ? now : null,
      },
      crawl: {
        started_at: now,
        updated_at: now,
        completed_at: null,
        status: "in_progress",
        delay_ms: runOptions.delayMs,
        target_count: targetItems.length,
        completed_count: 0,
        failures: [],
      },
      stats: {},
      articles: [],
    };
  }

  const selectedIds = new Set(targetItems.map((target) => target.id));
  stateValue.crawl.failures = stateValue.crawl.failures.filter((failure) =>
    selectedIds.has(Number(failure.id)),
  );

  if (!runOptions.force) {
    await reconcileArticleIndex(
      stateValue,
      directoryPath,
      articlesDir,
      targetItems,
    );
  }

  return { state: stateValue, manifestPath, articlesDir };
}

async function reconcileArticleIndex(
  stateValue,
  outputDirectory,
  articleDirectory,
  targetItems,
) {
  const entries = await fs.readdir(articleDirectory, { withFileTypes: true });
  const fileNames = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const summaries = new Map(
    stateValue.articles.map((summary) => [Number(summary.id), summary]),
  );
  const reconciled = [];

  for (const target of targetItems) {
    const fileName = `${target.id}.json`;
    if (!fileNames.has(fileName)) continue;
    const articlePath = path.join(articleDirectory, fileName);
    const knownSummary = summaries.get(target.id);
    if (knownSummary) {
      reconciled.push(knownSummary);
      removeFailure(stateValue, target.id);
      continue;
    }

    try {
      const forceRefreshTime = Date.parse(
        stateValue.storage.force_refresh_started_at ?? "",
      );
      if (Number.isFinite(forceRefreshTime)) {
        const fileStats = await fs.stat(articlePath);
        if (fileStats.mtimeMs < forceRefreshTime) continue;
      }
      const payload = JSON.parse(await fs.readFile(articlePath, "utf8"));
      const article = payload.article ?? payload;
      if (Number(article.id) !== target.id || !article.title || !article.plain_text) {
        throw new Error("required article fields are missing");
      }
      reconciled.push(
        createArticleSummary(article, outputDirectory, articlePath),
      );
      removeFailure(stateValue, target.id);
    } catch (error) {
      upsertFailure(
        stateValue,
        target,
        new Error(`Could not index existing ${fileName}: ${error.message}`),
      );
    }
  }

  stateValue.articles = reconciled;
}

async function writeArticleFile(articlePath, article) {
  await writeJsonAtomic(articlePath, {
    schema_version: 1,
    source: {
      name: "MediLib UpToDate",
      canonical_url: article.url,
    },
    article,
  });
}

function upsertArticleSummary(
  stateValue,
  article,
  outputDirectory,
  articlePath,
) {
  stateValue.articles.push(
    createArticleSummary(article, outputDirectory, articlePath),
  );
}

function createArticleSummary(article, outputDirectory, articlePath) {
  return {
    id: Number(article.id),
    expected_title: article.expected_title,
    title: article.title,
    title_matches_expected: article.title_matches_expected,
    url: article.url,
    file: path.relative(outputDirectory, articlePath).split(path.sep).join("/"),
    extracted_at: article.extracted_at,
    word_count: Number(article.word_count ?? 0),
    character_count: Number(article.character_count ?? 0),
    reference_count: article.references?.length ?? 0,
    graphics_link_count: article.graphics?.length ?? 0,
    related_topic_link_count: article.related_topic_links?.length ?? 0,
  };
}

async function saveManifest(
  manifestPath,
  stateValue,
  targetItems,
  runOptions,
  interrupted,
) {
  const now = new Date().toISOString();
  const completed = stateValue.articles.length;
  const complete = completed === targetItems.length;
  const positions = new Map(
    targetItems.map((target, index) => [target.id, index]),
  );
  stateValue.articles.sort(
    (left, right) =>
      positions.get(Number(left.id)) - positions.get(Number(right.id)),
  );

  stateValue.crawl.updated_at = now;
  stateValue.crawl.delay_ms = runOptions.delayMs;
  stateValue.crawl.target_count = targetItems.length;
  stateValue.crawl.completed_count = completed;
  stateValue.storage.manifest_checkpoint_every = runOptions.checkpointEvery;
  stateValue.crawl.status = complete
    ? "complete"
    : interrupted
      ? "interrupted"
      : stateValue.crawl.failures.length > 0
        ? "incomplete_with_errors"
        : "in_progress";
  stateValue.crawl.completed_at = complete ? now : null;
  if (complete) stateValue.storage.force_refresh_started_at = null;
  stateValue.stats = calculateStats(stateValue.articles);

  await writeJsonAtomic(manifestPath, stateValue);
}

function calculateStats(articles) {
  return {
    articles: articles.length,
    total_words: sum(articles, (article) => article.word_count),
    total_characters: sum(articles, (article) => article.character_count),
    total_references: sum(articles, (article) => article.reference_count),
    total_graphics_links: sum(articles, (article) => article.graphics_link_count),
    total_related_topic_links: sum(
      articles,
      (article) => article.related_topic_link_count,
    ),
  };
}

function sum(items, selector) {
  return items.reduce((total, item) => total + Number(selector(item) ?? 0), 0);
}

function removeFailure(stateValue, articleId) {
  stateValue.crawl.failures = stateValue.crawl.failures.filter(
    (failure) => Number(failure.id) !== articleId,
  );
}

function upsertFailure(stateValue, target, error) {
  removeFailure(stateValue, target.id);
  stateValue.crawl.failures.push({
    id: target.id,
    title: target.expected_title,
    url: target.url,
    error: String(error?.message ?? error),
    failed_at: new Date().toISOString(),
  });
}

async function verifyRobotsPermission() {
  let response;
  try {
    response = await fetch(`${BASE_URL}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Could not verify robots.txt: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Could not verify robots.txt (HTTP ${response.status}).`);
  }
  const groups = parseRobots(await response.text());
  const rules = groups.get("*") ?? [];
  const targetPath = "/uptodate/show/";
  const matching = rules
    .filter((rule) => rule.path && targetPath.startsWith(rule.path))
    .sort((a, b) => b.path.length - a.path.length);
  if (matching[0]?.type === "disallow") {
    throw new Error("robots.txt disallows crawling /uptodate/show/.");
  }
}

function parseRobots(text) {
  const groups = new Map();
  let currentAgents = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      currentAgents = [value.toLowerCase()];
      if (!groups.has(currentAgents[0])) groups.set(currentAgents[0], []);
    } else if ((field === "allow" || field === "disallow") && currentAgents.length) {
      for (const agent of currentAgents) {
        groups.get(agent).push({ type: field, path: value });
      }
    }
  }
  return groups;
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await fs.rm(filePath, { force: true });
  await fs.rename(temporaryPath, filePath);
}

function defaultOutputDir(selectionValue) {
  return path.resolve(`uptodate_articles_${selectionValue.key}`);
}

function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function validateOptions(runOptions) {
  const selectors = Number(runOptions.all) +
    Number(runOptions.directoryId !== undefined) +
    Number(runOptions.articleIds.length > 0);
  if (selectors !== 1) {
    throw new Error(
      "Choose exactly one target selector: --directory-id, --article-id, or --all.",
    );
  }
  if (
    runOptions.directoryId !== undefined &&
    (!Number.isInteger(runOptions.directoryId) || runOptions.directoryId < 1)
  ) {
    throw new Error("--directory-id must be a positive integer.");
  }
  if (
    runOptions.articleIds.some(
      (articleId) => !Number.isInteger(articleId) || articleId < 1,
    )
  ) {
    throw new Error("Every --article-id must be a positive integer.");
  }
  if (!Number.isInteger(runOptions.delayMs) || runOptions.delayMs < 1000) {
    throw new Error("--delay-ms must be an integer of at least 1000.");
  }
  if (!Number.isInteger(runOptions.timeoutMs) || runOptions.timeoutMs < 5000) {
    throw new Error("--timeout-ms must be an integer of at least 5000.");
  }
  if (!Number.isInteger(runOptions.retries) || runOptions.retries < 1 || runOptions.retries > 10) {
    throw new Error("--retries must be an integer from 1 to 10.");
  }
  if (
    !Number.isInteger(runOptions.checkpointEvery) ||
    runOptions.checkpointEvery < 1 ||
    runOptions.checkpointEvery > 1000
  ) {
    throw new Error("--checkpoint-every must be an integer from 1 to 1000.");
  }
  if (
    runOptions.maxArticles !== undefined &&
    (!Number.isInteger(runOptions.maxArticles) || runOptions.maxArticles < 1)
  ) {
    throw new Error("--max-articles must be a positive integer.");
  }
}

function parseArgs(args) {
  const result = {
    all: false,
    articleIds: [],
    browserChannel: "auto",
    checkpointEvery: 100,
    delayMs: 1500,
    directOnly: false,
    force: false,
    graphPath: DEFAULT_GRAPH,
    headless: false,
    help: false,
    listTargets: false,
    loginOnly: false,
    profilePath: DEFAULT_PROFILE,
    retries: 3,
    timeoutMs: 45_000,
  };

  const valueAfter = (name, index) => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") result.all = true;
    else if (arg === "--article-id") {
      result.articleIds.push(Number(valueAfter(arg, index)));
      index += 1;
    } else if (arg === "--browser-channel") {
      result.browserChannel = valueAfter(arg, index);
      index += 1;
    } else if (arg === "--checkpoint-every") {
      result.checkpointEvery = Number(valueAfter(arg, index));
      index += 1;
    } else if (arg === "--delay-ms") {
      result.delayMs = Number(valueAfter(arg, index));
      index += 1;
    } else if (arg === "--direct-only") result.directOnly = true;
    else if (arg === "--directory-id") {
      result.directoryId = Number(valueAfter(arg, index));
      index += 1;
    } else if (arg === "--force") result.force = true;
    else if (arg === "--graph") {
      result.graphPath = path.resolve(valueAfter(arg, index));
      index += 1;
    } else if (arg === "--headless") result.headless = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--list-targets") result.listTargets = true;
    else if (arg === "--login-only") result.loginOnly = true;
    else if (arg === "--max-articles") {
      result.maxArticles = Number(valueAfter(arg, index));
      index += 1;
    } else if (arg === "--output-dir") {
      if (result.outputDir) {
        throw new Error("Choose only one of --output-dir or --output.");
      }
      result.outputDir = path.resolve(valueAfter(arg, index));
      index += 1;
    } else if (arg === "--output") {
      if (result.outputDir) {
        throw new Error("Choose only one of --output-dir or --output.");
      }
      const legacyPath = path.resolve(valueAfter(arg, index));
      result.outputDir =
        path.extname(legacyPath).toLowerCase() === ".json"
          ? path.join(path.dirname(legacyPath), path.basename(legacyPath, ".json"))
          : legacyPath;
      result.legacyOutputUsed = true;
      index += 1;
    } else if (arg === "--profile-dir") {
      result.profilePath = path.resolve(valueAfter(arg, index));
      index += 1;
    } else if (arg === "--retries") {
      result.retries = Number(valueAfter(arg, index));
      index += 1;
    } else if (arg === "--timeout-ms") {
      result.timeoutMs = Number(valueAfter(arg, index));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  result.articleIds = [...new Set(result.articleIds)];
  return result;
}

function printHelp() {
  console.log(`
Standalone authenticated MediLib UpToDate article crawler

Usage:
  node crawl_uptodate_articles.mjs --directory-id 683 [options]
  node crawl_uptodate_articles.mjs --article-id 13529 [--article-id 393 ...]
  node crawl_uptodate_articles.mjs --all [options]

Target selection (choose exactly one):
  --directory-id ID       Crawl unique articles in a directory subtree
  --article-id ID         Crawl one article; may be repeated
  --all                   Crawl every article reachable from the graph root

Options:
  --direct-only           Do not descend into child directories
  --graph PATH            Directory graph JSON (default: uptodate_directory_graph.json)
  --output-dir PATH       Directory containing manifest.json and articles/*.json
  --output PATH           Legacy alias for --output-dir (.json is stripped)
  --profile-dir PATH      Persistent private browser profile
  --browser-channel NAME  auto, chrome, msedge, or chromium (default: auto)
  --delay-ms N            Delay between articles; minimum 1000 (default: 1500)
  --timeout-ms N          Page timeout (default: 45000)
  --retries N             Attempts per article, 1-10 (default: 3)
  --checkpoint-every N    Rewrite manifest after N successes (default: 100)
  --max-articles N        Limit this run's selected target set
  --login-only            Open the browser for login, verify it, then exit
  --headless              Run without a visible browser (after login is saved)
  --list-targets          Print selected article URLs without opening a browser
  --force                 Recrawl targets and overwrite their article files
  --help                  Show this help

Examples:
  node crawl_uptodate_articles.mjs --directory-id 683 --login-only
  node crawl_uptodate_articles.mjs --directory-id 683 --output-dir anaphylaxis
  node crawl_uptodate_articles.mjs --directory-id 683 --output-dir anaphylaxis --headless
`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function exitCleanly(code) {
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}
