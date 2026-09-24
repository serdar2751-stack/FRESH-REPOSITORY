// Minimal stdio MCP server used by the tests.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
process.stdout.write("this line is not json and must be ignored\n");

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test-server", version: "1.0" }, instructions: "Use echo to repeat text." } });
  } else if (msg.method === "tools/list") {
    if (!msg.params?.cursor) {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } }], nextCursor: "page2" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "fail", description: "Always fails", inputSchema: { type: "object" } }] } });
    }
  } else if (msg.method === "tools/call") {
    if (msg.params.name === "echo") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + msg.params.arguments.text }] } });
    else send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
  }
});
