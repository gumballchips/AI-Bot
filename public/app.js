// Client-side chat with simple KB UI
const chatEl = document.getElementById("chat");
const form = document.getElementById("chat-form");
const input = document.getElementById("input");
const modelInput = document.getElementById("model");
const addDocBtn = document.getElementById("add-doc");
const docTitle = document.getElementById("doc-title");
const docContent = document.getElementById("doc-content");
const kbList = document.getElementById("kb-list");
const listDocsBtn = document.getElementById("list-docs");

// Keep conversation locally
const messages = [
  {
    role: "system",
    content: "You are a helpful, concise, and friendly AI assistant. Ask clarifying questions when needed."
  }
];

function renderMessages() {
  chatEl.innerHTML = "";
  for (const m of messages.slice(1)) {
    const div = document.createElement("div");
    div.classList.add("message");
    div.classList.add(m.role === "user" ? "user" : "assistant");
    div.textContent = m.content;
    chatEl.appendChild(div);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function sendMessage(text) {
  messages.push({ role: "user", content: text });
  renderMessages();

  // show typing placeholder
  const typing = { role: "assistant", content: "..." };
  messages.push(typing);
  renderMessages();

  try {
    const payload = { messages };
    const modelVal = modelInput.value.trim();
    if (modelVal) payload.model = modelVal;
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || "Server error");
    }
    messages.pop();
    messages.push({ role: "assistant", content: data.reply.trim() });
    renderMessages();
  } catch (err) {
    messages.pop();
    messages.push({ role: "assistant", content: "Error: " + err.message });
    renderMessages();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sendMessage(text);
});

addDocBtn.addEventListener("click", async () => {
  const title = docTitle.value.trim();
  const content = docContent.value.trim();
  if (!content) {
    alert("Please paste document text to add.");
    return;
  }
  addDocBtn.disabled = true;
  addDocBtn.textContent = "Adding…";
  try {
    const res = await fetch("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Failed to add doc");
    docTitle.value = "";
    docContent.value = "";
    await listDocs();
    alert("Document added to knowledge base.");
  } catch (err) {
    alert("Error adding doc: " + err.message);
  } finally {
    addDocBtn.disabled = false;
    addDocBtn.textContent = "Add to KB";
  }
});

async function listDocs() {
  try {
    const res = await fetch("/api/docs");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Failed");
    kbList.innerHTML = data.data.map(d => `<div>• [${d.id}] ${d.title ?? "untitled"} — ${d.snippet}</div>`).join("");
  } catch (err) {
    kbList.innerHTML = "Error listing docs: " + err.message;
  }
}

listDocsBtn.addEventListener("click", listDocs);

renderMessages();
listDocs();
