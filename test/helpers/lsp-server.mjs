// A tiny language server for tests: every line containing "ERROR" is an
// error, "WARN" a warning. Before answering initialize it asks the client
// for its configuration, so a client that ignores server requests hangs.
// FAKE_LSP_DELAY_MS delays each publish; FAKE_LSP_STAGED publishes an empty
// result first (like servers that report syntax, then semantic errors).

const delay = Number(process.env.FAKE_LSP_DELAY_MS ?? 0);
const staged = Boolean(process.env.FAKE_LSP_STAGED);
let buffer = Buffer.alloc(0);
let nextId = 1000;
const waiting = new Map();

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function diagnose(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const [word, severity] of [["ERROR", 1], ["WARN", 2]]) {
      const col = line.indexOf(word);
      if (col >= 0) {
        out.push({
          range: { start: { line: i, character: col }, end: { line: i, character: col + word.length } },
          severity,
          source: "fake",
          code: word.toLowerCase(),
          message: `found ${word}: ${line.trim()}`,
        });
      }
    }
  });
  return out;
}

function publish(uri, version, text) {
  const go = () => {
    if (staged) send({ method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: [] } });
    setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: diagnose(text) } }), staged ? 50 : 0);
  };
  if (delay) setTimeout(go, delay);
  else go();
}

async function handle(msg) {
  if (msg.id !== undefined && !msg.method) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case "initialize": {
      const config = await request("workspace/configuration", { items: [{ section: "fake" }] });
      await request("window/workDoneProgress/create", { token: "t" });
      send({ id: msg.id, result: { capabilities: { textDocumentSync: { openClose: true, change: 1 } }, serverInfo: { name: "fake", version: JSON.stringify(config) } } });
      break;
    }
    case "textDocument/didOpen":
      publish(msg.params.textDocument.uri, msg.params.textDocument.version, msg.params.textDocument.text);
      break;
    case "textDocument/didChange":
      publish(msg.params.textDocument.uri, msg.params.textDocument.version, msg.params.contentChanges.at(-1).text);
      break;
    case "shutdown":
      send({ id: msg.id, result: null });
      break;
    case "exit":
      process.exit(0);
      break;
    default:
      if (msg.id !== undefined) send({ id: msg.id, result: null });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1] ?? 0);
    if (buffer.length < end + 4 + len) return;
    const body = buffer.subarray(end + 4, end + 4 + len).toString("utf8");
    buffer = buffer.subarray(end + 4 + len);
    void handle(JSON.parse(body));
  }
});
