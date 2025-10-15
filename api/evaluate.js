// api/evaluate.js
// Optional helper to test your notify step (use its URL as evaluation_url)

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Only POST allowed", { status: 405 });
  }
  const body = await req.json().catch(() => ({}));
  console.log("Evaluation payload received:", body);
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
