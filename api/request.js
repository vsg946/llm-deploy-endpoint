// api/request.js
// Vercel Edge Function: handles round 1 & 2
// - verifies secret
// - generates index.html & README.md with Anthropic (Claude)
// - creates/updates public GitHub repo named by "task"
// - pushes files, enables GitHub Pages
// - POSTs back to evaluation_url with repo_url, commit_sha, pages_url

export const config = { runtime: "edge" };

const GH_API = "https://api.github.com";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

async function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toBase64(str) {
  // Edge runtime has btoa; ensure Unicode safety
  return btoa(unescape(encodeURIComponent(str)));
}

async function anthropicGenerateHTML(brief, attachments = [], checks = []) {
  const attachmentText = attachments.length
    ? `\n\nAttachments:\n${attachments.map(a => `- ${a.name}: ${a.url.substring(0, 60)}...`).join('\n')}`
    : '';
  const checksText = checks.length
    ? `\n\nEvaluation Checks:\n${checks.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';

  const prompt = `You are an expert web developer. Create a COMPLETE, PRODUCTION-READY single-page HTML application.

BRIEF: ${brief}
${attachmentText}
${checksText}

CRITICAL REQUIREMENTS:
1) Output ONE self-contained HTML file (CSS in <style>, JS in <script>)
2) Use CDN links ONLY from https://cdnjs.cloudflare.com for any libraries
3) Must be fully functional — no placeholders
4) Robust error handling
5) Modern, semantic HTML5
6) Responsive and mobile-friendly
7) Clear code comments
8) Professional UI

IMPORTANT OUTPUT FORMAT:
- Start with <!DOCTYPE html>
- End with </html>
- Output ONLY the HTML code, NO explanations, NO markdown, NO code fences.

Generate the complete application now:`;

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

  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}`);
  const data = await r.json();
  let code = data?.content?.[0]?.text || "";
  // Clean any stray code fences just in case
  code = code.replace(/```html\n?/g, "").replace(/```\n?/g, "").trim();
  if (!code.startsWith("<!DOCTYPE html>") || !code.endsWith("</html>")) {
    throw new Error("LLM did not return a full HTML document");
  }
  return code;
}

async function anthropicReadme(brief, repoName) {
  const prompt = `Create a professional README.md for this GitHub repository.

Repository Name: ${repoName}
Project Brief: ${brief}

Include sections:
# Project Title
(2–3 sentence overview)

## Features
## Setup Instructions
## Usage Guide
## Code Structure
## Technologies Used
## License
(MIT License)

Output ONLY the README content in Markdown.`;

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

  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}`);
  const data = await r.json();
  let md = data?.content?.[0]?.text || "";
  md = md.replace(/```markdown\n?/g, "").replace(/```\n?/g, "").trim();
  return md;
}

async function ghHeaders() {
  return {
    "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

async function createRepo(repoName) {
  const r = await fetch(`${GH_API}/user/repos`, {
    method: "POST",
    headers: await ghHeaders(),
    body: JSON.stringify({
      name: repoName,
      description: "Auto-generated application using LLM",
      private: false,
      auto_init: true,
      license_template: "mit",
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    // If repo already exists (round 2), surface that so caller can continue
    if (r.status === 422 && (e?.errors || []).some(er => er?.message?.includes("name already exists"))) {
      return { exists: true, html_url: `https://github.com/${process.env.GITHUB_USERNAME}/${repoName}` };
    }
    throw new Error(`Create repo failed: ${e.message || r.statusText}`);
  }
  return r.json();
}

async function getFileSha(owner, repo, path) {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    headers: await ghHeaders(),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Get file sha failed ${r.status}`);
  const data = await r.json();
  return data.sha || null;
}

async function putFile(owner, repo, path, contentBase64, message, existingSha = null) {
  const payload = { message, content: contentBase64 };
  if (existingSha) payload.sha = existingSha;

  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: await ghHeaders(),
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(`PUT ${path} failed: ${e.message || r.statusText}`);
  }
  return r.json();
}

async function enablePages(owner, repo) {
  // Configure Pages to serve from main@/
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/pages`, {
    method: "POST",
    headers: await ghHeaders(),
    body: JSON.stringify({
      build_type: "legacy",
      source: { branch: "main", path: "/" },
    }),
  });
  // 409 => already enabled (fine)
  if (!r.ok && r.status !== 409) {
    const e = await r.json().catch(() => ({}));
    throw new Error(`Enable pages failed: ${e.message || r.statusText}`);
  }
  return `https://${owner}.github.io/${repo}/`;
}

async function getLatestCommitSha(owner, repo, branch = "main") {
  const r = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    headers: await ghHeaders(),
  });
  if (!r.ok) throw new Error(`Get ref failed: ${r.status}`);
  const data = await r.json();
  return data?.object?.sha || "unknown";
}

async function notifyEvaluation(url, payload, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return true;
    await new Promise(resume => setTimeout(resume, Math.pow(2, attempt) * 1000));
  }
  return false;
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const body = await req.json().catch(() => ({}));
  const {
    email, secret, task, round, nonce,
    brief, checks = [], evaluation_url, attachments = [],
  } = body;

  // 0) Validate env
  const owner = process.env.GITHUB_USERNAME;
  if (!owner || !process.env.GITHUB_TOKEN || !process.env.ANTHROPIC_API_KEY) {
    return jsonResponse(500, { error: "Server missing GITHUB_USERNAME/TOKEN or ANTHROPIC_API_KEY" });
  }

  // 1) Verify secret
  if (!secret || secret !== process.env.STUDENT_SECRET) {
    return jsonResponse(403, { error: "Invalid secret" });
  }

  // 2) Validate request
  if (!email || !task || !round || !nonce || !brief || !evaluation_url) {
    return jsonResponse(400, { error: "Missing required fields" });
  }

  try {
    // 3) Generate app HTML & README
    const html = await anthropicGenerateHTML(brief, attachments, checks);
    const readme = await anthropicReadme(brief, task);

    // 4) Create (or reuse) repo
    const repo = await createRepo(task);
    const repoUrl = repo?.html_url || `https://github.com/${owner}/${task}`;

    // 5) Push index.html & README.md (Round-aware commit messages)
    const indexSha = await getFileSha(owner, task, "index.html");
    await putFile(
      owner, task, "index.html",
      toBase64(html),
      round === 1 ? "Add index.html" : `Update index.html - Round ${round}`,
      indexSha
    );

    const readmeSha = await getFileSha(owner, task, "README.md");
    await putFile(
      owner, task, "README.md",
      toBase64(readme),
      round === 1 ? "Add README.md" : `Update README.md - Round ${round}`,
      readmeSha
    );

    // 6) Enable Pages
    const pagesUrl = await enablePages(owner, task);

    // 7) Latest commit SHA
    const commitSha = await getLatestCommitSha(owner, task, "main");

    // 8) Notify evaluator
    const notifyPayload = {
      email, task, round, nonce,
      repo_url: repoUrl,
      commit_sha: commitSha,
      pages_url: pagesUrl,
    };
    const ok = await notifyEvaluation(evaluation_url, notifyPayload);
    if (!ok) throw new Error("Evaluation notification failed after retries");

    return jsonResponse(200, { status: "ok", repo_url: repoUrl, commit_sha: commitSha, pages_url: pagesUrl });
  } catch (e) {
    return jsonResponse(500, { error: e.message || String(e) });
  }
}
