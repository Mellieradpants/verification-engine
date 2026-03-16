export async function POST(request) {
  try {
    const body = await request.json();
    const text = body?.text?.trim();
    const language = body?.language?.trim() || "en";

    if (!text) {
      return new Response(
        JSON.stringify({ error: "No text provided" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (language === "en") {
      return new Response(
        JSON.stringify({ translated: text }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing OPENAI_API_KEY" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
          "Translate the entire text into the requested target language in clear, natural language. Translate everything, including sentences, labels, and names if needed so the result is fully understandable to a reader in that language. Do not explain. Return only the translated text."
          {
            role: "user",
            content: `Target language: ${language}\n\nText:\n${text}`
          }
        ]
      })
    });

    const data = await openaiResponse.json();

    if (!openaiResponse.ok) {
      return new Response(
        JSON.stringify({
          error: "OpenAI request failed",
          details: data
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const translated = data?.choices?.[0]?.message?.content?.trim() || text;

    return new Response(
      JSON.stringify({ translated }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Translation failed",
        details: String(error)
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}
