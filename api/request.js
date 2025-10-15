// api/request.js
// Debug-first handler: tolerant body parsing + detailed logs/echo.
// Accepts: application/json, text/plain containing JSON, or x-www-form-urlencoded.

export const config = { runtime: "edge" };

const J = (status, body) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function readBodyFlexible(req) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  let raw = "";
  let parsed = {};

  try {
    if (ct.includes("application/json")) {
      parsed = await req.json();               // proper JSON
      raw = JSON.stringify(parsed);
      return { ok: true, ct, raw, parsed };
    }

    // otherwise read raw text once
    raw = await req.text();

    if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(raw);
      parsed = Object.fromEntries(params.entries());
      return { ok: true, ct, raw, parsed };
    }

    // try to parse raw text as JSON anyway
    try {
      parsed = JSON.parse(raw);
      return { ok: true, ct, raw, parsed };
    } catch {
      return { ok: false, ct, raw, parsed: {} };
    }
  } catch (err) {
    return { ok: false, ct, raw, parsed: {}, err: err?.message };
  }
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return J(405, { error: "Method Not Allowed" });
  }

  const { ok, ct, raw, parsed, err } = await readBodyFlexible(req);

  // Log what actually arrived
  console.log("REQ Content-Type:", ct || "<none>");
  console.log("REQ raw length:", (raw || "").length);
  if (!ok) {
    console.log("Body parse failed. Raw snippet:", (raw || "").slice(0, 200));
    return J(400, {
      error: "Invalid JSON body",
      hint: "Send raw JSON with Content-Type: application/json",
      received: { content_type: ct, raw_snippet: (raw || "").slice(0, 500) },
      parse_error: err || "could not parse body",
    });
  }

  // Echo back safely so you can verify
  const { email, secret, task, round, nonce, brief, evaluation_url } = parsed || {};
  console.log("Parsed keys ->", Object.keys(parsed || {}));

  // Also show lengths instead of secret values in logs
  console.log("Field presence ->", {
    email: !!email, secret_len: (secret || "").length, task, round,
    nonce_len: (nonce || "").length, has_brief: !!brief, eval_url: !!evaluation_url,
  });

  // TEMP: compare with env secret (don’t keep in production)
  const envSecret = process.env.STUDENT_SECRET || "";
  const match = (secret || "") === envSecret;

  return J(200, {
    status: "received",
    parsed,
    diagnostics: {
      content_type: ct,
      raw_length: (raw || "").length,
      env: {
        has_GITHUB_USERNAME: !!process.env.GITHUB_USERNAME,
        has_GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
        has_STUDENT_SECRET: !!process.env.STUDENT_SECRET,
        has_ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      },
      secret_matches_env: match,      // true/false for quick check
      provided_secret_length: (secret || "").length,
      env_secret_length: envSecret.length,
    },
  });
}
