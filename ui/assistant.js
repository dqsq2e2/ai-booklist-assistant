(function () {
  "use strict";

  // 该助手 UI 只能有一份实例；重复注入直接退出。
  if (window.__aiBooklistAssistantStarted) {
    return;
  }
  window.__aiBooklistAssistantStarted = true;

  var BRIDGE_TIMEOUT_MS = 30000;

  var pending = new Map();
  var pluginContext = null;
  var bridgeToken = null;
  var welcomeShown = false;
  var state = { conversations: [], ai_configured: false };
  var activeConversationId = null;
  var activeDraft = null;
  var stateLoading = false;
  var language = "zh-CN";

  var text = {
    zh: {
      timeout: "插件桥接请求超时，请刷新面板或检查后端插件日志。",
      callFailed: "插件调用失败",
      loading: "加载中",
      waitingForHost: "等待宿主上下文…",
      syncing: "同步中",
      loadingConversation: "加载对话",
      configured: "AI 已配置 · ",
      localMode: "本地规则模式",
      processing: "整理中...",
      ready: "AI 已就绪。你可以让我按馆藏整理书单，也可以直接说出想读的作者、题材或播讲人。",
      noApiKey: "当前没有配置 AI Key，我会先用本地规则按馆藏生成书单。",
      actionFailed: "执行失败",
      suggestedBooklist: "建议书单",
      books: " 本书",
      saveBooklist: "保存书单",
      autoSaved: "已自动保存到 “",
      booklist: "书单",
      autoSavedEnd: "”",
      noHistory: "还没有对话历史",
      newConversation: "新建对话",
      newConversationTitle: "新的对话",
      messages: " 条消息 · ",
      error: "错误："
    },
    en: {
      timeout: "Plugin bridge request timed out. Refresh the panel or check the plugin logs.",
      callFailed: "Plugin call failed",
      loading: "Loading",
      waitingForHost: "Waiting for host context...",
      syncing: "Syncing",
      loadingConversation: "Loading conversation",
      configured: "AI configured · ",
      localMode: "Local rules mode",
      processing: "Working...",
      ready: "AI is ready. Ask me to organize your library into a booklist, or name an author, genre, or narrator you want to hear.",
      noApiKey: "No AI key is configured, so I will create booklists from your library with local rules.",
      actionFailed: "Action failed",
      suggestedBooklist: "Suggested booklist",
      books: " books",
      saveBooklist: "Save booklist",
      autoSaved: "Automatically saved to \"",
      booklist: "booklist",
      autoSavedEnd: "\"",
      noHistory: "No conversation history yet",
      newConversation: "New conversation",
      newConversationTitle: "New conversation",
      messages: " messages · ",
      error: "Error: "
    }
  };

  var els = {
    status: document.getElementById("status"),
    title: document.getElementById("title"),
    refresh: document.getElementById("refreshBtn"),
    tabChat: document.getElementById("tabChat"),
    tabHistory: document.getElementById("tabHistory"),
    chatView: document.getElementById("chatView"),
    historyView: document.getElementById("historyView"),
    messages: document.getElementById("messages"),
    history: document.getElementById("history"),
    composer: document.getElementById("composer"),
    prompt: document.getElementById("prompt"),
    send: document.getElementById("sendBtn"),
    quickRecent: document.getElementById("quickRecent"),
    quickSleep: document.getElementById("quickSleep"),
    quickLearning: document.getElementById("quickLearning")
  };

  function setStatus(text, failed) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.classList.toggle("error", Boolean(failed));
  }

  function isEnglish() {
    return String(language || "").toLowerCase().indexOf("en") === 0;
  }

  function t(key) {
    var table = isEnglish() ? text.en : text.zh;
    return table[key] || text.zh[key] || key;
  }

  function applyLanguage(value) {
    language = String(value || "zh-CN");
    document.documentElement.lang = isEnglish() ? "en" : "zh-CN";
    if (els.refresh) els.refresh.title = isEnglish() ? "Refresh" : "刷新";
    if (els.title) els.title.textContent = isEnglish() ? "Booklist Assistant" : "书单助手";
    if (els.tabChat) els.tabChat.textContent = isEnglish() ? "Chat" : "对话";
    if (els.tabHistory) els.tabHistory.textContent = isEnglish() ? "History" : "历史";
    if (els.quickRecent) {
      els.quickRecent.textContent = isEnglish() ? "Recent listening" : "最近播放";
      els.quickRecent.setAttribute(
        "data-quick",
        isEnglish()
          ? "Organize an 8-book continue-list from my recent listening"
          : "按最近播放整理 8 本续听书单"
      );
    }
    if (els.quickSleep) {
      els.quickSleep.textContent = isEnglish() ? "Before bed" : "睡前听";
      els.quickSleep.setAttribute(
        "data-quick",
        isEnglish()
          ? "Create a relaxing booklist for listening before bed"
          : "帮我建一个适合睡前听的放松书单"
      );
    }
    if (els.quickLearning) {
      els.quickLearning.textContent = isEnglish() ? "Learning" : "学习主题";
      els.quickLearning.setAttribute(
        "data-quick",
        isEnglish()
          ? "Recommend a booklist for learning and knowledge"
          : "按知识学习主题推荐一个书单"
      );
    }
    if (els.prompt) {
      els.prompt.placeholder = isEnglish()
        ? "For example: make a six-book mystery starter list from my library"
        : "例如：帮我从馆藏里建一个 6 本的推理入门书单";
    }
    if (els.send) els.send.textContent = isEnglish() ? "Send" : "发送";
    document.title = isEnglish() ? "Booklist Assistant" : "书单助手";
    renderHistory();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function bridgeRequest(method, params) {
    if (!bridgeToken) {
      return Promise.reject(new Error(t("waitingForHost")));
    }
    var id = String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    return new Promise(function (resolve, reject) {
      var timer = window.setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(t("timeout")));
      }, BRIDGE_TIMEOUT_MS);
      pending.set(id, {
        resolve: function (value) { window.clearTimeout(timer); resolve(value); },
        reject: function (err) { window.clearTimeout(timer); reject(err); }
      });
      try {
        window.__TING_PLUGIN_BRIDGE__.postMessage({
          type: "ting-plugin:request",
          id: id,
          method: method,
          params: params,
          bridge_token: bridgeToken
        });
      } catch (err) {
        window.clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  function invokeTool(name, input) {
    var payload = Object.assign({}, input || {});
    if (pluginContext && pluginContext.context && !payload.context) {
      payload.context = pluginContext.context;
    }
    return bridgeRequest("capability.invoke", {
      capabilityId: "assistant.tools",
      params: { name: name, input: payload }
    });
  }

  function loadLanguage() {
    return bridgeRequest("host.invoke", {
      method: "user_settings.get",
      params: { key: "language" }
    }).then(function (result) {
      applyLanguage(result && result.value);
    }).catch(function () {
      applyLanguage("zh-CN");
    });
  }

  function applyHostTheme(theme) {
    var source = theme || {};
    var value = String(source.colorScheme || source.brightness || "").toLowerCase();
    var scheme = value.indexOf("dark") >= 0 ? "dark" : value.indexOf("light") >= 0 ? "light" : "";
    if (!scheme) return;
    document.documentElement.dataset.tingTheme = scheme;
    document.documentElement.style.colorScheme = scheme;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "ting-plugin:init") {
      bridgeToken = data.bridgeToken || null;
      pluginContext = data;
      applyHostTheme(data.theme);
      // Read the account language whenever this UI is opened, then render.
      loadLanguage().then(loadState);
      return;
    }

    if (data.type === "ting-plugin:response" && data.bridge_token === bridgeToken && pending.has(data.id)) {
      var callbacks = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) {
        callbacks.resolve(data.result);
      } else {
        callbacks.reject(new Error(data.error || t("callFailed")));
      }
    }
  });

  function switchTab(tab) {
    if (els.tabChat) els.tabChat.classList.toggle("active", tab === "chat");
    if (els.tabHistory) els.tabHistory.classList.toggle("active", tab === "history");
    if (els.chatView) els.chatView.classList.toggle("active", tab === "chat");
    if (els.historyView) els.historyView.classList.toggle("active", tab === "history");
  }

  function renderWelcome() {
    if (!els.messages || welcomeShown) return;
    welcomeShown = true;
    var text = state.ai_configured
      ? t("ready")
      : t("noApiKey");
    appendMessage("assistant", text);
  }

  function toolActionsLabel(actions) {
    if (!actions || !actions.length) return "";
    var lines = [];
    for (var i = 0; i < actions.length; i += 1) {
      var action = actions[i] || {};
      if (action.ok === false) {
        lines.push("× " + (action.name || "action") + ": " + (action.error || t("actionFailed")));
      } else {
        var title = "";
        if (action.booklist && action.booklist.name) title = action.booklist.name;
        lines.push("✓ " + (action.name || "action") + (title ? "（" + title + "）" : ""));
      }
    }
    return lines.join("\n");
  }

  function appendMessage(role, content, meta) {
    if (!els.messages) return null;
    var node = document.createElement("div");
    node.className = "message " + role;
    node.textContent = content;

    if (role === "assistant" && meta) {
      var actionsText = toolActionsLabel(meta.tool_actions);
      if (actionsText) {
        var log = document.createElement("div");
        log.className = "tool-log";
        log.textContent = actionsText;
        node.appendChild(log);
      }
      if (meta.suggested_booklist) {
        var draft = document.createElement("div");
        var count = (meta.suggested_booklist.books || []).length;
        draft.className = "draft";
        draft.innerHTML =
          "<strong>" + escapeHtml(meta.suggested_booklist.name || t("suggestedBooklist")) + "</strong><br>" +
          count + t("books");
        if (!meta.saved_booklist_id) {
          var button = document.createElement("button");
          button.type = "button";
          button.textContent = t("saveBooklist");
          button.style.marginTop = "8px";
          button.addEventListener("click", function () {
            activeDraft = meta.suggested_booklist;
            saveDraft(button);
          });
          draft.appendChild(button);
        } else {
          var savedTag = document.createElement("div");
          savedTag.style.marginTop = "6px";
          savedTag.textContent = t("autoSaved") + (meta.saved_booklist_name || t("booklist")) + t("autoSavedEnd");
          draft.appendChild(savedTag);
        }
        node.appendChild(draft);
      }
    }

    els.messages.appendChild(node);
    els.messages.scrollTop = els.messages.scrollHeight;
    return node;
  }

  function replaceLastAssistant(content, failed) {
    if (!els.messages) return;
    var nodes = els.messages.querySelectorAll(".message.assistant");
    var node = nodes[nodes.length - 1];
    if (!node) {
      appendMessage("assistant", content);
      return;
    }
    while (node.firstChild) node.removeChild(node.firstChild);
    node.textContent = content;
    node.classList.toggle("error", Boolean(failed));
  }

  function renderConversation(conversation) {
    if (!els.messages) return;
    els.messages.innerHTML = "";
    welcomeShown = true;
    var messages = conversation && conversation.messages ? conversation.messages : [];
    for (var i = 0; i < messages.length; i += 1) {
      var m = messages[i];
      appendMessage(m.role === "user" ? "user" : "assistant", m.content, m.meta);
    }
  }

  function renderHistory() {
    if (!els.history) return;
    var conversations = state.conversations || [];
    if (conversations.length === 0) {
      els.history.innerHTML = '<div class="empty">' + escapeHtml(t("noHistory")) + '</div>';
      return;
    }
    els.history.innerHTML = "";
    var newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "primary";
    newBtn.textContent = t("newConversation");
    newBtn.style.marginBottom = "10px";
    newBtn.addEventListener("click", function () {
      activeConversationId = null;
      welcomeShown = false;
      if (els.messages) els.messages.innerHTML = "";
      renderWelcome();
      switchTab("chat");
    });
    els.history.appendChild(newBtn);

    for (var i = 0; i < conversations.length; i += 1) {
      var conv = conversations[i];
      var card = document.createElement("article");
      card.className = "card";
      card.style.cursor = "pointer";
      var title = conv.title || t("newConversationTitle");
      var count = conv.message_count || 0;
      var time = conv.updated_at || conv.created_at || "";
      card.innerHTML =
        "<h2>" + escapeHtml(title) + "</h2>" +
        "<p>" + count + t("messages") + escapeHtml(time.slice(0, 16).replace("T", " ")) + "</p>";
      card.addEventListener("click", (function (cid) {
        return function () {
          activeConversationId = cid;
          loadConversation(cid);
          switchTab("chat");
        };
      })(conv.id));
      els.history.appendChild(card);
    }
  }

  function loadConversation(conversationId) {
    if (!conversationId) return;
    setStatus(t("loadingConversation"));
    invokeTool("assistant.load_conversation", { conversation_id: conversationId })
      .then(function (result) {
        if (result.conversation) {
          renderConversation(result.conversation);
        }
        setStatus(state.ai_configured ? t("configured") + (state.model || "") : t("localMode"));
      })
      .catch(function (error) {
        setStatus(String(error && error.message ? error.message : error), true);
      });
  }

  function loadState() {
    if (stateLoading) return;
    stateLoading = true;
    setStatus(t("syncing"));
    invokeTool("assistant.state", {})
      .then(function (result) {
        state = result || state;
        setStatus(state.ai_configured ? t("configured") + (state.model || "") : t("localMode"));
        renderHistory();
        renderWelcome();
      })
      .catch(function (error) {
        setStatus(String(error && error.message ? error.message : error), true);
        // 加载失败也给一个回落欢迎语，避免面板一直空白
        renderWelcome();
      })
      .then(function () {
        stateLoading = false;
      });
  }

  function sendPrompt(text) {
    var message = String(text || "").trim();
    if (!message) return;
    els.prompt.value = "";
    els.send.disabled = true;
    appendMessage("user", message);
    var pendingNode = appendMessage("assistant", t("processing"));

    invokeTool("assistant.chat", {
      conversation_id: activeConversationId,
      message: message
    })
      .then(function (result) {
        activeConversationId = result.conversation_id || activeConversationId;
        activeDraft = result.suggested_booklist || null;
        renderConversation(result.conversation);
        loadState();
      })
      .catch(function (error) {
        var msg = String(error && error.message ? error.message : error);
        if (pendingNode) {
          while (pendingNode.firstChild) pendingNode.removeChild(pendingNode.firstChild);
          pendingNode.textContent = t("error") + msg;
          pendingNode.classList.add("error");
        } else {
          replaceLastAssistant(t("error") + msg, true);
        }
      })
      .then(function () {
        els.send.disabled = false;
      });
  }

  function bindEvents() {
    if (els.refresh) els.refresh.addEventListener("click", loadState);
    if (els.tabChat) els.tabChat.addEventListener("click", function () { switchTab("chat"); });
    if (els.tabHistory) els.tabHistory.addEventListener("click", function () { switchTab("history"); });
    if (els.composer) {
      els.composer.addEventListener("submit", function (event) {
        event.preventDefault();
        sendPrompt(els.prompt.value);
      });
    }
    var quickButtons = document.querySelectorAll("[data-quick]");
    for (var i = 0; i < quickButtons.length; i += 1) {
      quickButtons[i].addEventListener("click", function () {
        var text = this.getAttribute("data-quick") || "";
        els.prompt.value = text;
        sendPrompt(text);
      });
    }
  }

  bindEvents();
  setStatus(t("loading"));

  // Host init carries the per-document bridge token. Do not invoke before it arrives.
  window.setTimeout(function () {
    if (!pluginContext) {
      setStatus(t("waitingForHost"));
    }
  }, 800);
})();
