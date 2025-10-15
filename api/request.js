// api/request.js
// Edge function that builds & deploys a tiny app from a brief.
// - Verifies secret
// - Generates index.html & README.md with Anthropic (Claude) (has fallback)
// - Creates/updates public GitHub repo (task name), enables Pages
// - Notifies evaluation_url with repo_url, commit_sha, pages_url

export const config = { runtime: "edge" };

const GH_API = "https://api.github.com";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

/* -------------------- helpers -------------------- */
const J = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const toB64 = (s) => btoa(unescape(encodeURIComponent(s)));
const readSnippet = async (res) => (await res.text().catch(() => "")).slice(0, 500);

/* -------------------- Anthropic -------------------- */
async function anthropicHTML(brief, attachments = [], checks = []) {
  const attachmentText = attachments.length
    ? `\n\nAttachments:\n${attachments.map(a => `- ${a.name || "file"}: ${(a.url || "").slice(0,60)}...`).join("\n")}`
    : "";
  const checksText = checks.length
    ? `\n\nEvaluation Checks:\n${checks.map((c,i)=>`${i+1}. ${c}`).join("\n")}`
    : "";

  const prompt = `You are an expert web developer. Create a COMPLETE, PRODUCTION-READY single-page HTML app.

BRIEF: ${brief}
${attachmentText}
${checksText}

REQUIREMENTS:
1) One self-contained HTML file (CSS in <style>, JS in <script>)
2) CDN libs only from https://cdnjs.cloudflare.com
3) Must be functional (no placeholders)
4) Good error handling
5) Semantic HTML5
6) Responsive & mobile-friendly
7) Clear comments
8) Professional UI

OUTPUT:
- Start with <!DOCTYPE html>
- End with </html>
- Output ONLY the HTML (no markdown/code fences).`;

  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status} ${r.statusText}: ${await readSnippet(r)}`);

  const data = await r.json();
  let code = data?.content?.[0]?.text || "";
  code = code.replace(/```html\n?/g, "").replace(/```\n?/g, "").trim();
  if (!code.startsWith("<!DOCTYPE html>") || !code.endsWith("</html>")) {
    throw new Error("Anthropic returned non-HTML or partial HTML");
  }
  return code;
}

function fallbackHTML(brief) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Fallback App</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.2/css/bootstrap.min.css"/>
<style>body{padding:2rem}</style>
</head>
<body class="container">
  <h1 class="mb-3">Fallback App</h1>
  <p class="text-muted">LLM generation failed; using fallback to continue deployment.</p>
  <div class="card"><div class="card-body">
    <h5 class="card-title">Brief</h5>
    <pre style="white-space:pre-wrap">${brief.replace(/[<>]/g, m => ({'<':'&lt;','>':'&gt;'}[m]))}</pre>
  </div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.2/js/bootstrap.bundle.min.js"></script>
</body></html>`;
}

async function anthropicREADME(brief, repoName) {
  const prompt = `Create a professional README.md for:

Repository: ${repoName}
Project Brief: ${brief}

Sections:
# Project Title
## Features
## Setup Instructions
## Usage Guide
## Code Structure
## Technologies Used
## License (MIT)

Output ONLY Markdown; no extra text.`;

  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic README ${r.status} ${r.statusText}: ${await readSnippet(r)}`);

  const data = await r.json();
  let md = data?.content?.[0]?.text || "";
  return md.replace(/```markdown\n?/g, "").replace(/```\n?/g, "").trim();
}

/* -------------------- GitHub -------------------- */
const ghHeaders = async () => ({
  "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
  "Accept": "application/vnd.github+json",
  "Content-Type": "application/json",
});

async function ghCreateRepo(name) {
  const r = await fetch(`${GH_API}/user/repos`, {
    method: "POST",
    headers: await ghHeaders(),
    body: JSON.stringify({
      name,
      description: "Auto-generated application using LLM",
      private: false,
      auto_init: true,
      license_template: "mit",
    }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    if (r.status === 422 && (j?.errors || []).some(e => e?.message?.includes("name already exists"))) {
      return { html_url: `https://github.com/${process.env.GITHUB_USERNAME}/${name}`, exists: true };
    }
    throw new Error(`GitHub create repo ${r.status}: ${j.message || r.statusText}`);
  }
  return r.json();
}

async function ghGetSha(owner, repo, path) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    headers: await ghHeaders(),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub get sha ${r.status} ${r.statusText}`);
  const j = await r.json();
  return j.sha || null;
}

async function ghPutFile(owner, repo, path, base64, message, sha = null) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: await ghHeaders(),
    body: JSON.stringify({ message, content: base64, ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`GitHub PUT ${path} ${r.status}: ${j.message || r.statusText}`);
  }
  return r.json();
}

async function ghEnablePages(owner, repo) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/pages`, {
    method: "POST",
    headers: await ghHeaders(),
    body: JSON.stringify({ build_type: "legacy", source: { branch: "main", path: "/" } }),
  });
  if (!r.ok && r.status !== 409) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`GitHub enable pages ${r.status}: ${j.message || r.statusText}`);
  }
  return `https://${owner}.github.io/${repo}/`;
}

async function ghLatestCommit(owner, repo, branch = "main") {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    headers: await ghHeaders(),
  });
  if (!r.ok) throw new Error(`GitHub ref ${r.status} ${r.statusText}`);
  const j = await r.json();
  return j?.object?.sha || "unknown";
}

/* -------------------- Notify evaluator -------------------- */
async function notify(url, payload, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.ok) return true;
    await new Promise(res => setTimeout(res, Math.pow(2, i) * 1000));
  }
  return false;
}

/* -------------------- handler -------------------- */
export default async function handler(req) {
  if (req.method !== "POST") return J(405, { error: "Method Not Allowed" });

  // Log which envs exist (booleans only, no secrets)
  console.log("ENV set ->",
    "GITHUB_USERNAME:", !!process.env.GITHUB_USERNAME,
    "GITHUB_TOKEN:", !!process.env.GITHUB_TOKEN,
    "STUDENT_SECRET:", !!process.env.STUDENT_SECRET,
    "ANTHROPIC_API_KEY:", !!process.env.ANTHROPIC_API_KEY
  );

  const body = await req.json().catch(() => ({}));
  const { email, secret, task, round, nonce, brief, checks = [], evaluation_url, attachments = [] } = body || {};

  // Request sanity log (safe)
  console.log("REQ ->",
    "email:", !!email,
    "secret_len:", (secret || "").length,
    "task:", task,
    "round:", round,
    "nonce_len:", (nonce || "").length,
    "has_brief:", !!brief,
    "eval_url:", !!evaluation_url
  );

  // Env presence check
  if (!process.env.GITHUB_USERNAME || !process.env.GITHUB_TOKEN || !process.env.STUDENT_SECRET || !process.env.ANTHROPIC_API_KEY) {
    return J(500, { error: "Server missing one or more env vars (see logs)" });
  }

  // Secret check
  if (!secret || secret !== process.env.STUDENT_SECRET) return J(403, { error: "Invalid secret" });

  // Required fields
  if (!email || !task || !round || !nonce || !brief || !evaluation_url) {
    return J(400, { error: "Missing required fields" });
  }

  try {
    const owner = process.env.GITHUB_USERNAME;

    // 1) HTML (with fallback)
    let html;
    try {
      console.log("STEP 1: Anthropic HTML…");
      html = await anthropicHTML(brief, attachments, checks);
      console.log("STEP 1: OK");
    } catch (e) {
      console.log("STEP 1 FAILED:", e.message);
      html = fallbackHTML(brief);
    }

    // 2) README (try, fallback)
    let readme;
    try {
      console.log("STEP 2: Anthropic README…");
      readme = await anthropicREADME(brief, task);
      console.log("STEP 2: OK");
    } catch (e) {
      console.log("STEP 2 FAILED:", e.message);
      readme = `# ${task}\n\nAuto-generated fallback README.\n\n## Brief\n\n${brief}\n\n## License\n\nMIT`;
    }

    // 3) Create/reuse repo
    console.log("STEP 3: Create/Reuse repo…");
    const repo = await ghCreateRepo(task);
    const repoUrl = repo?.html_url || `https://github.com/${owner}/${task}`;
    console.log("STEP 3: repo url ->", repoUrl);

    // 4) Push files
    console.log("STEP 4: Push files…");
    const idxSha = await ghGetSha(owner, task, "index.html");
    await ghPutFile(owner, task, "index.html", toB64(html), round === 1 ? "Add index.html" : `Update index.html - Round ${round}`, idxSha);

    const rmdSha = await ghGetSha(owner, task, "README.md");
    await ghPutFile(owner, task, "README.md", toB64(readme), round === 1 ? "Add README.md" : `Update README.md - Round ${round}`, rmdSha);

    // 5) Enable Pages
    console.log("STEP 5: Enable Pages…");
    const pagesUrl = await ghEnablePages(owner, task);
    console.log("STEP 5: pages ->", pagesUrl);

    // 6) Latest commit SHA
    console.log("STEP 6: Latest commit sha…");
    const commitSha = await ghLatestCommit(owner, task, "main");
    console.log("STEP 6: sha ->", commitSha.slice(0, 7));

    // 7) Notify evaluator
    console.log("STEP 7: Notify evaluator…", evaluation_url);
    const ok = await notify(evaluation_url, { email, task, round, nonce, repo_url: repoUrl, commit_sha: commitSha, pages_url: pagesUrl });
    if (!ok) throw new Error("Evaluation notification failed after retries");
    console.log("STEP 7: OK");

    return J(200, { status: "ok", repo_url: repoUrl, commit_sha: commitSha, pages_url: pagesUrl });
  } catch (e) {
    console.log("FATAL:", e.message);
    return J(500, { error: e.message || String(e) });
  }
}
