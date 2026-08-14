// ==UserScript==
// @name Oldest Chat Cleaner — ChatGPT + Claude
// @namespace local.oldest-chat-cleaner
// @version 4.4.0
// @description Lazily preview and delete oldest chat batches by Regular or project group.
// @match https://chatgpt.com/*
// @match https://claude.ai/*
// @homepageURL https://github.com/mongkokman91/oldest-chat-cleaner
// @supportURL https://github.com/mongkokman91/oldest-chat-cleaner/issues
// @grant none
// @run-at document-idle
// ==/UserScript==
(() => {
  "use strict";
  if (window.__oldestChatCleanerV3Installed) return;
  window.__oldestChatCleanerV3Installed = true;
  const PAGE_SIZE = 100;
  const MAX_RETRIES = 4;
  const REQUEST_TIMEOUT_MS = 15000;
  const DIAGNOSTIC_MODE = false;
  const MAX_CATALOG_PAGES = 100;
  const MAX_PROJECT_PAGES = 1000;
  const diagnosticLines = [];
  const GHOST_QUARANTINE_KEY = "oldest-chat-cleaner:ghost-quarantine:v1";
  const readGhostQuarantine = () => {
    try {
      const ids = JSON.parse(localStorage.getItem(GHOST_QUARANTINE_KEY) || "[]");
      return new Set(Array.isArray(ids) ? ids.map(String) : []);
    } catch {
      return new Set();
    }
  };
  let ghostQuarantine = readGhostQuarantine();
  const saveGhostQuarantine = () => {
    localStorage.setItem(
      GHOST_QUARANTINE_KEY,
      JSON.stringify([...ghostQuarantine]),
    );
  };
  const quarantineGhost = (id) => {
    ghostQuarantine.add(String(id));
    saveGhostQuarantine();
  };
  let diagnosticSink = null;
  const trace = (message) => {
    const line = `${new Date().toLocaleTimeString()} — ${message}`;
    diagnosticLines.push(line);
    diagnosticSink?.(diagnosticLines.join("\n"));
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const toMillis = (value) => {
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    return Date.parse(value);
  };
  const unwrapArray = (value, keys = []) => {
    if (Array.isArray(value)) return value;
    for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
    return [];
  };
  const readPinState = (item) => {
    const value = item.is_pinned ?? item.pinned ?? item.isPinned;
    if (value === true || value === 1 || value === "true") {
      return { isPinned: true, pinKnown: true };
    }
    if (value === false || value === 0 || value === "false") {
      return { isPinned: false, pinKnown: true };
    }
    return { isPinned: false, pinKnown: false };
  };
  const fetchWithTimeout = async (url, options = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const path = String(url).replace(/cursor=[^&]+/, "cursor=[hidden]");
    trace(`Request started: ${path}`);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      trace(`Response: HTTP ${response.status} — ${path}`);
      return response;
    } catch (error) {
      if (error.name === "AbortError") {
        trace(`TIMEOUT: ${path}`);
        throw new Error(
          `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
        );
      }
      trace(`Request error: ${error.message} — ${path}`);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const chatIdFromHref = (href) => {
    const match = String(href || "").match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    return match?.[1] || null;
  };
  const normalizeTitle = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  const chatIds = (item) =>
    [...new Set([item?.conversation_id, item?.id, item?.uuid]
      .filter(Boolean)
      .map(String))];
  const describeShape = (value, prefix = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 2) return [];
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(child)) return [`${path}:array`];
      if (child && typeof child === "object") {
        return [`${path}:object`, ...describeShape(child, path, depth + 1)];
      }
      const type = child === null ? "null" : typeof child;
      const idHint = /(^|_)(id|uuid)$|conversation/i.test(key)
        ? ` (length ${String(child ?? "").length})`
        : "";
      return [`${path}:${type}${idHint}`];
    });
  };
  const readChatGptPinnedIdsFromSidebar = () => {
    const pageLeaves = [...document.body.querySelectorAll("*")].filter(
      (element) => element.children.length === 0,
    );
    const pinnedHeading = pageLeaves.find(
      (element) =>
        element.textContent?.trim().toLowerCase() === "pinned" &&
        element.getClientRects().length > 0,
    );
    if (!pinnedHeading) return null;
    const sidebar =
      pinnedHeading.closest(
        'nav, aside, [data-testid*="sidebar"], [class*="sidebar"]',
      ) || document.body;
    const leafElements = [...sidebar.querySelectorAll("*")].filter(
      (element) => element.children.length === 0,
    );
    const projectsHeading = leafElements.find(
      (element) =>
        element.textContent?.trim().toLowerCase() === "projects" &&
        Boolean(
          pinnedHeading.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
    );
    const ids = new Set();
    const titles = new Set();
    const pinnedBottom = pinnedHeading.getBoundingClientRect().bottom;
    const projectsTop = projectsHeading
      ? projectsHeading.getBoundingClientRect().top
      : window.innerHeight;
    const candidates = sidebar.querySelectorAll(
      'a[href], [role="link"], button',
    );
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      if (
        rect.height <= 0 ||
        rect.top < pinnedBottom - 2 ||
        rect.top >= projectsTop
      )
        continue;
      const href = candidate.getAttribute("href");
      const id = chatIdFromHref(href);
      if (id) ids.add(id);
      const title = normalizeTitle(candidate.textContent);
      if (title && title !== "pinned" && title !== "projects") {
        titles.add(title);
      }
    }
    if (!ids.size && !titles.size) return null;
    ids.titles = titles;
    return ids;
  };
  const pinStateFromSidebar = (item, pinnedSnapshot) => {
    if (!pinnedSnapshot) return readPinState(item);
    const idMatch = pinnedSnapshot.has(String(item.id ?? item.uuid));
    const titleMatch = pinnedSnapshot.titles?.has(
      normalizeTitle(item.title ?? item.name ?? item.summary),
    );
    return { isPinned: Boolean(idMatch || titleMatch), pinKnown: true };
  };
  const chatgptAdapter = {
    platform: "ChatGPT",
    concurrency: 3,
    async getContexts() {
      return [{ id: "current", name: "Current ChatGPT workspace" }];
    },
    async getHeaders() {
      const response = await fetch("/api/auth/session");
      if (!response.ok)
        throw new Error(`Could not read session (HTTP ${response.status}).`);
      const session = await response.json();
      if (!session.accessToken)
        throw new Error("No access token found. Sign in and reload.");
      return {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      };
    },
    async loadProjectNames(headers) {
      const names = new Map();
      const seenCursors = new Set();
      let cursor = null;
      trace("Stage: loading ChatGPT project catalog");
      for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
        const cursorKey = cursor ?? "[first page]";
        if (seenCursors.has(cursorKey)) {
          throw new Error(
            `Project catalog repeated its cursor on page ${page + 1}.`,
          );
        }
        seenCursors.add(cursorKey);
        trace(
          `Project catalog page ${page + 1}; projects found: ${names.size}`,
        );
        const query = new URLSearchParams({
          owned_only: "false",
          conversations_per_gizmo: "0",
        });
        if (cursor) query.set("cursor", cursor);
        const response = await fetchWithTimeout(
          `/backend-api/gizmos/snorlax/sidebar?${query}`,
          { headers },
        );
        if (!response.ok) {
          throw new Error(
            `Could not load project names (HTTP ${response.status}).`,
          );
        }
        const data = await response.json();
        for (const item of unwrapArray(data, ["items"])) {
          const project = item?.gizmo?.gizmo ?? item?.gizmo ?? item;
          const id = project?.id ?? project?.gizmo_id;
          const name =
            project?.display?.name ?? project?.name ?? project?.title ?? null;
          if (id && name) {
            names.set(String(id), {
              name: String(name),
              // num_interactions is not a conversation count.
              count: null,
            });
          }
        }
        cursor = data?.cursor ?? null;
        if (!cursor) break;
        if (page === MAX_CATALOG_PAGES - 1) {
          throw new Error(
            `Project catalog exceeded ${MAX_CATALOG_PAGES} pages.`,
          );
        }
      }
      trace(`Project catalog complete: ${names.size} projects`);
      return names;
    },
    async loadOneProject(projectId, projectName, headers, sidebarPinnedIds) {
      const chats = [];
      const seen = new Set();
      const seenCursors = new Set();
      let cursor = "0";
      trace(`Project started: ${projectName}`);
      for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
        if (seenCursors.has(cursor)) {
          throw new Error(
            `Project “${projectName}” repeated its cursor on page ${page + 1}.`,
          );
        }
        seenCursors.add(cursor);
        trace(
          `Project page ${page + 1}: ${projectName}; chats found: ${chats.length}`,
        );
        const response = await fetchWithTimeout(
          `/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=${encodeURIComponent(cursor)}`,
          { headers },
        );
        if (!response.ok) {
          throw new Error(
            `Could not load project “${projectName}” (HTTP ${response.status}).`,
          );
        }
        const data = await response.json();
        for (const item of unwrapArray(data, ["items", "conversations"])) {
          const ids = chatIds(item);
          const id = ids[0];
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const pinState = pinStateFromSidebar(item, sidebarPinnedIds);
          chats.push({
            id,
            alternateIds: ids.slice(1),
            title: item.title || "(untitled)",
            createdAt: item.create_time,
            projectId,
            projectName,
            ...pinState,
          });
        }
        cursor = data?.cursor ?? null;
        if (!cursor) break;
        if (page === MAX_PROJECT_PAGES - 1) {
          throw new Error(
            `Project “${projectName}” exceeded ${MAX_PROJECT_PAGES} pages.`,
          );
        }
      }
      trace(`Project complete: ${projectName}; ${chats.length} chats`);
      return chats;
    },
    async loadChats(_contextId, onProgress) {
      const headers = await this.getHeaders();
      const projectNames = await this.loadProjectNames(headers);
      const sidebarPinnedIds = readChatGptPinnedIdsFromSidebar();
      const chats = [];
      const seen = new Set();
      trace("Stage: loading regular ChatGPT history");
      for (let offset = 0; offset < 100000; ) {
        onProgress(chats.length);
        const query = new URLSearchParams({
          offset: String(offset),
          limit: String(PAGE_SIZE),
          order: "updated",
        });
        const response = await fetchWithTimeout(
          `/backend-api/conversations?${query}`,
          {
            headers,
          },
        );
        if (!response.ok) {
          throw new Error(
            `Could not load chats at offset ${offset} (HTTP ${response.status}).`,
          );
        }
        const data = await response.json();
        const items = unwrapArray(data, ["items"]);
        for (const item of items) {
          const ids = chatIds(item);
          const id = ids[0];
          if (id && !seen.has(id)) {
            seen.add(id);
            const projectId =
              item.project_id ??
              (String(item.conversation_template_id || "").startsWith("g-p-")
                ? item.conversation_template_id
                : null) ??
              (String(item.gizmo_id || "").startsWith("g-p-")
                ? item.gizmo_id
                : null);
            const pinState = pinStateFromSidebar(item, sidebarPinnedIds);
            chats.push({
              id,
              alternateIds: ids.slice(1),
              title: item.title || "(untitled)",
              createdAt: item.create_time,
              projectId: projectId ? String(projectId) : null,
              projectName:
                item.project_name ??
                item.project_title ??
                item.gizmo_name ??
                item.conversation_template_name ??
                projectNames.get(String(projectId))?.name ??
                null,
              ...pinState,
            });
          }
        }
        if (
          items.length === 0 ||
          (Number.isFinite(data.total) && chats.length >= data.total)
        )
          break;
        offset += items.length;
      }
      const catalogIds = new Set(projectNames.keys());
      const regularChats = chats.filter(
        (chat) => !chat.projectId || !catalogIds.has(chat.projectId),
      );
      const projectCatalog = [...projectNames.entries()].map(
        ([key, project]) => ({ key, ...project }),
      );
      trace(
        `Initial load complete: ${regularChats.length} regular chats; ${projectCatalog.length} project groups`,
      );
      return {
        chats: regularChats,
        deleteHeaders: headers,
        pinSource: sidebarPinnedIds
          ? `ChatGPT sidebar (${sidebarPinnedIds.size} IDs / ${sidebarPinnedIds.titles.size} titles)`
          : "API fields unavailable",
        projectCatalog,
        projectErrors: [],
      };
    },
    async loadProjectGroup(group, headers, onProgress) {
      const sidebarPinnedIds = readChatGptPinnedIdsFromSidebar();
      const chats = [];
      const seen = new Set();
      const seenCursors = new Set();
      let cursor = "0";
      let shapeLogged = false;
      for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
        if (seenCursors.has(cursor)) {
          throw new Error(`Project “${group.name}” repeated its cursor.`);
        }
        seenCursors.add(cursor);
        onProgress(page + 1, chats.length);
        const response = await fetchWithTimeout(
          `/backend-api/gizmos/${encodeURIComponent(group.key)}/conversations?cursor=${encodeURIComponent(cursor)}`,
          { headers },
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        for (const item of unwrapArray(data, ["items", "conversations"])) {
          if (!shapeLogged) {
            trace(`Project chat response shape: ${describeShape(item).join(", ")}`);
            shapeLogged = true;
          }
          const ids = chatIds(item);
          const id = ids[0];
          if (!id || seen.has(id)) continue;
          if (ghostQuarantine.has(String(id))) {
            trace(`Skipped quarantined ghost entry “${item.title || "(untitled)"}”.`);
            continue;
          }
          seen.add(id);
          const pinState = pinStateFromSidebar(item, sidebarPinnedIds);
          chats.push({
            id,
            alternateIds: ids.slice(1),
            title: item.title || "(untitled)",
            createdAt: item.create_time,
            projectId: group.key,
            projectName: group.name,
            ...pinState,
          });
        }
        cursor = data?.cursor ?? null;
        if (!cursor) return chats;
      }
      throw new Error(`Exceeded ${MAX_PROJECT_PAGES} pages.`);
    },
    async deleteChat(chat, _contextId, headers, signal) {
      const ids = [chat.id, ...(chat.alternateIds || [])];
      let lastResponse;
      for (const id of ids) {
        lastResponse = await fetch(
          `/backend-api/conversation/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ is_visible: false }),
            signal,
          },
        );
        if (lastResponse.status !== 404) return lastResponse;
        trace(`Delete candidate returned HTTP 404 for “${chat.title}”; trying ${ids.length > 1 ? "alternate ID" : "no alternate ID available"}.`);
      }
      return lastResponse;
    },
  };
  const claudeAdapter = {
    platform: "Claude",
    concurrency: 2,
    async getContexts() {
      const response = await fetch("/api/organizations", {
        credentials: "include",
      });
      if (!response.ok)
        throw new Error(
          `Could not load Claude workspaces (HTTP ${response.status}).`,
        );
      const data = await response.json();
      const organizations = unwrapArray(data, ["organizations", "data"]);
      const contexts = organizations
        .filter((org) => org?.uuid || org?.id)
        .map((org, index) => ({
          id: org.uuid || org.id,
          name: org.name || org.display_name || `Claude workspace ${index + 1}`,
        }));
      if (!contexts.length)
        throw new Error("No Claude workspace was found. Sign in and reload.");
      return contexts;
    },
    async loadChats(contextId, onProgress) {
      onProgress(0);
      const response = await fetchWithTimeout(
        `/api/organizations/${encodeURIComponent(contextId)}/chat_conversations`,
        { credentials: "include" },
      );
      if (!response.ok)
        throw new Error(
          `Could not load Claude chats (HTTP ${response.status}).`,
        );
      const data = await response.json();
      const items = unwrapArray(data, [
        "chat_conversations",
        "conversations",
        "data",
        "items",
      ]);
      const chats = items
        .filter((item) => item?.uuid || item?.id)
        .map((item) => {
          const projectId = item.project_uuid ?? item.project_id ?? null;
          const pinState = readPinState(item);
          return {
            id: item.uuid || item.id,
            title: item.name || item.title || item.summary || "(untitled)",
            createdAt: item.created_at ?? item.create_time ?? item.created_time,
            projectId: projectId ? String(projectId) : null,
            projectName:
              item.project_name ??
              item.project_title ??
              item.project?.name ??
              null,
            ...pinState,
          };
        });
      onProgress(chats.length);
      return { chats, deleteHeaders: { "Content-Type": "application/json" } };
    },
    async deleteChat(chat, contextId, headers, signal) {
      return fetch(
        `/api/organizations/${encodeURIComponent(contextId)}/chat_conversations/${encodeURIComponent(chat.id)}`,
        { method: "DELETE", credentials: "include", headers, signal },
      );
    },
  };
  const adapter =
    location.hostname === "claude.ai" ? claudeAdapter : chatgptAdapter;
  const style = document.createElement("style");
  style.textContent = ` #occ-launch { position:fixed;right:18px;bottom:18px;z-index:2147483646; padding:10px 14px;border:0;border-radius:999px;cursor:pointer;color:#fff; background:#b42318;font:600 14px system-ui;box-shadow:0 4px 18px #0004 } #occ-overlay { position:fixed;inset:0;z-index:2147483647;display:none; place-items:center;padding:20px;background:#0009;font:14px system-ui } #occ-panel { width:min(920px,96vw);max-height:88vh;overflow:auto;color:#202123; background:#fff;border-radius:14px;padding:20px;box-shadow:0 18px 60px #0007 } #occ-panel h2 { margin:0 0 8px } #occ-controls { display:flex;gap:8px;flex-wrap:wrap;align-items:center } #occ-controls input { width:80px;padding:8px } #occ-controls select { max-width:260px;padding:8px } #occ-controls button { padding:9px 12px;cursor:pointer } #occ-delete,#occ-stop { color:#fff;background:#b42318;border:0;border-radius:7px } #occ-delete:disabled { opacity:.45;cursor:not-allowed } #occ-close { margin-left:auto } #occ-close-choice { display:none;margin:12px 0;padding:12px;border:1px solid #f0b4ae; border-radius:8px;background:#fff4f2 } #occ-close-choice p { margin:0 0 10px } #occ-close-choice button { margin-right:8px;padding:9px 12px;cursor:pointer } #occ-groups { display:grid;gap:8px;margin:12px 0 } #occ-groups details { border:1px solid #d0d5dd;border-radius:8px;background:#fff } #occ-groups summary { padding:11px 12px;cursor:pointer;font-weight:650 } #occ-group-body { padding:0 12px 12px;color:#475467 } #occ-status { margin:12px 0;min-height:20px } #occ-summary { margin:10px 0;padding:10px 12px;border-radius:8px; background:#f2f4f7;font-weight:600 } #occ-diagnostics { max-height:260px;overflow:auto;white-space:pre-wrap;padding:10px;border-radius:8px;background:#101828;color:#e4e7ec;font:12px/1.45 ui-monospace,monospace } #occ-list { width:100%;border-collapse:collapse } #occ-list th,#occ-list td { padding:8px;border-bottom:1px solid #ddd;text-align:left; vertical-align:top } #occ-list td:first-child { width:42px } #occ-list td:nth-child(2) { white-space:nowrap } #occ-list tr[data-protected="true"] { background:#fff8e8;color:#6b4f00 } `;
  document.head.appendChild(style);
  const launch = document.createElement("button");
  launch.id = "occ-launch";
  launch.textContent = "Oldest chats";
  const overlay = document.createElement("div");
  overlay.id = "occ-overlay";
  overlay.innerHTML = ` <section id="occ-panel" role="dialog" aria-modal="true"> <h2>${adapter.platform} oldest chat cleaner</h2> <p>Projects load only when opened. Deletion is limited to the opened group, and pinned chats are protected.</p> <div id="occ-controls"> <label id="occ-context-label">Workspace <select id="occ-context"></select></label> <label>Batch size <input id="occ-count" type="number" min="1" max="500" value="25"></label> <button id="occ-preview">Reload groups</button> <button id="occ-delete" disabled>Delete eligible shown</button> <button id="occ-reset-ghosts">Reset ghost quarantine (0)</button> <button id="occ-close">Close</button> </div> <div id="occ-close-choice"> <p>Deletion is running. What should happen?</p> <button id="occ-stop">Stop deletion</button> <button id="occ-continue">Continue in background</button> </div> <div id="occ-status">Open the cleaner to load group names.</div> <div id="occ-summary">Waiting to count…</div> <details><summary>Technical log — click to expand</summary><button id="occ-copy">Copy technical log</button><pre id="occ-diagnostics">Waiting to start…</pre></details> <div id="occ-groups"></div> <table id="occ-list"><thead><tr><th>#</th><th>Created</th><th>Status</th><th>Title</th></tr></thead><tbody></tbody></table> </section>`;
  document.body.append(launch, overlay);
  const $ = (selector) => overlay.querySelector(selector);
  const countInput = $("#occ-count");
  const contextSelect = $("#occ-context");
  const contextLabel = $("#occ-context-label");
  const previewButton = $("#occ-preview");
  const copyButton = $("#occ-copy");
  const deleteButton = $("#occ-delete");
  const resetGhostsButton = $("#occ-reset-ghosts");
  const closeButton = $("#occ-close");
  const closeChoice = $("#occ-close-choice");
  const stopButton = $("#occ-stop");
  const continueButton = $("#occ-continue");
  const status = $("#occ-status");
  const summary = $("#occ-summary");
  const diagnostics = $("#occ-diagnostics");
  const groupsContainer = $("#occ-groups");
  const tbody = $("tbody");
  let contextsLoaded = false;
  let allChats = [];
  let projectCatalog = [];
  let failedGroups = [];
  let activeGroup = null;
  let shownRows = [];
  let shownTargets = [];
  let deleteHeaders = {};
  let pinSource = "unknown";
  let busy = false;
  let deleting = false;
  let stopRequested = false;
  let deletionController = null;
  diagnosticSink = (text) => {
    diagnostics.textContent = text;
    diagnostics.scrollTop = diagnostics.scrollHeight;
  };
  if (adapter.platform === "ChatGPT") contextLabel.style.display = "none";
  const updateGhostControl = () => {
    resetGhostsButton.textContent =
      `Reset ghost quarantine (${ghostQuarantine.size})`;
    resetGhostsButton.disabled = ghostQuarantine.size === 0;
  };
  const setStatus = (message) => {
    status.textContent = message;
  };
  updateGhostControl();
  const render = (rows) => {
    tbody.replaceChildren(
      ...rows.map((chat, index) => {
        const row = document.createElement("tr");
        const isProtected = chat.isPinned || !chat.pinKnown;
        row.dataset.protected = String(isProtected);
        for (const value of [
          index + 1,
          new Date(toMillis(chat.createdAt)).toLocaleString(),
          chat.isPinned
            ? "Pinned — protected"
            : !chat.pinKnown
              ? "Pin status unknown — protected"
              : "Eligible",
          chat.title,
        ]) {
          const cell = document.createElement("td");
          cell.textContent = String(value);
          row.appendChild(cell);
        }
        return row;
      }),
    );
  };
  const loadContexts = async () => {
    if (contextsLoaded) return;
    setStatus(`Loading ${adapter.platform} workspaces…`);
    const contexts = await adapter.getContexts();
    contextSelect.replaceChildren(
      ...contexts.map((context) => {
        const option = document.createElement("option");
        option.value = context.id;
        option.textContent = context.name;
        return option;
      }),
    );
    contextsLoaded = true;
  };
  const groupChats = (groupKey) =>
    allChats.filter((chat) => (chat.projectId || "regular") === groupKey);
  const showGroup = (group) => {
    const count = Number(countInput.value);
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      setStatus("Enter a whole-number batch size from 1 to 500.");
      return;
    }
    activeGroup = group;
    const chats = groupChats(group.key);
    const sortable = chats.filter((chat) =>
      Number.isFinite(toMillis(chat.createdAt)),
    );
    const protectedChats = sortable
      .filter((chat) => chat.isPinned || !chat.pinKnown)
      .sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
    shownTargets = sortable
      .filter((chat) => chat.pinKnown && !chat.isPinned)
      .sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt))
      .slice(0, count);
    shownRows = [...protectedChats, ...shownTargets].sort(
      (a, b) => toMillis(a.createdAt) - toMillis(b.createdAt),
    );
    render(shownRows);
    summary.textContent =
      `${group.name}: ${chats.length} total · ${shownTargets.length} selected · ` +
      `${protectedChats.length} protected`;
    setStatus(
      `Showing only “${group.name}”. Review every row before deleting.`,
    );
    deleteButton.disabled = DIAGNOSTIC_MODE || shownTargets.length === 0;
  };
  const loadLazyGroup = async (group, groupSummary, body) => {
    if (group.loading || group.loaded || !adapter.loadProjectGroup) return;
    group.loading = true;
    busy = true;
    previewButton.disabled = true;
    deleteButton.disabled = true;
    render([]);
    setStatus(`Loading “${group.name}”…`);
    body.textContent = "Loading this project’s chats…";
    try {
      const chats = await adapter.loadProjectGroup(
        group,
        deleteHeaders,
        (page, found) => {
          const message = `Loading “${group.name}”: page ${page} · ${found} chats found`;
          setStatus(message);
          body.textContent = message;
        },
      );
      allChats = allChats
        .filter((chat) => chat.projectId !== group.key)
        .concat(chats);
      group.chats = chats;
      group.loaded = true;
      const pinned = chats.filter((chat) => chat.isPinned).length;
      groupSummary.textContent = `${group.name} — ${chats.length} chats · ${pinned} pinned`;
      body.textContent = "Loaded. Review the table below.";
      showGroup(group);
    } catch (error) {
      group.error = error.message;
      groupSummary.textContent = `${group.name} — unavailable (protected)`;
      body.textContent = `${error.message} No chats from this project can be deleted.`;
      setStatus(`Could not load “${group.name}”: ${error.message}`);
    } finally {
      group.loading = false;
      busy = false;
      previewButton.disabled = false;
    }
  };
  const renderGroups = () => {
    const grouped = new Map();
    grouped.set("regular", {
      key: "regular",
      name: "Regular chats",
      chats: [],
      loaded: true,
      lazy: false,
    });
    for (const chat of allChats) {
      const key = chat.projectId || "regular";
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          name:
            key === "regular"
              ? "Regular chats"
              : chat.projectName || `Project ${key.slice(-8)}`,
          chats: [],
          loaded: true,
          lazy: false,
        });
      }
      grouped.get(key).chats.push(chat);
    }
    for (const project of projectCatalog) {
      if (grouped.has(project.key)) continue;
      grouped.set(project.key, {
        ...project,
        chats: [],
        loaded: false,
        lazy: true,
      });
    }
    const groups = [...grouped.values()].sort((a, b) => {
      if (a.key === "regular") return -1;
      if (b.key === "regular") return 1;
      return a.name.localeCompare(b.name);
    });
    groupsContainer.replaceChildren(
      ...groups.map((group) => {
        const details = document.createElement("details");
        const groupSummary = document.createElement("summary");
        const pinned = group.chats.filter((chat) => chat.isPinned).length;
        const countLabel = group.loaded
          ? `${group.chats.length} chats · ${pinned} pinned`
          : Number.isFinite(group.count)
            ? `${group.count} chats · open to load`
            : "open to load chats";
        groupSummary.textContent = `${group.name} — ${countLabel}`;
        const body = document.createElement("div");
        body.id = "occ-group-body";
        body.textContent = "Open this group to review its oldest chats.";
        details.append(groupSummary, body);
        details.addEventListener("toggle", () => {
          if (!details.open) return;
          for (const other of groupsContainer.querySelectorAll("details")) {
            if (other !== details) other.open = false;
          }
          if (group.lazy && !group.loaded) {
            loadLazyGroup(group, groupSummary, body);
          } else {
            showGroup(group);
          }
        });
        return details;
      }),
      ...failedGroups.map((group) => {
        const details = document.createElement("details");
        const groupSummary = document.createElement("summary");
        groupSummary.textContent = `${group.name} — unavailable (protected)`;
        const body = document.createElement("div");
        body.id = "occ-group-body";
        body.textContent = `${group.message} No chats from this project can be deleted.`;
        details.append(groupSummary, body);
        return details;
      }),
    );
  };
  const preview = async () => {
    if (busy) return;
    diagnosticLines.length = 0;
    trace(`Loader started on ${adapter.platform}`);
    busy = true;
    activeGroup = null;
    allChats = [];
    projectCatalog = [];
    failedGroups = [];
    shownRows = [];
    shownTargets = [];
    render([]);
    groupsContainer.replaceChildren();
    deleteButton.disabled = true;
    previewButton.disabled = true;
    try {
      await loadContexts();
      const contextId = contextSelect.value;
      const result = await adapter.loadChats(contextId, (found, detail) => {
        setStatus(
          detail || `Loading ${adapter.platform} chats… ${found} found`,
        );
        summary.textContent = `Counting chats… ${found} found so far`;
      });
      deleteHeaders = result.deleteHeaders;
      pinSource = result.pinSource || "API fields";
      allChats = result.chats;
      projectCatalog = result.projectCatalog || [];
      failedGroups = result.projectErrors || [];
      const invalidDate = allChats.filter(
        (chat) => !Number.isFinite(toMillis(chat.createdAt)),
      ).length;
      const pinnedCount = allChats.filter((chat) => chat.isPinned).length;
      const unknownPinCount = allChats.filter((chat) => !chat.pinKnown).length;
      const projectCount = allChats.filter((chat) => chat.projectId).length;
      if (!allChats.length && !projectCatalog.length)
        throw new Error("No chats or projects were found.");
      renderGroups();
      summary.textContent =
        `Regular chats loaded: ${allChats.length - projectCount} · Projects available: ${projectCatalog.length} · ` +
        `Project chats already loaded: ${projectCount} · ` +
        `Pinned protected: ${pinnedCount} · Pin status unavailable: ${unknownPinCount} · ` +
        `Unavailable projects: ${failedGroups.length} · No creation date: ${invalidDate} · ` +
        `Pin check: ${pinSource}`;
      summary.dataset.counted = "true";
      setStatus(
        "Groups loaded. Open Regular chats or one project to review it.",
      );
    } catch (error) {
      trace(`LOAD STOPPED: ${error.message}`);
      setStatus(`Error: ${error.message}`);
      summary.textContent = "Total chats: count failed — see the error above";
      summary.dataset.counted = "false";
    } finally {
      previewButton.disabled = false;
      busy = false;
    }
  };
  const deleteWithRetry = async (chat, contextId, signal) => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (stopRequested || signal.aborted)
        throw new DOMException("Stopped", "AbortError");
      const response = await adapter.deleteChat(
        chat,
        contextId,
        deleteHeaders,
        signal,
      );
      if (response.ok) return { alreadyAbsent: false };
      if (adapter.platform === "ChatGPT" && response.status === 404) {
        quarantineGhost(chat.id);
        updateGhostControl();
        trace(`Quarantined stale project entry “${chat.title}” as already absent; continuing.`);
        return { alreadyAbsent: true };
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        throw new Error(`Failed at “${chat.title}” (HTTP ${response.status}).`);
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : 800 * 2 ** attempt + Math.floor(Math.random() * 300);
      setStatus(
        `${adapter.platform} asked us to slow down. Retrying in ${Math.ceil(waitMs / 1000)}s…`,
      );
      await sleep(waitMs);
    }
  };
  launch.addEventListener("click", async () => {
    overlay.style.display = "grid";
    if (!busy && summary.dataset.counted !== "true") await preview();
  });
  contextSelect.addEventListener("change", () => {
    summary.dataset.counted = "false";
    preview();
  });
  const requestClose = () => {
    if (deleting) {
      closeChoice.style.display = "block";
      return;
    }
    overlay.style.display = "none";
  };
  closeButton.addEventListener("click", requestClose);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) requestClose();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || overlay.style.display !== "grid") return;
    event.preventDefault();
    requestClose();
  });
  stopButton.addEventListener("click", () => {
    stopRequested = true;
    deletionController?.abort();
    closeChoice.style.display = "none";
    overlay.style.display = "none";
  });
  continueButton.addEventListener("click", () => {
    closeChoice.style.display = "none";
    overlay.style.display = "none";
  });
  previewButton.addEventListener("click", preview);
  resetGhostsButton.addEventListener("click", () => {
    ghostQuarantine.clear();
    saveGhostQuarantine();
    updateGhostControl();
    summary.dataset.counted = "false";
    setStatus("Ghost quarantine cleared. Reload groups to include those entries again.");
  });
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(diagnosticLines.join("\n"));
      setStatus("Diagnostics copied. Paste them into our chat.");
    } catch {
      setStatus(
        "Could not copy automatically. Send a screenshot of the diagnostic box.",
      );
    }
  });
  deleteButton.addEventListener("click", async () => {
    if (DIAGNOSTIC_MODE) return;
    if (busy || !activeGroup || !shownTargets.length) return;
    const targets = [...shownTargets];
    busy = true;
    deleting = true;
    stopRequested = false;
    deletionController = new AbortController();
    deleteButton.disabled = true;
    previewButton.disabled = true;
    closeButton.textContent = "Close…";
    let deleted = 0;
    let alreadyAbsent = 0;
    let nextIndex = 0;
    let firstError = null;
    const succeeded = new Set();
    const contextId = contextSelect.value;
    try {
      const worker = async () => {
        while (!firstError && !stopRequested) {
          const index = nextIndex++;
          if (index >= targets.length) return;
          const chat = targets[index];
          try {
            const result = await deleteWithRetry(
              chat,
              contextId,
              deletionController.signal,
            );
            succeeded.add(chat.id);
            if (result?.alreadyAbsent) alreadyAbsent += 1;
            else deleted += 1;
            setStatus(
              `Processed ${deleted + alreadyAbsent} of ${targets.length} · ` +
                `${deleted} deleted · ${alreadyAbsent} already absent`,
            );
          } catch (error) {
            if (error.name !== "AbortError") firstError ||= error;
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(adapter.concurrency, targets.length) },
          () => worker(),
        ),
      );
      if (firstError) throw firstError;
      shownTargets = targets.filter((chat) => !succeeded.has(chat.id));
      shownRows = shownRows.filter((chat) => !succeeded.has(chat.id));
      render(shownRows);
      summary.dataset.counted = "false";
      if (stopRequested) {
        summary.textContent = "Total chats: recount recommended after stopping";
        setStatus(
          `Stopped. ${deleted} deleted; ${alreadyAbsent} already absent; ` +
            `${shownTargets.length} displayed chats remain. ` +
            `A request already received by ${adapter.platform} may still finish.`,
        );
        deleteButton.disabled = shownTargets.length === 0;
      } else {
        summary.textContent = `${activeGroup.name}: deletion finished · reload groups when ready`;
        setStatus(
          `Done. ${deleted} deleted from “${activeGroup.name}”; ` +
            `${alreadyAbsent} stale entries were already absent. Click Reload groups when ready.`,
        );
      }
    } catch (error) {
      shownTargets = targets.filter((chat) => !succeeded.has(chat.id));
      shownRows = shownRows.filter((chat) => !succeeded.has(chat.id));
      render(shownRows);
      summary.dataset.counted = "false";
      setStatus(
        `Deleted ${deleted}; ${alreadyAbsent} already absent; then stopped starting new requests. ${error.message}`,
      );
      deleteButton.disabled = shownTargets.length === 0;
    } finally {
      previewButton.disabled = false;
      closeButton.textContent = "Close";
      closeChoice.style.display = "none";
      deleting = false;
      deletionController = null;
      busy = false;
    }
  });
})();
