"use strict";

const DEFAULT_SYSTEM_PROMPT = [
  "你是 Ting Reader 的个人书单助手。",
  "你可以根据用户可访问的馆藏（library_context）、最近播放、当前书籍上下文和对话历史，帮助用户挑书、整理主题书单、解释推荐理由。",
  "只返回 JSON 对象，不要 Markdown，不要代码块。",
  "JSON 字段：reply, suggested_booklist, tool_actions。",
  "reply 是给用户看的中文回答，说明你做了什么、为什么推荐、还需要用户提供什么。",
  "suggested_booklist 是本轮打算展示的书单草稿，可为空；如果存在，格式为 { name, goal, description, books }。",
  "books 必须是数组，每项为 { book_id, title, author, narrator, reason }。**必须**优先使用 library_context.recommendations / library_context.books 中出现过的真实 book_id，不要编造不存在的 book_id 或书名；如果馆藏里确实没有匹配项，让 books 保持空数组并在 reply 中说明。",
  "tool_actions 是本轮要真正落库执行的动作数组，宿主会按顺序执行。",
  "**规则**：只要 suggested_booklist 有实际的 books（books.length > 0），你就**必须**在 tool_actions 里放一个对应的 booklist.create，让宿主把这个书单真正保存下来。仅当用户明确说“不用保存 / 不要建书单 / 只是问问” 时才可以省略 tool_actions。",
  "支持的 tool_actions：",
  "  - { name: 'booklist.create', input: { name, goal, description, books, list_id? } } 创建或按 name/list_id 更新书单，books 结构与 suggested_booklist.books 一致（可以直接复用 suggested_booklist 的字段）。",
  "  - { name: 'booklist.add_book', input: { list_name?|list_id?, book_id, reason? } } 向已有书单追加一本书。",
  "如果推荐结果只有一本或很少，只要用户没说“更多”，也照实推荐这几本，不要为了凑数编造。",
  "reply 中请告诉用户你已经把书单保存了什么名字，方便用户在“书单”标签里查看。",
].join("\n");

const CACHE_PREFIX = "ai-booklist-assistant";
const MAX_BOOKLISTS = 50;
const MAX_BOOKLIST_ITEMS = 120;
const MAX_CONVERSATIONS = 30;
const DEFAULT_RECOMMENDATION_LIMIT = 8;

async function openAssistant(params) {
  return {
    ok: true,
    state: await getAssistantState(params || {}),
  };
}

async function invokeTool(params) {
  const name = params?.name || params?.tool || params?.tool_name || "assistant.state";
  const input = params?.input || params?.params || {};

  switch (name) {
    case "assistant.state":
      return getAssistantState({ ...input, _context: params?._context });
    case "assistant.chat":
      return chat({ ...input, _context: params?._context });
    case "assistant.load_conversation":
      return loadConversationById({ ...input, _context: params?._context });
    case "books.recommend":
      return recommendBooks({ ...input, _context: params?._context });
    case "booklist.create":
      return createBooklist({ ...input, _context: params?._context });
    case "booklist.add_book":
      return addBookToList({ ...input, _context: params?._context });
    case "booklist.list":
      return listBooklists({ ...input, _context: params?._context });
    case "booklist.export":
      return exportBooklists({ ...input, _context: params?._context });
    default:
      throw new Error(`Unknown assistant tool: ${name}`);
  }
}

async function handleChatRoute(request) {
  const body = parseJsonObject(request?.body_text || "{}") || {};
  const result = await chat({
    ...body,
    _context: {
      plugin_id: request?.plugin_id,
      capability_id: request?.capability_id,
      route: request?.context,
    },
  });

  return jsonResponse(result);
}

async function addCurrentBookAction(params) {
  const contextBook = extractContextBook(params);
  if (!contextBook?.id) {
    return {
      ok: false,
      message: "当前页面没有可加入书单的书籍上下文。",
    };
  }

  return addBookToList({
    ...params,
    book_id: contextBook.id,
    list_name: await defaultListName(params),
    reason: "从书籍详情页快速加入。",
  });
}

async function saveAssistantSettings(params) {
  const values = params?.values || {};
  const settings = {
    default_list_name: stringValue(values.default_list_name, await defaultListName(params)),
    auto_save_suggestions: Boolean(values.auto_save_suggestions),
    recommendation_limit: integerValue(
      values.recommendation_limit,
      DEFAULT_RECOMMENDATION_LIMIT,
      1,
      30,
    ),
    updated_at: nowIso(),
  };

  await cacheSet(userCacheKey(params, "settings"), settings);
  return {
    ok: true,
    message: "书单助手偏好已保存。",
    settings,
  };
}

async function getAssistantState(params) {
  const config = readConfig();
  const settings = await loadUserSettings(params);
  const [conversationIndex, booklists] = await Promise.all([
    safeAsync(() => loadConversationIndex(params), { items: [] }),
    safeAsync(() => loadBooklists(params), { items: [] }),
  ]);

  return {
    ok: true,
    ai_configured: Boolean(config.apiKey),
    model: config.model,
    settings: {
      default_list_name: await defaultListName(params, settings),
      auto_save_suggestions:
        typeof settings.auto_save_suggestions === "boolean"
          ? settings.auto_save_suggestions
          : config.autoSaveSuggestions,
      recommendation_limit: integerValue(
        settings.recommendation_limit,
        DEFAULT_RECOMMENDATION_LIMIT,
        1,
        30,
      ),
    },
    conversations: conversationIndex.items || [],
    booklists: booklists.items || [],
    recent_progress: [],
    context: publicContext(params),
  };
}

async function chat(params) {
  const message = firstText(params?.message, params?.prompt, params?.input, "");
  if (!message) {
    throw new Error("assistant.chat requires message");
  }

  const config = readConfig();
  const settings = await loadUserSettings(params);
  const conversation = await loadConversation(params);
  const userMessage = {
    role: "user",
    content: message,
    at: nowIso(),
  };
  const context = await buildAssistantContext(message, params, settings);

  let assistantResult;
  if (config.apiKey) {
    try {
      assistantResult = await askModel({
        config,
        conversation,
        userMessage,
        context,
      });
    } catch (error) {
      Ting?.log?.warn?.(`AI assistant request failed: ${error}`);
      assistantResult = await ruleBasedAssistant(message, context);
      assistantResult.model_error = String(error);
    }
  } else {
    assistantResult = await ruleBasedAssistant(message, context);
  }

  // 执行模型返回的 tool_actions（真正落库到插件缓存）。
  const executedActions = await executeToolActions(
    assistantResult.tool_actions,
    params,
    context,
  );

  // 兜底：只要有 suggested_booklist 且 books 非空，就自动落库；
  // 除非用户明确说“不用保存”，或者 shouldAutoSave 显式关闭 + 用户显式拒绝。
  const suggested = assistantResult.suggested_booklist;
  const hasBooks = suggested && Array.isArray(suggested.books) && suggested.books.length > 0;
  const alreadySavedByModel = executedActions.some(
    (action) => action.name === "booklist.create" && action.ok,
  );
  if (!alreadySavedByModel && hasBooks && !wantsSkipSave(message)) {
    try {
      const created = await createBooklist({
        ...params,
        ...suggested,
        source: "assistant.chat",
        _context: params?._context,
      });
      executedActions.push({
        name: "booklist.create",
        ok: true,
        booklist: created?.booklist || null,
        auto: true,
      });
    } catch (error) {
      executedActions.push({
        name: "booklist.create",
        ok: false,
        error: String(error),
        auto: true,
      });
    }
  }

  const savedBooklist =
    executedActions
      .filter((action) => action.ok && action.booklist)
      .map((action) => action.booklist)
      .pop() || null;

  const assistantMessage = {
    role: "assistant",
    content: assistantResult.reply,
    at: nowIso(),
    meta: {
      suggested_booklist: assistantResult.suggested_booklist || null,
      model_error: assistantResult.model_error || null,
      local_fallback: !config.apiKey || Boolean(assistantResult.model_error),
      tool_actions: executedActions,
      saved_booklist_id: savedBooklist?.id || null,
      saved_booklist_name: savedBooklist?.name || null,
    },
  };

  conversation.messages = trimMessages([
    ...(conversation.messages || []),
    userMessage,
    assistantMessage,
  ], config.maxHistoryMessages);
  conversation.title = conversation.title || conversationTitle(message);
  conversation.updated_at = assistantMessage.at;
  await saveConversation(params, conversation);

  return {
    ok: true,
    conversation_id: conversation.id,
    conversation,
    reply: assistantResult.reply,
    suggested_booklist: assistantResult.suggested_booklist || null,
    tool_actions: executedActions,
    saved_booklist: savedBooklist,
    ai_configured: Boolean(config.apiKey),
  };
}

async function askModel({ config, conversation, userMessage, context }) {
  const messages = [
    {
      role: "system",
      content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Use the user's library context and conversation to answer. Return JSON only.",
        library_context: context,
        conversation_history: (conversation.messages || []).slice(-config.maxHistoryMessages),
        latest_user_message: userMessage,
      }),
    },
  ];

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      response_format: { type: "json_object" },
    }),
  });

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    const message = payload?.error?.message || "AI response does not contain message content";
    throw new Error(message);
  }

  return normalizeAssistantResult(parseJsonObject(content), context);
}

async function ruleBasedAssistant(message, context) {
  const recommended = context.recommendations || [];
  const suggested = recommended.length
    ? {
        name: inferBooklistName(message, context),
        goal: message,
        description: "根据当前馆藏、最近播放和关键词自动生成。",
        books: recommended.map((item) => ({
          book_id: item.id,
          title: item.title,
          author: item.author,
          narrator: item.narrator,
          reason: item.reason || "与你的请求或最近播放记录相关。",
        })),
      }
    : null;

  const reply = recommended.length
    ? [
        `我先按本地规则整理了 ${recommended.length} 本可听书。`,
        `建议书单：${suggested.name}。`,
        recommended
          .slice(0, 5)
          .map((book, index) => `${index + 1}. ${book.title}${book.author ? ` / ${book.author}` : ""}`)
          .join("\n"),
      ].join("\n")
    : "我还没有找到足够的馆藏线索。你可以换一个主题，或先添加更多书籍后再让我整理书单。";

  return {
    reply,
    suggested_booklist: suggested,
  };
}

function normalizeAssistantResult(raw, context) {
  const reply = firstText(
    raw?.reply,
    raw?.message,
    raw?.answer,
    "我已经整理好了建议，但模型没有返回可展示的正文。",
  );
  const suggested = normalizeSuggestedBooklist(raw?.suggested_booklist || raw?.booklist, context);
  const toolActions = normalizeToolActions(raw?.tool_actions || raw?.actions);
  return {
    reply,
    suggested_booklist: suggested,
    tool_actions: toolActions,
  };
}

function normalizeToolActions(raw) {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(["booklist.create", "booklist.add_book"]);
  const actions = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = firstText(item.name, item.tool, item.action, "");
    if (!allowed.has(name)) continue;
    const input =
      item.input && typeof item.input === "object"
        ? item.input
        : item.params && typeof item.params === "object"
        ? item.params
        : {};
    actions.push({ name, input });
    if (actions.length >= 5) break;
  }
  return actions;
}

function wantsSkipSave(message) {
  const text = String(message || "");
  return /不用(?:保存|建|创建)|别(?:保存|建|创建)|不要(?:保存|建|创建)(?:书单)?|只是(?:问问|看看)|不用加入书单|不用加进书单|不需要保存|不需要建/.test(
    text,
  );
}

async function executeToolActions(actions, params, context) {
  const list = Array.isArray(actions) ? actions : [];
  const results = [];
  for (const action of list) {
    const name = action?.name;
    const input = action?.input || {};
    try {
      if (name === "booklist.create") {
        const created = await createBooklist({
          ...params,
          ...input,
          source: input?.source || "assistant.chat",
          _context: params?._context,
        });
        results.push({
          name,
          ok: true,
          booklist: created?.booklist || null,
        });
      } else if (name === "booklist.add_book") {
        const added = await addBookToList({
          ...params,
          ...input,
          _context: params?._context,
        });
        results.push({
          name,
          ok: true,
          booklist: added?.booklist || null,
        });
      } else {
        results.push({ name: name || "unknown", ok: false, error: "unsupported tool" });
      }
    } catch (error) {
      results.push({ name: name || "unknown", ok: false, error: String(error) });
    }
  }
  return results;
}

function normalizeSuggestedBooklist(raw, context) {
  if (!raw || typeof raw !== "object") return null;
  const knownBooks = new Map();
  for (const book of context?.recommendations || []) {
    knownBooks.set(book.id, book);
  }
  for (const book of context?.books || []) {
    knownBooks.set(book.id, book);
  }
  const books = Array.isArray(raw.books) ? raw.books : [];
  const normalizedBooks = books
    .map((book) => {
      const id = firstText(book?.book_id, book?.id, "");
      const known = id ? knownBooks.get(id) : null;
      const title = firstText(book?.title, known?.title, "");
      if (!id && !title) return null;
      return {
        book_id: id || known?.id || null,
        title,
        author: firstOptionalText(book?.author, known?.author),
        narrator: firstOptionalText(book?.narrator, known?.narrator),
        reason: firstText(book?.reason, known?.reason, "适合这个书单主题。"),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_BOOKLIST_ITEMS);

  if (normalizedBooks.length === 0) return null;
  return {
    name: firstText(raw.name, raw.title, "AI 推荐书单"),
    goal: firstText(raw.goal, raw.prompt, ""),
    description: firstText(raw.description, raw.summary, ""),
    books: normalizedBooks,
  };
}

async function buildAssistantContext(message, params, settings) {
  const limit = integerValue(
    params?.limit || settings?.recommendation_limit,
    DEFAULT_RECOMMENDATION_LIMIT,
    1,
    30,
  );
  const [recommendations, booklists] = await Promise.all([
    recommendBooks({ query: message, limit, context: params?.context, _context: params?._context }),
    loadBooklists(params),
  ]);

  const contextBook = extractContextBook(params);
  const currentBook = contextBook?.id
    ? await safeHostInvoke("books.get", { book_id: contextBook.id }, compactBook(contextBook))
    : contextBook;

  return {
    user: publicContext(params).user,
    current_book: currentBook ? compactBook(currentBook) : null,
    recent_progress: [],
    recommendations: recommendations.items || [],
    booklists: (booklists.items || []).map((list) => ({
      id: list.id,
      name: list.name,
      goal: list.goal,
      item_count: Array.isArray(list.items) ? list.items.length : 0,
      updated_at: list.updated_at,
    })),
    books: recommendations.items || [],
  };
}

async function recommendBooks(params) {
  const query = firstText(params?.query, params?.theme, params?.prompt, params?.message, "");
  const limit = integerValue(params?.limit, DEFAULT_RECOMMENDATION_LIMIT, 1, 50);
  const tokens = tokenize(query);
  const authorHints = extractAuthorHints(query);
  const allTokens = [...new Set([...tokens, ...authorHints])];
  const contextBook = extractContextBook(params);

  const byId = new Map();
  const collect = (items) => {
    for (const book of items || []) {
      if (!book) continue;
      const compact = compactBook(book);
      if (compact?.id) byId.set(compact.id, compact);
    }
  };

  if (query) {
    const searchResult = await safeHostInvoke(
      "books.list",
      { search: query, limit: 80 },
      { items: [] },
    );
    collect(searchResult.items);
  }

  // 分词回退：用拆出来的关键词逐个搜索，把可能命中作者/主播/别名的书都聚合进来。
  const searchTerms = new Set();
  for (const token of tokens) {
    if (token.length >= 2) searchTerms.add(token);
  }
  // 用户消息里带作者/主播关键字时也追加原文片段
  for (const hint of authorHints) searchTerms.add(hint);

  for (const term of searchTerms) {
    if (byId.size >= Math.max(limit * 3, 60)) break;
    const result = await safeHostInvoke(
      "books.list",
      { search: term, limit: 40 },
      { items: [] },
    );
    collect(result.items);
  }

  // 全量兜底：仅当 search 完全没有命中时才抓 120 本，避免无关书籍淹没真实结果
  if (byId.size === 0) {
    const allResult = await safeHostInvoke("books.list", { limit: 120 }, { items: [] });
    collect(allResult.items);
  }

  if (contextBook?.id) {
    byId.set(contextBook.id, compactBook(contextBook));
  }

  const recentIds = new Map();

  const scored = [...byId.values()]
    .map((book) => {
      const score = scoreBook(book, allTokens, recentIds, contextBook);
      return {
        ...book,
        score,
        reason: recommendationReason(book, allTokens, recentIds, contextBook),
      };
    })
    // 不过滤掉后端 search 搜到的书（它们已经通过了后端匹配）；
    // score=0 的书只是排序靠后，但仍保留给 AI 参考。
    // 仅当完全没有 query 时，才过滤掉空 id。
    .filter((book) => book.id)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, limit);

  return {
    ok: true,
    query,
    total_candidates: byId.size,
    items: scored,
  };
}

function extractAuthorHints(text) {
  const raw = String(text || "");
  if (!raw) return [];
  const hints = new Set();
  const patterns = [
    /作者(?:是|叫|为|:|：)?\s*([\u4e00-\u9fffA-Za-z0-9_\-·]{1,20})/g,
    /主播(?:是|叫|为|:|：)?\s*([\u4e00-\u9fffA-Za-z0-9_\-·]{1,20})/g,
    /播讲(?:人|者)?(?:是|叫|为|:|：)?\s*([\u4e00-\u9fffA-Za-z0-9_\-·]{1,20})/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      if (match[1]) hints.add(match[1]);
    }
  }
  return [...hints];
}

async function createBooklist(params) {
  const listName = firstText(params?.name, params?.title, await defaultListName(params));
  const books = await resolveBooksForList(params);
  const items = mergeBooklistItems([], books, params?.reason);
  const bookItems = items
    .filter((item) => item.book_id)
    .map((item, index) => ({ item_type: "book", item_id: item.book_id, item_order: index }));

  const description = firstText(params?.goal, params?.prompt, params?.query, params?.description, "由 AI 书单助手生成。");

  let playlistId = firstText(params?.list_id, params?.id, "");

  if (playlistId) {
    for (const bookItem of bookItems) {
      try {
        await hostInvoke("playlists.add_item", {
          playlist_id: playlistId,
          item_type: bookItem.item_type,
          item_id: bookItem.item_id,
        });
      } catch (error) {
        Ting?.log?.warn?.(`playlists.add_item failed: ${error}`);
      }
    }
  } else {
    const created = await hostInvoke("playlists.create", {
      name: listName,
      description,
      items: bookItems,
    });
    playlistId = firstText(created?.id, created?.playlist?.id, "");
  }

  const booklist = {
    id: playlistId || stableId(`${listName}:${nowIso()}`),
    name: listName,
    goal: firstText(params?.goal, params?.prompt, params?.query, ""),
    description,
    source: firstText(params?.source, "manual"),
    items,
    created_at: nowIso(),
    updated_at: nowIso(),
    playlist_id: playlistId || null,
  };

  return {
    ok: true,
    booklist,
    booklists: await loadBooklists(params),
    playlist_id: booklist.playlist_id,
  };
}

async function addBookToList(params) {
  const listName = firstText(params?.list_name, params?.name, await defaultListName(params));
  const playlistId = firstText(params?.list_id, params?.id, "");

  const books = await resolveBooksForList({
    ...params,
    limit: 1,
    name: listName,
  });
  if (books.length === 0) {
    throw new Error("没有找到可加入书单的书籍。");
  }

  if (playlistId) {
    await hostInvoke("playlists.add_item", {
      playlist_id: playlistId,
      item_type: "book",
      item_id: books[0].book_id,
    });
    return createBooklist({ ...params, list_id: playlistId, name: listName, books: [] });
  }

  return createBooklist({
    ...params,
    name: listName,
    goal: params?.goal || "临时收藏想听的书。",
    books,
    reason: firstText(params?.reason, "手动加入。"),
  });
}

async function listBooklists(params) {
  const booklists = await loadBooklists(params);
  return {
    ok: true,
    booklists: booklists.items || [],
  };
}

async function exportBooklists(params) {
  const booklists = await loadBooklists(params);
  const format = firstText(params?.format, "markdown").toLowerCase();
  const listId = firstText(params?.list_id, params?.id, "");
  const lists = listId
    ? (booklists.items || []).filter((item) => item.id === listId)
    : booklists.items || [];

  if (format === "json") {
    return {
      ok: true,
      format,
      content: JSON.stringify({ booklists: lists }, null, 2),
      booklists: lists,
    };
  }

  return {
    ok: true,
    format: "markdown",
    content: booklistsToMarkdown(lists),
    booklists: lists,
  };
}

async function resolveBooksForList(params) {
  if (Array.isArray(params?.books) && params.books.length > 0) {
    return params.books.map(compactBookish).filter(Boolean);
  }

  if (Array.isArray(params?.book_ids) && params.book_ids.length > 0) {
    const books = [];
    for (const bookId of params.book_ids.slice(0, MAX_BOOKLIST_ITEMS)) {
      const book = await safeHostInvoke("books.get", { book_id: String(bookId) }, null);
      if (book) books.push(compactBookish(book));
    }
    return books.filter(Boolean);
  }

  const bookId = firstText(params?.book_id, params?.id, "");
  if (bookId) {
    const book = await safeHostInvoke("books.get", { book_id: bookId }, null);
    return book ? [compactBookish(book)] : [];
  }

  const contextBook = extractContextBook(params);
  if (contextBook?.id && !firstText(params?.query, params?.prompt, params?.goal, "")) {
    return [compactBookish(contextBook)].filter(Boolean);
  }

  const recommended = await recommendBooks(params);
  return (recommended.items || []).map(compactBookish).filter(Boolean);
}

function mergeBooklistItems(existingItems, books, fallbackReason) {
  const byId = new Map();
  for (const item of existingItems || []) {
    const key = item.book_id || item.id || item.title;
    if (key) byId.set(key, item);
  }

  for (const book of books || []) {
    const key = book.book_id || book.id || book.title;
    if (!key) continue;
    const previous = byId.get(key);
    byId.set(key, {
      book_id: book.book_id || book.id || previous?.book_id || null,
      title: firstText(book.title, previous?.title, "未命名书籍"),
      author: firstOptionalText(book.author, previous?.author),
      narrator: firstOptionalText(book.narrator, previous?.narrator),
      cover_url: firstOptionalText(book.cover_url, previous?.cover_url),
      reason: firstText(book.reason, previous?.reason, fallbackReason, "适合这个书单。"),
      added_at: previous?.added_at || nowIso(),
    });
  }

  return [...byId.values()];
}

async function loadBooklists(params) {
  const result = await safeHostInvoke("playlists.list", { limit: 50 }, { items: [] });
  const playlists = result?.items || [];
  const items = [];
  for (const pl of playlists) {
    const plItems = Array.isArray(pl.items) ? pl.items : [];
    const books = [];
    for (const plItem of plItems) {
      if (plItem.item_type !== "book" || !plItem.item_id) continue;
      const book = await safeHostInvoke("books.get", { book_id: plItem.item_id }, null);
      if (book) {
        const compact = compactBook(book);
        if (compact) {
          books.push({
            book_id: compact.id,
            title: compact.title,
            author: compact.author || null,
            narrator: compact.narrator || null,
            reason: "",
            added_at: pl.created_at || null,
          });
        }
      }
    }
    items.push({
      id: pl.id,
      name: pl.name,
      goal: pl.description || "",
      description: pl.description || "",
      source: "playlist",
      items: books,
      created_at: pl.created_at || null,
      updated_at: pl.updated_at || null,
      playlist_id: pl.id,
    });
  }
  return { items, updated_at: null };
}

async function loadConversation(params) {
  const conversationId = firstText(params?.conversation_id, params?.id, "");
  if (conversationId) {
    const existing = await cacheGet(userCacheKey(params, `conversation:${conversationId}`), null);
    if (existing?.id) return existing;
  }

  const now = nowIso();
  return {
    id: conversationId || stableId(`${now}:${Math.random()}`),
    title: "",
    messages: [],
    created_at: now,
    updated_at: now,
  };
}

async function loadConversationById(params) {
  const conversation = await loadConversation(params);
  return {
    ok: true,
    conversation,
    conversation_id: conversation.id,
  };
}

async function saveConversation(params, conversation) {
  await cacheSet(userCacheKey(params, `conversation:${conversation.id}`), conversation);
  const index = await loadConversationIndex(params);
  const current = (index.items || []).filter((item) => item.id !== conversation.id);
  const summary = {
    id: conversation.id,
    title: conversation.title || "新的对话",
    updated_at: conversation.updated_at,
    created_at: conversation.created_at,
    message_count: (conversation.messages || []).length,
  };
  await cacheSet(userCacheKey(params, "conversation-index"), {
    items: [summary, ...current].slice(0, MAX_CONVERSATIONS),
    updated_at: nowIso(),
  });
}

async function loadConversationIndex(params) {
  const value = await cacheGet(userCacheKey(params, "conversation-index"), { items: [] });
  return {
    items: Array.isArray(value?.items) ? value.items : [],
    updated_at: value?.updated_at || null,
  };
}

async function loadUserSettings(params) {
  return await cacheGet(userCacheKey(params, "settings"), {});
}

async function defaultListName(params, settings) {
  const loaded = settings || (await loadUserSettings(params));
  return firstText(
    loaded?.default_list_name,
    readConfig().defaultListName,
    "想听书单",
  );
}

async function cacheGet(key, fallback) {
  const result = await hostInvoke("cache.get", { key });
  return result?.hit ? result.value : fallback;
}

async function cacheSet(key, value) {
  return await hostInvoke("cache.set", { key, value });
}

async function hostInvoke(method, params) {
  if (!Ting?.host?.invoke) {
    throw new Error("Ting.host.invoke is not available in this runtime");
  }
  return await Ting.host.invoke(method, params || {});
}

async function safeHostInvoke(method, params, fallback) {
  try {
    return await hostInvoke(method, params || {});
  } catch (error) {
    Ting?.log?.warn?.(`Host method ${method} failed: ${error}`);
    return fallback;
  }
}

async function safeAsync(action, fallback) {
  try {
    return await action();
  } catch (error) {
    Ting?.log?.warn?.(`Assistant state load failed: ${error}`);
    return fallback;
  }
}

function userCacheKey(params, suffix) {
  const user = publicContext(params).user;
  const userId = firstText(user?.id, "anonymous");
  return `${CACHE_PREFIX}:user:${stableId(userId)}:${suffix}`;
}

function publicContext(params) {
  const raw = getHostContext(params);
  const route = raw?.route || raw?.context || {};
  const user = route?.user || null;
  return {
    authenticated: route?.authenticated === true,
    access: route?.access || "unknown",
    user: user
      ? {
          id: user.id,
          username: user.username,
          role: user.role,
        }
      : null,
  };
}

function getHostContext(params) {
  const runtimeContext = Ting?.host?.getContext?.();
  if (runtimeContext) return runtimeContext;
  if (params?._context) return params._context;
  if (params?.context?.authenticated !== undefined) {
    return {
      route: params.context,
      plugin_id: params.plugin_id,
      capability_id: params.capability_id,
    };
  }
  return null;
}

function extractContextBook(params) {
  const context = params?.context || {};
  const candidates = [
    context.book,
    context.current_book,
    context.reader?.book,
    params?.book,
    params?.current_book,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return compactBook(candidate);
    }
  }
  const bookId = firstText(context.book_id, context.id, params?.book_id, "");
  return bookId ? { id: bookId, title: firstText(context.title, "") } : null;
}

function compactBookish(value) {
  if (!value || typeof value !== "object") return null;
  const book = compactBook(value);
  if (!book.id && !book.title) return null;
  return {
    book_id: book.id || value.book_id || null,
    id: book.id || value.book_id || null,
    title: book.title,
    author: book.author,
    narrator: book.narrator,
    cover_url: book.cover_url,
    reason: firstText(value.reason, book.reason, ""),
  };
}

function compactBook(book) {
  if (!book || typeof book !== "object") return null;
  return {
    id: firstText(book.id, book.book_id, ""),
    title: firstText(book.title, book.book_title, book.name, "未命名书籍"),
    author: firstOptionalText(book.author),
    narrator: firstOptionalText(book.narrator),
    cover_url: firstOptionalText(book.cover_url),
    description: firstOptionalText(book.description, book.intro),
    tags: normalizeTags(book.tags),
    genre: firstOptionalText(book.genre),
    year: book.year || null,
    library_id: firstOptionalText(book.library_id),
    updated_at: firstOptionalText(book.updated_at, book.created_at),
  };
}

function scoreBook(book, tokens, recentIds, contextBook) {
  let score = 0;
  const haystack = [
    book.title,
    book.author,
    book.narrator,
    book.genre,
    Array.isArray(book.tags) ? book.tags.join(" ") : "",
    book.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  for (const token of tokens) {
    if (haystack.includes(token.toLowerCase())) score += token.length >= 2 ? 3 : 1;
  }
  if (recentIds.has(book.id)) score += 2;
  if (contextBook?.id && contextBook.id === book.id) score += 4;
  if (tokens.length === 0) score += 1;
  return score;
}

function recommendationReason(book, tokens, recentIds, contextBook) {
  if (contextBook?.id && contextBook.id === book.id) {
    return "这是当前正在查看的书，适合作为书单起点。";
  }
  const matched = tokens.filter((token) => {
    const text = [book.title, book.author, book.narrator, book.genre, book.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return text.includes(token.toLowerCase());
  });
  if (matched.length > 0) {
    return `匹配主题关键词：${matched.slice(0, 3).join("、")}。`;
  }
  if (recentIds.has(book.id)) {
    return "来自最近播放记录，适合继续收听或扩展同类书单。";
  }
  return "来自当前可访问馆藏。";
}

function booklistsToMarkdown(lists) {
  if (!lists || lists.length === 0) return "# 书单\n\n暂无书单。";
  return lists
    .map((list) => {
      const lines = [
        `# ${list.name || "未命名书单"}`,
        "",
        list.goal ? `目标：${list.goal}` : "",
        list.description ? `说明：${list.description}` : "",
        "",
        ...(list.items || []).map((item, index) => {
          const author = item.author ? ` / ${item.author}` : "";
          const reason = item.reason ? ` - ${item.reason}` : "";
          return `${index + 1}. ${item.title || item.book_id}${author}${reason}`;
        }),
      ];
      return lines.filter((line, index) => line || index < 2).join("\n");
    })
    .join("\n\n");
}

function inferBooklistName(message, context) {
  const query = firstText(message, context?.current_book?.title, "AI 推荐书单");
  const cleaned = query
    .replace(/[，。！？!?、,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "AI 推荐书单";
  if (cleaned.length <= 16) return `${cleaned}书单`;
  return `${cleaned.slice(0, 16)}书单`;
}

function conversationTitle(message) {
  const text = String(message || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 24 ? `${text.slice(0, 24)}...` : text || "新的对话";
}

function trimMessages(messages, maxHistoryMessages) {
  const max = integerValue(maxHistoryMessages, 16, 4, 40);
  return (messages || []).slice(-max);
}

function tokenize(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ");
  const rough = normalized.split(/\s+/).filter(Boolean);
  const tokens = [];
  for (const part of rough) {
    if (/[\u4e00-\u9fff]/.test(part) && part.length > 4) {
      for (let i = 0; i <= part.length - 2; i += 2) {
        tokens.push(part.slice(i, i + 2));
      }
    }
    tokens.push(part);
  }
  return [...new Set(tokens)].slice(0, 20);
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
  }
  if (typeof value === "string") {
    return value
      .split(/[，,;；|/]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}

function readConfig() {
  const config = Ting?.config || {};
  return {
    endpoint: normalizeEndpoint(stringValue(config.api_base_url, "https://api.openai.com/v1/chat/completions")),
    apiKey: stringValue(config.api_key, ""),
    model: stringValue(config.model, "gpt-4.1-mini"),
    temperature: numberValue(config.temperature, 0.35, 0, 1),
    maxHistoryMessages: integerValue(config.max_history_messages, 16, 4, 40),
    defaultListName: stringValue(config.default_list_name, "想听书单"),
    autoSaveSuggestions: Boolean(config.auto_save_suggestions),
    systemPrompt: stringValue(config.system_prompt, ""),
  };
}

function normalizeEndpoint(value) {
  const endpoint = String(value || "").trim().replace(/\/+$/, "");
  if (!endpoint) return "https://api.openai.com/v1/chat/completions";
  if (endpoint.endsWith("/chat/completions")) return endpoint;
  if (endpoint.endsWith("/v1")) return `${endpoint}/chat/completions`;
  return `${endpoint}/v1/chat/completions`;
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    try {
      return JSON.parse(withoutFence);
    } catch (_) {
      const start = withoutFence.indexOf("{");
      const end = withoutFence.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(withoutFence.slice(start, end + 1));
      }
      throw new Error("JSON parse failed");
    }
  }
}

function jsonResponse(value, status) {
  return {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(value),
  };
}

function stableId(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstOptionalText(...values) {
  const text = firstText(...values);
  return text || null;
}

function stringValue(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function integerValue(value, fallback, min, max) {
  return Math.round(numberValue(value, fallback, min, max));
}

function nowIso() {
  return new Date().toISOString();
}
