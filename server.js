import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { OpenAI } from "openai";
import Database from "better-sqlite3";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Read the key from environment (set this locally in .env or in Actions secrets)
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// If running in CI or production, require the key and exit if missing.
// This avoids confusing runs in CI and prevents accidental missing-key deployments.
const runningInCI = process.env.GITHUB_ACTIONS === "true";
const runningInProd = process.env.NODE_ENV === "production";

if (!OPENAI_KEY) {
  if (runningInCI || runningInProd) {
    console.error("ERROR: OPENAI_API_KEY is not set. In CI/production this is required. Please add it as a repository secret (OPENAI_API_KEY) or set NODE_ENV accordingly.");
    process.exit(1);
  } else {
    console.warn("WARNING: OPENAI_API_KEY is not set. Set it in your .env file for local development, or as a repository secret for Actions/production.");
  }
}

const MODEL = process.env.OPENAI_MODEL || "gpt-4";

const client = new OpenAI({ apiKey: OPENAI_KEY });

// Initialize SQLite vector store (very small/simple for local use)
const db = new Database(path.join(__dirname, "data", "kb.sqlite"), { readonly: false });
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  title TEXT,
  content TEXT,
  embedding TEXT, -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// Utility: cosine similarity
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a) {
  return Math.sqrt(dot(a, a));
}
function cosineSim(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

// Endpoint: add a document/snippet to KB
// body: { title: string, content: string }
app.post("/api/docs", async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!content || typeof content !== "string") {
      return res.status(400).json({ error: "content is required" });
    }
    // create embedding
    const embResp = await client.embeddings.create({
      model: "text-embedding-3-large",
      input: content
    });
    const embedding = embResp.data[0].embedding;
    const stmt = db.prepare("INSERT INTO documents (title, content, embedding) VALUES (?, ?, ?)");
    const info = stmt.run(title || null, content, JSON.stringify(embedding));
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error("Error adding document:", err);
    res.status(500).json({ error: "failed to add document", details: String(err) });
  }
});

// Endpoint: list docs (for small debug UI)
app.get("/api/docs", (req, res) => {
  try {
    const rows = db.prepare("SELECT id, title, substr(content,1,800) as snippet, created_at FROM documents ORDER BY created_at DESC").all();
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list documents" });
  }
});

// Main chat endpoint with moderation + RAG
// body: { messages: [{role, content}], model?: string }
app.post("/api/chat", async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      return res.status(500).json({ error: "Server not configured with OPENAI_API_KEY" });
    }
    const messages = req.body.messages;
    const model = req.body.model || MODEL;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const lastContent = lastUser?.content ?? "";

    // 1) Moderation check (simple)
    try {
      const mod = await client.moderations.create({
        model: "omni-moderation-latest",
        input: lastContent
      });
      const categories = mod.results?.[0];
      if (categories && categories.flagged) {
        return res.status(403).json({ error: "Content flagged by moderation" });
      }
    } catch (merr) {
      console.warn("Moderation check failed, continuing:", merr?.message ?? merr);
      // non-fatal: continue
    }

    // 2) Compute embedding for last user message to retrieve relevant docs
    let contextText = "";
    try {
      const qEmbResp = await client.embeddings.create({
        model: "text-embedding-3-large",
        input: lastContent
      });
      const qEmbedding = qEmbResp.data[0].embedding;

      // load documents and compute similarity (brute force)
      const rows = db.prepare("SELECT id, title, content, embedding FROM documents").all();
      const scored = [];
      for (const r of rows) {
        try {
          const docEmb = JSON.parse(r.embedding);
          const score = cosineSim(qEmbedding, docEmb);
          scored.push({ id: r.id, title: r.title, content: r.content, score });
        } catch (e) {
          // ignore malformed
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 3).filter(s => s.score > 0.65); // threshold; tune as needed

      if (top.length) {
        contextText = top.map((t, i) => `--- DOCUMENT ${i + 1} (${t.title ?? "untitled"}, score=${t.score.toFixed(3)}) ---\n${t.content}`).join("\n\n");
      }
    } catch (rerr) {
      console.warn("RAG retrieval failed:", rerr?.message ?? rerr);
      // non-fatal: continue without context
    }

    // 3) Construct a strong system prompt + include retrieved context if available
    const systemPromptParts = [
      "You are an extremely capable, safe, and concise AI assistant. Help the user solve problems across many domains: programming, writing, math, planning, troubleshooting, and general knowledge. When appropriate:",
      "- Ask clarifying questions before assuming.",
      "- Provide step-by-step plans, example code, and explanation in simple terms.",
      "- If an answer requires external resources or current events beyond your knowledge, say so and offer a plan to find the info.",
      "- If multiple reasonable options exist, list them with pros/cons.",
      "- Keep answers factual, avoid hallucinations, and cite the provided documents when they are used."
    ];
    if (contextText) {
      systemPromptParts.push("The following documents were retrieved from the user's knowledge base and may be relevant. Use them to inform your answer and cite them inline when referenced:\n" + contextText);
    }
    const systemPrompt = systemPromptParts.join("\n\n");

    // 4) Build final messages array: strong system prompt + conversation (we keep conversation but replace the original system)
    const finalMessages = [
      { role: "system", content: systemPrompt },
      ...messages.filter(m => m.role !== "system") // keep user's prior and assistant messages (but replace system)
    ];

    // 5) Call chat completion
    const chatResp = await client.chat.completions.create({
      model,
      messages: finalMessages,
      temperature: 0.2,
      max_tokens: 1200
    });

    const reply = chatResp.choices?.[0]?.message?.content ?? "";
    res.json({ reply });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal server error", details: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI chat server listening on http://localhost:${PORT}`);
});
