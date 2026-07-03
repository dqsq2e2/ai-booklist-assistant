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
  var welcomeShown = false;
  var state = { conversations: [], ai_configured: false };
  var activeConversationId = null;
  var activeDraft = null;
  var stateLoading = false;

  var els = {
    status: document.getElementById("status"),
    refresh: document.getElementById("refreshBtn"),
    tabChat: document.getElementById("tabChat"),
    tabHistory: document.getElementById("tabHistory"),
    chatView: document.getElementById("chatView"),
    historyView: document.getElementById("historyView"),
    messages: document.getElementById("messages"),
    history: document.getElementById("history"),
    composer: document.getElementById("composer"),
    prompt: document.getElementById("prompt"),
    send: document.getElementById("sendBtn")
  };

  function setStatus(text, failed) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.classList.toggle("error", Boolean(failed));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function bridgeRequest(method, params) {
    var id = String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    return new Promise(function (resolve, reject) {
      var timer = window.setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error("插件桥接请求超时，请刷新面板或检查后端插件日志。"));
      }, BRIDGE_TIMEOUT_MS);
      pending.set(id, {
        resolve: function (value) { window.clearTimeout(timer); resolve(value); },
        reject: function (err) { window.clearTimeout(timer); reject(err); }
      });
      try {
        window.parent.postMessage({ type: "ting-plugin:request", id: id, method: method, params: params }, "*");
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

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "ting-plugin:init") {
      pluginContext = data;
      // 只有拿到宿主上下文后才刷新状态；欢迎语根据真实 ai_configured 渲染。
      loadState();
      return;
    }

    if (data.type === "ting-plugin:response" && pending.has(data.id)) {
      var callbacks = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) {
        callbacks.resolve(data.result);
      } else {
        callbacks.reject(new Error(data.error || "插件调用失败"));
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
      ? "AI 已就绪。你可以让我按馆藏整理书单，也可以直接说出想读的作者、题材或播讲人。"
      : "当前没有配置 AI Key，我会先用本地规则按馆藏生成书单。";
    appendMessage("assistant", text);
  }

  function toolActionsLabel(actions) {
    if (!actions || !actions.length) return "";
    var lines = [];
    for (var i = 0; i < actions.length; i += 1) {
      var action = actions[i] || {};
      if (action.ok === false) {
        lines.push("× " + (action.name || "action") + "：" + (action.error || "执行失败"));
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
          "<strong>" + escapeHtml(meta.suggested_booklist.name || "建议书单") + "</strong><br>" +
          count + " 本书";
        if (!meta.saved_booklist_id) {
          var button = document.createElement("button");
          button.type = "button";
          button.textContent = "保存书单";
          button.style.marginTop = "8px";
          button.addEventListener("click", function () {
            activeDraft = meta.suggested_booklist;
            saveDraft(button);
          });
          draft.appendChild(button);
        } else {
          var savedTag = document.createElement("div");
          savedTag.style.marginTop = "6px";
          savedTag.textContent = "已自动保存到 “" + (meta.saved_booklist_name || "书单") + "”";
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
      els.history.innerHTML = '<div class="empty">还没有对话历史</div>';
      return;
    }
    els.history.innerHTML = "";
    var newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "primary";
    newBtn.textContent = "新建对话";
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
      var title = conv.title || "新的对话";
      var count = conv.message_count || 0;
      var time = conv.updated_at || conv.created_at || "";
      card.innerHTML =
        "<h2>" + escapeHtml(title) + "</h2>" +
        "<p>" + count + " 条消息 · " + escapeHtml(time.slice(0, 16).replace("T", " ")) + "</p>";
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
    setStatus("加载对话");
    invokeTool("assistant.load_conversation", { conversation_id: conversationId })
      .then(function (result) {
        if (result.conversation) {
          renderConversation(result.conversation);
        }
        setStatus(state.ai_configured ? "AI 已配置 · " + (state.model || "") : "本地规则模式");
      })
      .catch(function (error) {
        setStatus(String(error && error.message ? error.message : error), true);
      });
  }

  function loadState() {
    if (stateLoading) return;
    stateLoading = true;
    setStatus("同步中");
    invokeTool("assistant.state", {})
      .then(function (result) {
        state = result || state;
        setStatus(state.ai_configured ? "AI 已配置 · " + (state.model || "") : "本地规则模式");
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
    var pendingNode = appendMessage("assistant", "整理中...");

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
          pendingNode.textContent = "Error: " + msg;
          pendingNode.classList.add("error");
        } else {
          replaceLastAssistant("Error: " + msg, true);
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
  setStatus("加载中");

  // 兜底：如果 800ms 内还没收到 init，就先尝试加载状态；仍失败时提示可以直接输入。
  window.setTimeout(function () {
    if (!pluginContext) {
      setStatus("等待宿主上下文…");
      loadState();
    }
  }, 800);
})();
