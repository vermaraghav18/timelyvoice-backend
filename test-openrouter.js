// test-openrouter.js
import fetch from "node-fetch";

const apiKey = "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";

async function testOpenRouter() {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "anthropic/claude-3.7-sonnet",
      messages: [
        { role: "user", content: "Say hello from The Timely Voice backend" }
      ]
    })
  });

  const data = await response.json();
  console.log("✅ Response from OpenRouter:\n", data);
}

testOpenRouter().catch(console.error);
