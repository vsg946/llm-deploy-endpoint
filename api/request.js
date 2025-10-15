// api/request.js
// Debug version: just logs and validates request body + secret

export const config = { runtime: "edge" };

const J = (status, body) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async function handler(req) {
  if (req.method !== "POST") {
    return J(405, { error: "Method Not Allowed" });
  }

  let body = {};
  try {
    body = await req.json();
  } catch (err) {
    console.log("❌ Failed to parse JSON body:", err.message);
    return J(400, { error: "Invalid JSON body" });
  }

  // 🔎 Print the entire raw body we received
  console.log("📩 RAW REQUEST BODY:", JSON.stringify(body, null, 2));

  const { email, secret, task, round, nonce, brief, evaluation_url } = body || {};

  // 🔎 Debug: log provided values
  console.log("🔑 Provided secret:", secret);
  console.log("🔑 Env STUDENT_SECRET:", process.env.STUDENT_SECRET);

  // Quick validation of secret
  if (!secret || secret !== process.env.STUDENT_SECRET) {
    return J(403, {
      error: "Invalid secret",
      provided: secret,
      expected: process.env.STUDENT_SECRET, // careful, logs in response just for debug
    });
  }

  // ✅ Echo back what we got
  return J(200, {
    status: "ok",
    message: "Request received successfully",
    received: body,
    envs: {
      has_GITHUB_USERNAME: !!process.env.GITHUB_USERNAME,
      has_GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      has_STUDENT_SECRET: !!process.env.STUDENT_SECRET,
      has_ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    },
  });
}
