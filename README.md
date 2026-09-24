# ✻ usta

**usta**, terminalde çalışan, kendi API anahtarınızla kullandığınız bir yapay zekâ kodlama ajanıdır (agent harness). opencode ve Claude Code tarzında çalışır: kodunuzu okur, dosyaları düzenler, komut çalıştırır, testleri koşar — ama her adımı izin sistemine, geri alınabilir anlık görüntülere ve betiklenebilir bir API'ye bağlar.

```
✻ usta 0.1.0  anthropic/claude-opus-5 · build
  ~/kod/projem
› testlerdeki hatayı düzelt
● Önce test çıktısına bakıyorum.
● bash npm test
  └ FAIL src/date.test.ts › formats UTC dates
● edit src/date.ts
  └ Updated · +1 -1
      12 - return d.getDay()
      12 + return d.getUTCDay()
● Hata saat dilimindeydi; getDay yerine getUTCDay kullandım ve testler geçiyor.
✓ · 1 file changed +1 -1 · 18s · 42k in · 1.2k out · $0.09
```

## Öne çıkanlar

- **Çok sağlayıcılı, API tabanlı:** Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Cerebras, Ollama, LM Studio ve OpenAI uyumlu her uç nokta. Oturum ortasında `/model` ile model değiştirilebilir.
- **Güvenli varsayılanlar:** okuma serbest; düzenlemeler ve komutlar onay ister. Bash komutları ayrıştırılır (`&&`, `|`, `;`, `$(...)`, heredoc, yönlendirmeler) ve her alt komut ayrı değerlendirilir; `ls`, `git status`, `rg` gibi salt-okunur komutlar otomatik izinlidir, `echo x > dosya` değildir. `.env` okumak onay ister.
- **Tam geri alma:** git depolarında proje `.git`'inize dokunmayan gizli bir "gölge" git deposu her turda anlık görüntü alır. `/undo` yalnızca ajan araçlarının değil, **bash komutlarının yaptığı değişiklikleri de** geri alır; `/redo` ile ileri alınır. Git olmayan dizinlerde araç düzenlemeleri geri alınır.
- **Modlar:** ⇧⇥ ile `normal` → `accept edits` (düzenlemeleri otomatik onayla) → `plan` (salt okunur araştırma; plan hazır olunca onaylı geçiş).
- **Hook'lar:** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`. Örn. her düzenlemeden sonra formatlayıcı çalıştır, ajan bitirmeden önce testleri koş ve kırmızıysa geri gönder.
- **Alt ajanlar (sub-agent):** `explore` (salt okunur, hızlı keşif) ve `general`; Markdown dosyalarıyla kendi ajanlarınızı tanımlayın. Paralel çalışabilirler.
- **MCP:** stdio ve Streamable HTTP MCP sunucuları.
- **LSP geri bildirimi:** düzenlemeden sonra dil sunucusunun (pyright, gopls, clangd; isteğe bağlı TypeScript, rust-analyzer) bulduğu **yeni** hatalar modele otomatik iletilir; dosyada zaten var olan hatalar gürültü yapmaz.
- **Claude Code uyumluluğu:** `CLAUDE.md`, `.claude/agents`, `.claude/commands`, `.claude/skills` dosyalarını da okur; mevcut yapılandırmanız doğrudan çalışır.
- **Üç kullanım biçimi:** etkileşimli terminal arayüzü, betik/CI için `usta run` (metin veya JSONL olay akışı) ve `usta serve` ile HTTP + SSE API ile yerleşik web arayüzü.
- **Uzun oturumlar:** bağlam dolarken konuşma otomatik özetlenir (`/compact`), JSONL oturum kayıtları çökmelere dayanıklıdır, maliyet ve token kullanımı canlı gösterilir.
- **Claude için ayarlanmış istemci:** adaptive thinking (özetli düşünme gösterimi), model başına uygun `effort`, prompt caching (sistem istemi + otomatik kuyruk önbelleği), düşünme bloklarının kayıpsız geri gönderimi (append-only geçmiş), sunucu tarafı refusal fallback, hata/yeniden deneme yönetimi.

## Kurulum

Node.js 20.3+ gerekir (Bun ile de çalışır). Önerilen: `ripgrep` (`rg`) ve `git` yüklü olsun — yoksa yerleşik yedekler kullanılır.

```bash
git clone https://github.com/serdar2751-stack/FRESH-REPOSITORY.git usta
cd usta
npm install          # bağımlılıkları kurar ve dist/ klasörünü derler
npm link             # "usta" komutunu PATH'e ekler
```

Geliştirme sırasında derlemeden de çalıştırabilirsiniz: `node src/cli.ts` (Node 22.18+ TypeScript'i doğrudan çalıştırır) veya `bun src/cli.ts`.

**Tek dosyalık çalıştırılabilir:** [Bun](https://bun.sh) yüklüyse `npm run build:bin` Node gerektirmeyen tek bir `dist/bin/usta` dosyası üretir (başka platform için: `bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile usta`; hedefler `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-windows-x64`).

## Hızlı başlangıç

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # veya OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY ...
cd projem
usta                                    # etkileşimli oturum
usta "bu projede testler nasıl çalışıyor?"   # ilk mesajla başla
usta -c                                 # son oturuma devam et
usta run "README'deki kurulum adımlarını doğrula" --allow edit
```

Hiç anahtar yoksa `usta` ilk açılışta bir kurulum ekranı gösterir: sağlayıcıyı seçin, anahtarı yapıştırın (ekranda maskelenir). Anahtar kısa bir doğrulama çağrısıyla sınanır, reddedilirse kaydedilmez; kabul edilirse yalnızca size okunabilir bir dosyaya (`0600`) yazılır ve sağlayıcının önerilen modeli seçilir. Aynı akış sonradan `/login [sağlayıcı]` ile, terminal dışında `usta auth login anthropic` ile açılır.

Model seçim sırası: `-m` bayrağı → `USTA_MODEL` → config'deki `model` → arayüzde en son seçtiğiniz model (anahtarı hâlâ varsa) → ilk bulunan anahtara göre varsayılan: Anthropic → `claude-opus-5`, OpenAI → `gpt-5`, Gemini → `gemini-2.5-pro`.

## Sağlayıcılar ve modeller

Model referansı `sağlayıcı/model` biçimindedir: `anthropic/claude-sonnet-5`, `openai/gpt-5`, `openrouter/anthropic/claude-opus-5`, `ollama/qwen3-coder:30b`. Bilinen modellerde sağlayıcı ön eki atlanabilir (`-m claude-opus-5`).

| Sağlayıcı | Ortam değişkeni | Not |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` (veya `ANTHROPIC_AUTH_TOKEN`) | Yerel Messages API adaptörü |
| `openai` | `OPENAI_API_KEY` | Responses API (durumsuz, şifreli akıl yürütme araç çağrıları arasında korunur); GPT-5 ailesinde `apply_patch` düzenleme aracı |
| `gemini` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | OpenAI uyumlu uç nokta |
| `openrouter` | `OPENROUTER_API_KEY` | Bağlam uzunluğu ve fiyatlar canlı olarak okunur |
| `deepseek`, `groq`, `mistral`, `xai`, `together`, `fireworks`, `cerebras` | `<AD>_API_KEY` | OpenAI uyumlu |
| `ollama`, `lmstudio` | — | Yerel sunucular; config'de anılınca listelenir |

`usta models` bilinen modelleri, `usta models openrouter --remote` sağlayıcının canlı listesini gösterir. Katalogda olmayan yeni Claude modellerinin bağlam penceresi ve yetenekleri (thinking, effort) Anthropic Models API'den, OpenRouter modellerininki `/models` uç noktasından otomatik okunur.

Özel bir OpenAI uyumlu uç nokta (vLLM, llama.cpp, LiteLLM, şirket içi ağ geçidi):

```jsonc
{
  "model": "yerel/qwen3-coder",
  "providers": {
    "yerel": {
      "format": "openai",
      "baseURL": "http://localhost:8000/v1",
      "apiKey": "env:YEREL_ANAHTAR",
      "models": { "qwen3-coder": { "contextWindow": 131072, "maxOutput": 16384 } }
    }
  }
}
```

OpenAI sağlayıcısı varsayılan olarak **Responses API**'yi kullanır: istekler `store: false` ile gönderilir (OpenAI tarafında konuşma saklanmaz), modelin akıl yürütmesi şifreli olarak (`reasoning.encrypted_content`) bir sonraki isteğe geri verilir; böylece araç çağrıları arasında düşünce zinciri kopmaz ve akıl yürütme özetleri canlı gösterilir. Şifreli içerik yalnızca onu üreten modele geri gönderilir; sunucu reddederse istek onsuz bir kez tekrarlanır. Chat Completions'a dönmek ya da Responses API'yi destekleyen başka bir uç noktada (ör. Azure OpenAI, ağ geçitleri) açmak için:

```jsonc
{ "providers": { "openai": { "options": { "api": "chat" } }, "azure": { "format": "openai", "baseURL": "https://…/openai/v1", "options": { "api": "responses" } } } }
```

> Ollama kullanıyorsanız bağlam penceresini büyütün (ör. `OLLAMA_CONTEXT_LENGTH=65536`); varsayılan değer ajan kullanımı için çok küçüktür.

## Etkileşimli kullanım

| Tuş | İşlev |
|---|---|
| `Enter` | Gönder (ajan çalışırken mesajı kuyruğa alır) |
| `Ctrl+J`, `Alt+Enter`, satır sonunda `\` | Yeni satır |
| `⇧⇥` (Shift+Tab) | Mod: normal → accept edits → plan |
| `Esc` | Ajanı durdur · menüyü kapat |
| `Ctrl+C` | Girdiyi temizle · iki kez: çıkış |
| `Ctrl+O` | Ayrıntılı görünüm (tam düşünme metni, tam araç çıktısı) |
| `↑` `↓` | Geçmiş |
| `@yol` | Dosya/görsel/dizin ekle (`@src/app.ts:10-40` satır aralığı) |
| `!komut` | Kabuk komutu çalıştır, çıktısını modele bağlam olarak ver |

Komutlar: `/help`, `/new`, `/sessions`, `/model`, `/agent`, `/mode`, `/plan`, `/effort`, `/compact`, `/undo`, `/redo`, `/diff [all]`, `/cost`, `/status`, `/init` (AGENTS.md oluşturur), `/export`, `/copy`, `/todos`, `/mcp`, `/permissions`, `/title`, `/login [sağlayıcı]`, `/verbose`, `/exit`. `/` yazınca tamamlama menüsü açılır. `/model` listesinde olmayan bir modeli "Other model…" ile `sağlayıcı/model` yazarak seçebilirsiniz.

İzin istemi şu seçenekleri sunar: bir kez izin ver · bu oturum için izin ver (ör. `git push *`) · bu projede hep izin ver · reddet ve ajana ne yapması gerektiğini söyle. Geri bildirimsiz ret turu durdurur; geri bildirimli ret ajana iletilir ve devam eder.

## Betik ve CI: `usta run`

```bash
usta run "CHANGELOG'u son commit'lere göre güncelle" --allow edit --allow "bash:git log*"
git diff | usta run -q "bu değişiklikte hata var mı?"
usta run --json "testleri çalıştır ve özetle" > olaylar.jsonl
usta run -c "devam et"                # son oturumu sürdür
```

- `--format text|json|quiet` (kısaca `--json`, `-q`): `text` asistan metnini stdout'a, araç özetlerini stderr'e yazar; `json` her olayı bir JSON satırı olarak verir; `quiet` yalnızca son yanıtı yazar.
- Etkileşimsiz modda onay gerektiren eylemler **reddedilir**; izin vermek için `--allow edit`, `--allow "bash:npm test*"`, `--allow webfetch` veya config kuralları kullanın. `--yolo` açıkça reddedilmeyen her şeye izin verir (yalnızca yalıtılmış ortamlarda kullanın).
- Çıkış kodları: `0` tamam, `1` hata/ret, `3` adım sınırı, `130` kesildi.

## HTTP API ve web arayüzü: `usta serve`

```bash
usta serve --port 4096
# web UI : http://127.0.0.1:4096/?token=...
```

Tarayıcıda oturum listesi, canlı akış, araç kartları, diff görünümü ve izin/soru/plan onay pencereleri olan bir arayüz açılır. Aynı API'yi kendi araçlarınızdan kullanabilirsiniz:

| Yöntem | Yol | Açıklama |
|---|---|---|
| `GET` | `/api/sessions` | Oturumları listele |
| `POST` | `/api/sessions` | Oturum oluştur (`{model?, agent?, mode?}`) |
| `GET` / `PATCH` / `DELETE` | `/api/sessions/:id` | Mesajlar · model/mod/effort/başlık değiştir · sil |
| `POST` | `/api/sessions/:id/prompt` | `{text, images?, wait?}` — tur başlat (`wait: true` ise sonucu bekler) |
| `POST` | `/api/sessions/:id/abort` · `/undo` · `/redo` · `/compact` | Tur kontrolü |
| `GET` | `/api/events?session=:id` | Server-Sent Events olay akışı |
| `POST` | `/api/permissions/:id` | `{decision: once\|session\|always\|deny, feedback?}` |
| `POST` | `/api/questions/:id` · `/api/plans/:id` | Soru yanıtı · plan onayı |
| `GET` | `/api/info` · `/api/models` · `/api/health` | Bilgi |

Güvenlik: varsayılan olarak yalnızca `127.0.0.1`'e bağlanır, `/api/health` dışındaki tüm API istekleri başlangıçta üretilen rastgele bir token (`Authorization: Bearer ...` veya EventSource için `?token=`) ister ve DNS-rebinding'e karşı `Host`/`Origin` başlıkları doğrulanır. Sabit bir token için `--token`, yalnızca güvenilir ortamlarda `--no-auth`. Loopback dışı bir adrese token olmadan bağlanmayı reddeder.

## Yapılandırma

Ayarlar şu sırayla birleştirilir (sonraki kazanır): `~/.config/usta/config.json` → projede kökten çalışma dizinine kadar `usta.json` / `.usta/config.json` → `USTA_MODEL` → komut satırı. JSONC (yorumlu JSON) desteklenir. Tam örnek: [`examples/config.jsonc`](examples/config.jsonc). `usta config` birleşmiş sonucu ve kaynaklarını gösterir.

Önemli anahtarlar: `model`, `smallModel` (yalnızca oturum başlığı için ucuz model), `effort`, `providers`, `permission`, `agents`, `defaultAgent`, `mcp`, `hooks`, `instructions`, `compaction` (`auto`, `threshold`, `maxContextTokens`), `snapshots`, `tools` (araç aç/kapa), `maxSteps`, `maxOutputTokens`, `notify`.

**Güven modeli:** Bir depo, kendi `.usta/config.json` dosyasıyla hook, MCP sunucusu, dil sunucusu, izin kuralı veya sağlayıcı (`baseURL`, API anahtarı yönlendirmesi) tanımlayabilir — bunlar kod çalıştırabileceği veya anahtarınızı başka yere gönderebileceği için, proje **güvenilir** işaretlenene kadar uygulanmaz. usta ilk açılışta sorar; `usta trust` / `usta untrust` ile de yönetilir.

## İzinler

Kurallar araç (veya araç grubu) ve desen bazındadır; eşleşen **son** kural kazanır. `*` her şeyle eşleşir; `"git push *"` hem `git push` hem `git push origin main` ile eşleşir.

```jsonc
"permission": {
  "edit": "ask",                                  // write, edit, apply_patch
  "bash": { "npm test*": "allow", "rm -rf *": "deny" },
  "read": { "secrets/*": "deny" },
  "webfetch": { "https://docs.rs/*": "allow" },
  "external_directory": "ask",                    // proje dışındaki yollar
  "mcp__github__*": "allow"
}
```

İzin grupları: `read`, `edit`, `bash`, `webfetch`, `external_directory`, `task`, `skill` ve MCP araç adları. Bash'te `"@readonly": "allow"` yerleşik salt-okunur komut listesini temsil eder. İstemde "bu projede hep izin ver" seçilen kurallar deponuza değil kullanıcı veri dizinine kaydedilir (`/permissions` ile görün).

## Ajanlar, komutlar, skill'ler ve talimatlar

- **Talimat dosyaları:** `~/.config/usta/AGENTS.md`, `~/.claude/CLAUDE.md`, proje kökünden çalışma dizinine kadar `AGENTS.md` / `CLAUDE.md` / `.usta/AGENTS.md` ve `instructions` ile belirtilenler sistem istemine eklenir. `/init` sizin için bir AGENTS.md hazırlar.
- **Ajanlar:** `build` (varsayılan), `explore` ve `general` alt ajanları yerleşiktir. `.usta/agents/*.md` (veya `.claude/agents/*.md`) ile yenilerini ekleyin — örnek: [`examples/agents/reviewer.md`](examples/agents/reviewer.md). Ön bilgide `description`, `mode` (`primary` | `subagent` | `all`), `model`, `effort`, `tools`, `permission`, `maxSteps`; gövde sistem istemine eklenir.
- **Özel komutlar:** `.usta/commands/ad.md` → `/ad`. `$ARGUMENTS`, `$1`…`$9` ve `` !`komut` `` (komut çıktısını ekler; proje komutlarında güven gerekir) desteklenir. Alt klasörler `/klasör:ad` olur. Örnek: [`examples/commands/test.md`](examples/commands/test.md).
- **Skill'ler:** `.usta/skills/<ad>/SKILL.md` (ve `.claude/skills`). Açıklamaları sistem isteminde listelenir, model gerektiğinde `skill` aracıyla yükler.

## Hook'lar

Hook'lar olay verisini stdin'den JSON olarak alan kabuk komutlarıdır. `USTA_EVENT`, `USTA_TOOL`, `USTA_FILE`, `USTA_SESSION_ID`, `USTA_PROJECT_DIR` ortam değişkenleri tanımlıdır.

| Olay | Çıkış kodu 2'nin etkisi |
|---|---|
| `PreToolUse` | Araç çalışmaz; hata mesajı modele iletilir |
| `PostToolUse` | Hook çıktısı araç sonucuna eklenir (ör. lint hataları) |
| `UserPromptSubmit` | İstem engellenir (kod 0'da stdout bağlam olarak eklenir) |
| `Stop` | Ajan durmaz; çıktı yeni geri bildirim olarak verilir (en fazla 5 kez) |
| `SessionStart` | stdout ilk mesaja bağlam olarak eklenir |

`matcher` araç adına karşı düzenli ifadedir (`"edit|write"`).

## MCP

```jsonc
"mcp": {
  "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "env:GITHUB_TOKEN" } },
  "uzak": { "type": "http", "url": "https://ornek.com/mcp", "headers": { "Authorization": "env:MCP_TOKEN" } }
}
```

Araçlar `mcp__sunucu__araç` adıyla sunulur ve varsayılan olarak onay ister. `usta mcp` bağlantı durumunu ve araç listesini gösterir.

## Dil sunucuları (LSP) ile hata geri bildirimi

Ajan bir dosyayı düzenlediğinde (`edit`, `write`, `apply_patch`), usta dosyayı ilgili dil sunucusuna gönderir ve **düzenlemenin yol açtığı hataları** araç sonucuna ekler; model bir sonraki adımda bunları görüp düzeltir:

```
<diagnostics file="app.py">
ERROR [5:14] Argument of type "Literal['two']" cannot be assigned to parameter "b" of type "int" … (Pyright reportArgumentType)
</diagnostics>
(1 other error in this file predate your changes.)
```

Dosya okunduğu anda sunucuda açılır ve mevcut hataları kaydedilir; sonraki raporlarda yalnızca yeni hatalar gösterilir (önceden var olan "import çözülemedi" gibi gürültüler modeli oyalamaz). Hatalar satır numarasından bağımsız (kod + mesaj) karşılaştırılır, uyarılar gösterilmez. Arayüzde düzenleme satırında `⚠ 2 new errors` görünür, `/status` sunucuların durumunu listeler.

| Sunucu | Uzantılar | Varsayılan |
|---|---|---|
| `python` — `pyright-langserver` / `basedpyright-langserver` | `.py`, `.pyi` | PATH'te varsa açık |
| `go` — `gopls` | `.go` | PATH'te varsa açık |
| `clangd` | `.c`, `.h`, `.cpp`, … | PATH'te varsa açık |
| `typescript` — `typescript-language-server` | `.ts`, `.tsx`, `.js`, … | **İsteğe bağlı** |
| `rust` — `rust-analyzer` | `.rs` | **İsteğe bağlı** |

TypeScript ve Rust sunucuları proje kodu çalıştırabildiği için (tsserver eklentileri `node_modules`'tan yüklenir; rust-analyzer build script ve proc-macro çalıştırır) kendiniz açmalısınız:

```jsonc
"lsp": {
  "typescript": true,
  "rust": true,
  "go": false,                                   // kapat
  "ruby": { "command": ["ruby-lsp"], "extensions": [".rb"] }   // özel sunucu
}
```

`"lsp": true` tüm yerleşik sunucuları, `"lsp": false` hepsini kapatır. Proje config'indeki `lsp` ayarı komut çalıştırdığı için yalnızca güvenilir projelerde uygulanır.

## Oturumlar, geri alma ve sıkıştırma

- Oturumlar `~/.local/share/usta/projects/<proje>/sessions/` altında, yalnızca eklemeli JSONL dosyaları olarak saklanır. `usta sessions`, `usta sessions export <id> [dosya]`, `usta -s <id>`.
- `/undo` son turu geri alır (dosyalar + konuşma) ve isteminizi düzenlemeniz için girdi kutusuna geri koyar. `/diff` son turun, `/diff all` oturumun değişikliklerini gösterir.
- Bağlam penceresi dolmaya yaklaşınca konuşma, işin durumunu koruyan ayrıntılı bir özetle değiştirilir. `/compact [talimat]` ile elle tetiklenebilir; `compaction.maxContextTokens` maliyeti sınırlamak için kullanılabilir.

## Claude'a özel davranışlar

- Adaptive thinking modellerde düşünme özetleri (`display: "summarized"`) gösterilir; eski modellerde `"thinking": true` ile bütçeli düşünme açılır.
- `effort` model başına önerilen varsayılanla gönderilir (ör. Opus 5 için `high`, Opus 5.5 için `medium`); `/effort` ile değiştirin.
- Sistem istemi ve araç listesi oturum boyunca sabit tutulur, geçmiş yalnızca eklemelidir (mod değişiklikleri ve hatırlatmalar yeni mesaj olarak eklenir). Bu hem prompt cache isabetini yüksek tutar hem de düşünme bloklarının geçerliliğini korur.
- Resmî API'de `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1` için sunucu tarafı refusal fallback (`fallbacks: "default"`) açıktır; kapatmak için `providers.anthropic.options.fallbacks: false`. Reddedilen yanıtlar geçmişe eklenmez.
- `max_tokens` sınırına takılan araç çağrıları (girdisi yarım kalmış olabilir) çalıştırılmaz; model daha küçük adımlarla tekrar dener.
- İsteğe bağlı sunucu tarafı web araması: `providers.anthropic.options.webSearch: true`.

## Kütüphane olarak kullanım

```ts
import { ask, Runtime, type Tool } from "usta";

// Tek seferlik
const res = await ask("src/ içindeki TODO'ları listele", { cwd: "/yol/proje", onText: (t) => process.stdout.write(t) });

// Kendi araçlarınızla gömülü kullanım
const deploy: Tool<{ env: string }> = {
  name: "deploy",
  description: "Deploy the app to the given environment. Use only when the user asks for a deploy.",
  parameters: { type: "object", properties: { env: { type: "string", enum: ["staging", "prod"] } }, required: ["env"] },
  async execute(input, ctx) {
    await ctx.permit({ permission: "deploy", patterns: [input.env], always: [input.env], title: `Deploy to ${input.env}` });
    return { output: `Deployed to ${input.env}.` };
  },
};
// Etkileşimsiz çalışmada onay isteyen eylemler reddedilir; izinleri config ile verin.
const rt = await Runtime.create({
  cwd: process.cwd(),
  tools: [deploy],
  config: { permission: { deploy: { staging: "allow", prod: "deny" } } },
});
const session = await rt.newSession();
rt.bus.on((e) => e.type === "tool.end" && console.log(e.name, e.result.output));
await rt.engine.prompt(session, { text: "staging'e deploy et" }, { signal: new AbortController().signal });
await rt.close();
```

## Geliştirme

```bash
npm test            # birim + uçtan uca testler (sahte Anthropic / OpenAI Chat + Responses SSE sunucusu ve MCP sunucusu ile)
npm run typecheck
npm run build       # dist/
```

Mimari özeti:

```
src/
  cli.ts, main.ts, headless.ts   komut satırı, alt komutlar, usta run
  runtime.ts                     config + sağlayıcılar + izinler + araçlar + MCP + oturumları bağlar
  agent/                         engine (ajan döngüsü), system prompt, ajanlar, bağlam dosyaları, @mention
  provider/                      Anthropic, OpenAI Responses ve OpenAI uyumlu (Chat) adaptörler, model kataloğu, kayıt
  tool/                          read, write, edit, apply_patch, bash(+arka plan), glob, grep, ls, webfetch, todo, task, question, plan, skill
  permission/                    kural motoru ve bash ayrıştırıcı
  session/                       JSONL oturum deposu, gölge git anlık görüntüleri, dışa aktarma
  mcp/ hooks/ commands/          uzantılar
  lsp/                           dil sunucusu istemcisi ve düzenleme sonrası tanılamalar
  ui/                            terminal arayüzü (canlı bölge, editör, markdown, modallar)
  server/                        HTTP + SSE API ve web arayüzü
```

Çalışma zamanı bağımlılıkları yalnızca resmî `@anthropic-ai/sdk` ve `openai` SDK'larıdır; terminal arayüzü, markdown, diff, gitignore, YAML ön bilgi ve MCP istemcisi projede yazılmıştır.
