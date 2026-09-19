let models = [];
let currentModel = "llama-3.2-3b";

async function fetchHealth() {
  try {
    const r = await fetch("/health");
    const data = await r.json();
    document.getElementById("health").innerHTML = `✓ Uptime: ${data.uptime_seconds}s | Active Sessions: ${data.active_sessions} | Concurrency: ${data.config?.max_concurrency || 32} | Default: ${data.config?.default_model || 'unknown'}`;
  } catch (e) {
    document.getElementById("health").textContent = "✗ Health failed: " + e;
  }
}

async function fetchModels() {
  try {
    const r = await fetch("/v1/models");
    const data = await r.json();
    models = data.data || [];
    const sel = document.getElementById("modelSelect");
    sel.innerHTML = "";
    // Group by provider
    const groups = {};
    models.forEach(m => {
      const prov = m.provider || "unknown";
      if (!groups[prov]) groups[prov] = [];
      groups[prov].push(m);
    });
    for (const [prov, list] of Object.entries(groups)) {
      const og = document.createElement("optgroup");
      og.label = prov;
      list.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m.id;
        const caps = [];
        if (m.capabilities?.reasoning) caps.push("🧠");
        if (m.capabilities?.search) caps.push("🔍");
        opt.textContent = `${m.id} ${caps.join("")} (${m.owned_by})`;
        if (m.id === currentModel) opt.selected = true;
        og.appendChild(opt);
      });
      sel.appendChild(og);
    }
    updateModelInfo();
  } catch (e) {
    console.error(e);
  }
}

function updateModelInfo() {
  const sel = document.getElementById("modelSelect");
  const mid = sel.value;
  currentModel = mid;
  const info = models.find(m => m.id === mid);
  const el = document.getElementById("modelInfo");
  if (info) {
    el.innerHTML = `Provider: ${info.provider} | Owner: ${info.owned_by} | Context: ${info.context || '?'} | Reasoning: ${info.capabilities?.reasoning ? 'yes' : 'no'} | Search: ${info.capabilities?.search ? 'yes' : 'no'}`;
  }
}

async function sendChat() {
  const prompt = document.getElementById("userPrompt").value.trim();
  const system = document.getElementById("systemPrompt").value.trim();
  const model = document.getElementById("modelSelect").value;
  const search = document.getElementById("searchToggle").checked;
  const stream = document.getElementById("streamToggle").checked;
  const temp = parseFloat(document.getElementById("tempSlider").value);
  const maxTokens = parseInt(document.getElementById("maxTokens").value);

  if (!prompt) return alert("Enter prompt");

  const chatBox = document.getElementById("chatBox");
  const usageEl = document.getElementById("usage");
  chatBox.innerHTML = "";
  usageEl.textContent = "Sending...";

  const body = {
    model: model,
    prompt: prompt,
    system: system || undefined,
    search: search,
    stream: stream,
    temperature: temp,
    max_tokens: maxTokens,
  };

  try {
    if (stream) {
      const resp = await fetch("/v1/chat", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.text();
        chatBox.innerHTML = `<span class="error">Error ${resp.status}: ${err}</span>`;
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoning = "";
      let sources = [];

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split("\n\n");
        buffer = lines.pop();

        for (const chunk of lines) {
          if (!chunk.trim()) continue;
          const eventMatch = chunk.match(/event:\s*(\w+)\s*\ndata:\s*([\s\S]*)/);
          if (!eventMatch) continue;
          const event = eventMatch[1];
          let data;
          try { data = JSON.parse(eventMatch[2]); } catch { continue; }

          if (event === "delta") {
            content += data.delta || "";
            chatBox.innerHTML = `<div class="thinking">${reasoning}</div><div class="content">${content}</div>` + (sources.length ? `<div class="sources">Sources: ${sources.map(s=>`<a href="${s.url}" target="_blank">${s.title}</a>`).join(", ")}</div>` : "");
            chatBox.scrollTop = chatBox.scrollHeight;
          } else if (event === "reasoning") {
            reasoning += data.delta || "";
            chatBox.innerHTML = `<div class="thinking">💭 ${reasoning}</div><div class="content">${content}</div>`;
          } else if (event === "search") {
            if (data.sources) sources = data.sources;
            chatBox.innerHTML = `<div class="thinking">${reasoning}</div><div class="content">${content}</div><div class="sources">🔍 Found ${sources.length} sources: ${sources.map(s=>`<a href="${s.url}" target="_blank">${s.title}</a>`).join(", ")}</div>`;
          } else if (event === "sources") {
            sources = data.sources || [];
          } else if (event === "done") {
            usageEl.textContent = `Done: ${content.length} chars, ${reasoning.length} thinking, ${sources.length} sources`;
          } else if (event === "error") {
            chatBox.innerHTML += `<div class="error">Error: ${data.detail}</div>`;
          } else if (event === "summary") {
            usageEl.textContent = `✓ ${data.model} via ${data.provider} | ${content.length} chars | ${sources.length} sources`;
          }
        }
      }

    } else {
      // Non-streaming
      const resp = await fetch("/v1/chat", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({...body, stream: false}),
      });
      const data = await resp.json();
      chatBox.textContent = data.content || JSON.stringify(data, null, 2);
      usageEl.textContent = `Done: ${data.content?.length || 0} chars`;
    }

  } catch (e) {
    chatBox.innerHTML = `<span class="error">Failed: ${e}</span>`;
  }
}

async function fetchUsers() {
  try {
    const r = await fetch("/v1/users");
    const data = await r.json();
    document.getElementById("usersStats").textContent = `Total: ${data.total} active`;
    const list = document.getElementById("usersList");
    list.innerHTML = Object.entries(data.active_sessions || {}).map(([uid, lastId]) => `<div>${uid}: ${lastId || 'no response'} (reqs: ${data.request_counts[uid]||0})</div>`).join("") || "No active sessions";
  } catch (e) {
    console.error(e);
  }
}

async function runLoadTest() {
  const nUsers = parseInt(document.getElementById("nUsers").value);
  const prompt = document.getElementById("loadPrompt").value;
  const model = document.getElementById("loadModel").value || currentModel;
  const parallel = document.getElementById("loadParallel").checked;
  const search = document.getElementById("loadSearch").checked;

  const resultsEl = document.getElementById("loadResults");
  resultsEl.innerHTML = `Running load test with ${nUsers} users, parallel=${parallel}, model=${model}...`;

  try {
    const resp = await fetch("/v1/users/loadtest", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({n_users: nUsers, prompt: prompt, model: model, parallel: parallel, search: search}),
    });
    const data = await resp.json();

    let html = `<div><b>Load Test Results:</b> ${data.n_users} users, parallel=${data.parallel}, success ${data.ok}/${data.n_users} (${data.success_rate}%), total ${data.total_elapsed}s, avg ${data.avg_elapsed}s, first token avg ${data.avg_first_token || '?'}s, tokens ${data.total_tokens_est} (~${data.tokens_per_second} tok/s)</div>`;
    html += `<table><tr><th>User</th><th>OK</th><th>Elapsed</th><th>First Token</th><th>Len</th><th>Preview</th></tr>`;
    (data.results || []).forEach(r => {
      html += `<tr><td>${r.user_id}</td><td>${r.ok ? '✓' : '✗ ' + (r.error||'').slice(0,30)}</td><td>${r.elapsed}s</td><td>${r.first_token||'?'}s</td><td>${r.content_len||0}</td><td>${(r.content||'').slice(0,80)}</td></tr>`;
    });
    html += `</table>`;
    resultsEl.innerHTML = html;

  } catch (e) {
    resultsEl.textContent = "Load test failed: " + e;
  }
}

async function testSearch() {
  const query = document.getElementById("searchQuery").value;
  const el = document.getElementById("searchResults");
  el.textContent = "Searching...";

  try {
    // Use chat endpoint with search=true and a simple prompt to trigger search
    // But we also have direct search via provider? For now, we test via loadtest? Actually we have no direct search endpoint, so we test via chat with search
    // Let's create a simple endpoint? For now, we call the search via backend's global_search directly? No API, so we simulate via chat that yields sources first
    const resp = await fetch("/v1/chat", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model: currentModel, prompt: query, search: true, stream: true}),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sources = [];

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split("\n\n");
      buffer = lines.pop();
      for (const chunk of lines) {
        const m = chunk.match(/event:\s*(\w+)\s*\ndata:\s*([\s\S]*)/);
        if (!m) continue;
        const event = m[1];
        let data;
        try { data = JSON.parse(m[2]); } catch { continue; }
        if (event === "search" || event === "sources") {
          if (data.sources) sources = data.sources;
          el.innerHTML = `Found ${sources.length} sources:<br>` + sources.map(s=>`<div><a href="${s.url}" target="_blank">${s.title}</a><br><small>${s.url}</small></div>`).join("");
        }
      }
      if (sources.length) break; // we got sources, stop reading
    }

    if (!sources.length) el.textContent = "No sources found (search may be disabled or failed)";

  } catch (e) {
    el.textContent = "Search failed: " + e;
  }
}

async function testIP() {
  const el = document.getElementById("ipResult");
  el.textContent = "Fetching...";
  try {
    const r = await fetch("/health");
    const data = await r.json();
    // Try to get IP via headers? We have X-Detected-IP header
    // Fetch with verbose?
    const r2 = await fetch("/v1/users");
    const ipHeader = r2.headers.get("X-Detected-IP") || "unknown (check Network tab for X-Detected-IP header)";
    el.innerHTML = `Detected IP (pseudonymized): ${ipHeader}<br><small>Real IP extraction via CF-Connecting-IP > True-Client-IP > X-Real-IP > XFF > client.host<br>Check browser Network tab for X-Detected-IP header on any request</small>`;
  } catch (e) {
    el.textContent = "IP test failed: " + e;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  fetchHealth();
  fetchModels();
  fetchUsers();

  document.getElementById("refreshModels").onclick = fetchModels;
  document.getElementById("modelSelect").onchange = updateModelInfo;
  document.getElementById("sendBtn").onclick = sendChat;
  document.getElementById("clearBtn").onclick = () => { document.getElementById("chatBox").innerHTML = ""; document.getElementById("usage").textContent = ""; };
  document.getElementById("clearHistoryBtn").onclick = async () => { await fetch("/v1/session/reset", {method: "POST"}); document.getElementById("chatBox").innerHTML = "History cleared"; };
  document.getElementById("refreshUsers").onclick = fetchUsers;
  document.getElementById("runLoadTest").onclick = runLoadTest;
  document.getElementById("testSearch").onclick = testSearch;
  document.getElementById("testIP").onclick = testIP;
  document.getElementById("tempSlider").oninput = (e) => { document.getElementById("tempVal").textContent = e.target.value; };

  setInterval(fetchHealth, 10000);
  setInterval(fetchUsers, 15000);
});
