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

  const systemPrompt = `You are a financial analysis engine embedded in an app. You will receive raw pasted bank or credit card transaction data spanning multiple months, in any messy format (CSV-like, spaced columns, copy-pasted text), in any currency.

STEP 1 — Detect the currency used in the data from symbols (€, £, $, ¥, etc.) or currency codes (EUR, GBP, USD, etc.) present in the text. Return the correct symbol as "currencySymbol" (e.g. "$", "€", "£"). If genuinely ambiguous, default to "$".

STEP 2 — Identify recurring INCOME: incoming deposits (salary, payroll, freelance/client payments, benefits) that repeat at a roughly regular interval. Put these ONLY in the "incomeSources" array, and compute "monthlyIncome" as their combined average monthly total.

CRITICAL RULE: incoming money must NEVER appear in the "items" (leaks) array under any circumstances, even if it superficially looks recurring. Leaks are only outgoing charges.

STEP 3 — Compute "monthlySpending": the average total of ALL outgoing transactions per month across the whole period (everything that isn't income) — this gives an overall spending picture, independent of the leaks list.

STEP 4 — Identify RECURRING or SUBSCRIPTION-like DISCRETIONARY charges only — same or near-identical merchant name appearing at a roughly regular interval (weekly/monthly/annual), OR a well-known subscription merchant (streaming, software, gym, apps, etc.). 

EXCLUDE from "items" entirely:
- Rent, mortgage, or other large fixed housing obligations
- Essential utility/service bills: electricity, water, gas, internet, phone/mobile, insurance — these are known necessary bills, not forgettable waste, even though they recur
- One-off purchases that only coincidentally share a merchant (require genuine regular-interval repetition to qualify)

Discretionary subscriptions should still be included even if the user obviously knows about and actively wants some of them (e.g. a gym they use) — flagging is about visibility and letting the user decide, not accusing them of a mistake.

Limit "items" to at most 8 entries maximum, prioritizing highest-confidence items and largest annual cost first.

Respond with ONLY valid JSON, no markdown fences, no preamble, no trailing text, matching exactly this schema:
{
  "currencySymbol": string,
  "totalMonthly": number,
  "totalAnnual": number,
  "itemCount": number,
  "monthlyIncome": number,
  "monthlySpending": number,
  "incomeSources": [
    { "source": string, "amount": number, "frequency": "weekly" | "monthly" | "annual" }
  ],
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
If no recurring income is identifiable, return "monthlyIncome": 0 and an empty "incomeSources" array — do not guess or fabricate income.
Sort "items" by confidence (high first), then by annual cost descending.`;

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
        max_tokens: 8192,
        thinking: { type: "disabled" },
        system: systemPrompt,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      return res.status(502).json({ error: `Claude API request failed: ${errText.slice(0, 300)}` });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      console.error("Full response with no text block:", JSON.stringify(data));
      return res.status(502).json({
        error: `No text in Claude response. stop_reason: ${data.stop_reason}. content types: ${(data.content || []).map(b => b.type).join(",") || "empty"}. usage: ${JSON.stringify(data.usage)}`,
      });
    }

    const cleaned = textBlock.text.trim().replace(/^```json|^```|```$/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("JSON parse failed. Raw text was:", cleaned);
      return res.status(500).json({
        error: `Response wasn't valid JSON (likely cut off). Stop reason: ${data.stop_reason}. First 200 chars: ${cleaned.slice(0, 200)}`,
      });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: `Failed to analyze data: ${err.message}` });
  }
}
