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

STEP 1 — Detect the currency used in the data. Look carefully for currency symbols (€, £, $, ¥, etc.) ANYWHERE in the text, or 3-letter currency codes (EUR, GBP, USD, CHF, etc.), or country-specific formatting hints (comma vs period as decimal separator). Return the correct symbol as "currencySymbol" (e.g. "$", "€", "£"). Only default to "$" if there is truly zero indication of any other currency anywhere in the text — do not default to "$" just because the amounts look like plain numbers.

STEP 2 — Identify recurring INCOME: incoming deposits (salary, payroll, freelance/client payments, benefits) that repeat at a roughly regular interval. Put these ONLY in the "incomeSources" array, and compute "monthlyIncome" as their combined average monthly total.

CRITICAL RULE: incoming money must NEVER appear in the "items" (leaks) array under any circumstances, even if it superficially looks recurring. Leaks are only outgoing charges.

STEP 3 — Compute "monthlySpending": the average total of ALL outgoing transactions per month across the whole period (everything that isn't income) — this gives an overall spending picture, independent of the leaks list. Compute this carefully by actually dividing total outgoing spend by the number of distinct months present in the data.

STEP 3b — Split that same spending into two categories and report their average monthly totals:
- "monthlyEssential": necessities — groceries, utilities, transport/fuel, insurance, rent/mortgage, essential bills
- "monthlyDiscretionary": everything else optional — dining out, entertainment, shopping, subscriptions, hobbies
These two numbers should roughly add up to "monthlySpending".

STEP 3c — Identify the single spending category with the highest total spend across the whole period (e.g. "Groceries", "Dining Out", "Shopping", "Transport"). Report "largestCategoryName" and "largestCategoryTotal" (the total amount spent in that category across the entire period provided, not monthly average).

STEP 4 — Identify RECURRING or SUBSCRIPTION-like DISCRETIONARY charges only — same or near-identical merchant name appearing at a roughly regular interval (weekly/monthly/annual), OR a well-known subscription merchant (streaming, software, gym, apps, etc.).

EXCLUDE from "items" entirely:
- Rent, mortgage, or other large fixed housing obligations
- Essential utility/service bills: electricity, water, gas, internet, phone/mobile, insurance — these are known necessary bills, not forgettable waste, even though they recur
- One-off purchases that only coincidentally share a merchant (require genuine regular-interval repetition to qualify)

Discretionary subscriptions should still be included even if the user obviously knows about and actively wants some of them (e.g. a gym they use) — flagging is about visibility and letting the user decide, not accusing them of a mistake.

IMPORTANT — variable-amount charges: some recurring charges (e.g. ad platforms, usage-based tools) charge a DIFFERENT amount each cycle. For every item, report BOTH:
- "avgAmount": the average charge amount across all occurrences found in the data
- "lastAmount": the amount of the single most recent (latest-dated) occurrence
If every occurrence was the same amount, avgAmount and lastAmount will simply be equal — that's fine.

Limit "items" to at most 8 entries maximum, prioritizing highest-confidence items and largest annual cost first.

Respond with ONLY valid JSON, no markdown fences, no preamble, no trailing text, matching exactly this schema:
{
  "currencySymbol": string,
  "monthlyIncome": number,
  "monthlySpending": number,
  "monthlyEssential": number,
  "monthlyDiscretionary": number,
  "largestCategoryName": string,
  "largestCategoryTotal": number,
  "incomeSources": [
    { "source": string, "amount": number, "frequency": "weekly" | "monthly" | "annual" }
  ],
  "items": [
    {
      "merchant": string,
      "avgAmount": number,
      "lastAmount": number,
      "frequency": "weekly" | "monthly" | "annual",
      "confidence": "high" | "medium" | "low",
      "note": string (plain English, under 18 words, no jargon),
      "cancellationScript": string (short polite cancel/negotiate message, under 40 words)
    }
  ]
}
If no recurring income is identifiable, return "monthlyIncome": 0 and an empty "incomeSources" array — do not guess or fabricate income.
Do NOT include totals, sums, or item counts in your response — only the raw items and income sources listed above. Sort "items" by confidence (high first), then by average annual cost descending.`;

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

    // Compute totals deterministically from the item list itself, rather than
    // trusting the model's own arithmetic — guarantees the totals always match
    // exactly what's shown, and removes a source of run-to-run inconsistency.
    const toMonthly = (amount, frequency) => {
      if (frequency === "weekly") return amount * 4.345;
      if (frequency === "annual") return amount / 12;
      return amount; // monthly, or fallback
    };

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const totalMonthly = items.reduce((sum, item) => sum + toMonthly(item.avgAmount || 0, item.frequency), 0);

    const result = {
      ...parsed,
      items,
      totalMonthly: Math.round(totalMonthly * 100) / 100,
      totalAnnual: Math.round(totalMonthly * 12 * 100) / 100,
      itemCount: items.length,
    };

    return res.status(200).json(result);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: `Failed to analyze data: ${err.message}` });
  }
}
