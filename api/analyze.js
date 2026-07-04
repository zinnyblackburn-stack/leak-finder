// Vercel serverless function. Deploy this file at /api/analyze.js and Vercel
// will automatically expose it at POST /api/analyze — no extra config needed.
//
// IMPORTANT: after deploying, go to your Vercel project settings ->
// Environment Variables, and add:
//   ANTHROPIC_API_KEY = sk-ant-xxxxxxxx  (get one at console.anthropic.com)
// Then redeploy so the function can see it.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Server is missing ANTHROPIC_API_KEY. Add it in your hosting provider's environment variables and redeploy.",
    });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing 'text' in request body" });
  }

  const systemPrompt = `You are a financial analysis engine embedded in an app. You will receive raw pasted bank or credit card transaction data spanning multiple months, in any messy format (CSV-like, spaced columns, copy-pasted text).

Identify RECURRING or SUBSCRIPTION-like charges only — same or near-identical merchant name appearing at a roughly regular interval (weekly/monthly/annual), OR a well-known subscription merchant. Do not invent transactions that are not present in the data. Ordinary one-off purchases (groceries, gas, restaurants, single rides) are NOT leaks even if a merchant appears twice by coincidence — require genuine regular-interval repetition. A large fixed obligation like rent should be excluded from "leaks" since it isn't a discretionary or forgettable charge, but everyday discretionary subscriptions should be included even if the user obviously knows about some of them.

Limit to at most 8 items maximum, prioritizing highest-confidence items and largest annual cost first.

Respond with ONLY valid JSON, no markdown fences, no preamble, no trailing text, matching exactly this schema:
{
  "totalMonthly": number,
  "totalAnnual": number,
  "itemCount": number,
  "items": [
    {
      "merchant": string,
      "amount": number,
      "frequency": "weekly" | "monthly" | "annual",
      "confidence": "high" | "medium" | "low",
      "note": string (plain English, under 18 words, no jargon),
      "cancellationScript": string (short polite cancel/negotiate message, under 40 words)
    }
  ]
}
Sort items by confidence (high first), then by annual cost descending.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      return res.status(502).json({ error: "Claude API request failed" });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      return res.status(502).json({ error: "No text in Claude response" });
    }

    const cleaned = textBlock.text.trim().replace(/^```json|^```|```$/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Failed to analyze data" });
  }
}
