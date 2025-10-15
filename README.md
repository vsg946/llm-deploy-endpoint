# LLM Deploy Endpoint

Serverless API (Vercel Edge) that:
1. Verifies a request (email, secret, task, round, nonce)
2. Generates `index.html` (Claude) and a README
3. Creates/updates a public GitHub repo named by `task`
4. Pushes files and enables GitHub Pages
5. Posts repo metadata to `evaluation_url`

## Endpoint
`POST /api/request` (Content-Type: application/json)

### Request Body (example)
```json
{
  "email": "student@example.com",
  "secret": "the-secret-you-submitted",
  "task": "portfolio-site-abc12",
  "round": 1,
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "brief": "Create a responsive personal portfolio website...",
  "checks": [
    "Repo has MIT license",
    "README.md is professional",
    "Page loads at GitHub Pages"
  ],
  "evaluation_url": "https://your-eval-url",
  "attachments": []
}
