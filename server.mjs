import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, AlignmentType, BorderStyle, WidthType, ShadingType } from "docx";
import { createWorker } from "tesseract.js";
import { createPersistence } from "./persistence.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);

const OCR_CACHE_DIR = process.env.VERCEL
  ? join("/tmp", "toefl-vocab-tesseract-cache")
  : join(root, "data", "tesseract-cache");
const FINAL_S_BASE_EXCEPTIONS = /(?:[cs]ious|eous|ous|ss|is|us)$/;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
};

const PUBLIC_FILES = new Map([
  ["/", join(root, "index.html")],
  ["/index.html", join(root, "index.html")],
  ["/styles.css", join(root, "styles.css")],
  ["/app.js", join(root, "app.js")],
  ["/vendor/pdf/pdf.min.mjs", join(root, "node_modules/pdfjs-dist/build/pdf.min.mjs")],
  ["/vendor/pdf/pdf.worker.min.mjs", join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs")],
  ["/vendor/mammoth/mammoth.browser.min.js", join(root, "node_modules/mammoth/mammoth.browser.min.js")],
  ["/vendor/tesseract/tesseract.min.js", join(root, "node_modules/tesseract.js/dist/tesseract.min.js")],
  ["/vendor/tesseract/worker.min.js", join(root, "node_modules/tesseract.js/dist/worker.min.js")],
  ["/vendor/tesseract/core/tesseract-core-lstm.wasm.js", join(root, "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js")],
  ["/vendor/tesseract/lang/eng.traineddata.gz", join(root, "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz")],
]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

// ── data layer ──────────────────────────────────────────────

await mkdir(OCR_CACHE_DIR, { recursive: true, mode: 0o700 });
let persistence = null;
let persistenceInitError = "";
try {
  persistence = await createPersistence(root);
} catch (error) {
  persistenceInitError = error.message || "云端存储初始化失败";
  console.error("Persistence initialization failed:", persistenceInitError);
}
const serverSecret = persistence?.secret || "";
const sharedAiEnabled = Boolean(String(process.env.DEEPSEEK_API_KEY || "").trim());

const readUserState = (userId) => persistence.readState(userId);
const writeUserState = (userId, state) => persistence.writeState(userId, state);

// ── crypto helpers ──────────────────────────────────────────

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password, salt, hash) {
  return crypto.timingSafeEqual(
    Buffer.from(hashPassword(password, salt), "hex"),
    Buffer.from(hash, "hex")
  );
}

function encryptApiKey(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptApiKey(ciphertext) {
  try {
    const [ivHex, tagHex, encHex] = ciphertext.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

function encryptionKey() {
  if (/^[a-f0-9]{64}$/i.test(serverSecret)) return Buffer.from(serverSecret, "hex");
  return crypto.createHash("sha256").update(serverSecret).digest();
}

// ── session helpers ─────────────────────────────────────────

async function getSessionUser(request) {
  if (!persistence) return null;
  const cookie = parseCookies(request)["session"];
  if (!cookie) return null;
  const session = await persistence.getSession(cookie);
  return session?.user_id || null;
}

function setSessionCookie(response, token) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  response.setHeader("Set-Cookie", `session=${token}; HttpOnly; SameSite=Strict; Max-Age=604800; Path=/${secure}`);
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  const map = {};
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) map[key] = rest.join("=");
  }
  return map;
}

// ── wordbank ─────────────────────────────────────────────────

let wordbankMap = new Map();
try {
  const raw = await readFile(join(root, "wordbank.json"), "utf-8");
  const wordbank = JSON.parse(raw);
  wordbank.forEach((w) => wordbankMap.set(w.word.toLowerCase(), w));
  console.log(`词库已加载：${wordbankMap.size} 个词`);
} catch {
  console.log("未找到本地词库文件，将完全依赖 API");
}

let glossaryMap = new Map();
try {
  const raw = await readFile(join(root, "glossary.json"), "utf-8");
  const glossary = JSON.parse(raw);
  glossary.forEach((entry) => glossaryMap.set(entry.word.toLowerCase(), entry));
  console.log(`基础释义库已加载：${glossaryMap.size} 个词`);
} catch {
  console.log("未找到基础释义库，将只使用本地词库释义");
}

// Simple in-memory audio cache
const audioCache = new Map();
let ocrWorkerPromise = null;
let ocrQueue = Promise.resolve();

// ── server ───────────────────────────────────────────────────

export async function handleRequest(request, response) {
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    const rewrittenRoute = url.searchParams.get("__route");
    if (rewrittenRoute) {
      url.pathname = `/api/${rewrittenRoute.replace(/^\/+/, "")}`;
      url.searchParams.delete("__route");
    }

    // Health check
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, persistence ? 200 : 503, {
        status: persistence ? "ok" : "misconfigured",
        storage: persistence?.kind || null,
        error: persistence ? undefined : persistenceInitError,
      });
    }

    // These routes do not require cloud storage and remain available without Supabase.
    if (request.method === "POST" && url.pathname === "/api/ocr") {
      return recognizeImage(request, response);
    }
    if (request.method === "POST" && url.pathname === "/api/deepseek") {
      return proxyDeepSeek(request, response);
    }
    if (request.method === "GET" && url.pathname === "/api/dictionary") {
      return lookupDictionaryAudio(url, response);
    }
    if (request.method === "GET" && url.pathname === "/api/audio") {
      return streamWordAudio(request, url, response);
    }
    if (request.method === "POST" && url.pathname === "/api/wordbank/lookup") {
      return lookupWordbank(request, response);
    }
    if (request.method === "POST" && url.pathname === "/api/glossary/lookup") {
      return lookupGlossary(request, response);
    }
    if (request.method === "POST" && url.pathname === "/api/lemmatize") {
      return lemmatizeWords(request, response);
    }
    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/export/docx") {
      return exportDocx(request, response);
    }

    if (!persistence) {
      return json(response, 503, {
        error: persistenceInitError || "云端存储尚未配置",
        code: "CLOUD_STORAGE_NOT_CONFIGURED",
      });
    }

    // ── auth routes ──

    if (request.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await readJsonBody(request);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(response, 400, { error: "请输入有效的邮箱地址" });
      if (password.length < 6) return json(response, 400, { error: "密码至少需要 6 个字符" });
      if (await persistence.findUserByEmail(email)) return json(response, 409, { error: "该邮箱已注册" });

      const userId = crypto.randomUUID();
      const salt = crypto.randomBytes(16).toString("hex");
      try {
        await persistence.createUser({
          id: userId,
          email,
          password_hash: hashPassword(password, salt),
          salt,
          created_at: new Date().toISOString(),
        });
      } catch (error) {
        if (error.code === "DUPLICATE_EMAIL") return json(response, 409, { error: "该邮箱已注册" });
        throw error;
      }

      const token = crypto.randomBytes(32).toString("hex");
      await persistence.createSession(token, userId);
      setSessionCookie(response, token);

      return json(response, 201, {
        user: { email },
        hasApiKey: sharedAiEnabled,
        sharedAiEnabled,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(request);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");

      const user = await persistence.findUserByEmail(email);
      if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
        return json(response, 401, { error: "邮箱或密码不正确" });
      }

      const token = crypto.randomBytes(32).toString("hex");
      await persistence.createSession(token, user.id);
      setSessionCookie(response, token);

      const userState = await readUserState(user.id);
      return json(response, 200, {
        user: { email },
        hasApiKey: sharedAiEnabled || Boolean(userState?.api_key_encrypted),
        sharedAiEnabled,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const cookie = parseCookies(request)["session"];
      if (cookie) await persistence.deleteSession(cookie);
      response.setHeader("Set-Cookie", `session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/${process.env.VERCEL ? "; Secure" : ""}`);
      return json(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      const userId = await getSessionUser(request);
      const user = userId ? await persistence.getUserById(userId) : null;
      if (!user) return json(response, 200, { user: null });
      const userState = await readUserState(userId);
      return json(response, 200, {
        user: { email: user.email },
        hasApiKey: sharedAiEnabled || Boolean(userState?.api_key_encrypted),
        sharedAiEnabled,
      });
    }

    // ── state routes ──

    if (request.method === "GET" && url.pathname === "/api/state") {
      const userId = await getSessionUser(request);
      if (!userId) return json(response, 401, { error: "请先登录" });
      const state = await readUserState(userId);
      if (!state) {
        return json(response, 200, { words: [], settings: { model: "deepseek-v4-flash", hideBasic: true, dailyGoal: 20 }, streak: 0, reviewsToday: 0, lastStudyDate: null });
      }
      const { api_key_encrypted: _privateKey, ...publicState } = state;
      return json(response, 200, publicState);
    }

    if (request.method === "POST" && url.pathname === "/api/state") {
      const userId = await getSessionUser(request);
      if (!userId) return json(response, 401, { error: "请先登录" });
      const body = await readJsonBody(request);
      if (!body || !Array.isArray(body.words)) return json(response, 400, { error: "数据格式不正确" });
      if (body.words.length > 20000) return json(response, 413, { error: "词库数据过大" });
      const existingState = (await readUserState(userId)) || {};
      const { api_key_encrypted: _ignoredClientKey, ...safeBody } = body;
      if (existingState.api_key_encrypted) safeBody.api_key_encrypted = existingState.api_key_encrypted;
      await writeUserState(userId, safeBody);
      return json(response, 200, { ok: true });
    }

    // ── api key routes ──

    if (request.method === "PUT" && url.pathname === "/api/auth/api-key") {
      const userId = await getSessionUser(request);
      if (!userId) return json(response, 401, { error: "请先登录" });
      const body = await readJsonBody(request);
      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey) return json(response, 400, { error: "请输入 API Key" });
      const state = (await readUserState(userId)) || { words: [], settings: {} };
      state.api_key_encrypted = encryptApiKey(apiKey);
      await writeUserState(userId, state);
      return json(response, 200, { ok: true });
    }

    if (request.method === "DELETE" && url.pathname === "/api/auth/api-key") {
      const userId = await getSessionUser(request);
      if (!userId) return json(response, 401, { error: "请先登录" });
      const state = (await readUserState(userId)) || { words: [], settings: {} };
      delete state.api_key_encrypted;
      await writeUserState(userId, state);
      return json(response, 200, { ok: true, hasApiKey: sharedAiEnabled });
    }

    // ── static files ──

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(response, 405, { error: "Method not allowed" });
    }

    const filePath = resolvePublicFile(url.pathname);
    if (!filePath) return json(response, 404, { error: "Not found" });

    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) return json(response, 404, { error: "Not found" });

    const fileBody = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const headers = {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": fileStats.size,
      "Cache-Control": [".mp3", ".wasm", ".gz"].includes(ext) ? "public, max-age=86400" : "no-store",
      "Accept-Ranges": "bytes",
    };
    response.writeHead(200, headers);
    if (request.method === "HEAD") return response.end();
    response.end(fileBody);
  } catch (error) {
    if (error?.code === "ENOENT") return json(response, 404, { error: "Not found" });
    console.error(error);
    return json(response, 500, { error: "服务器处理失败" });
  }
}

if (!process.env.VERCEL) {
  const server = createServer(handleRequest);
  server.listen(port, "127.0.0.1", () => {
    console.log(`词研所已启动：http://127.0.0.1:${port}`);
  });
}

function resolvePublicFile(pathname) {
  if (PUBLIC_FILES.has(pathname)) return PUBLIC_FILES.get(pathname);

  if (pathname.startsWith("/media/")) {
    const filename = decodeURIComponent(pathname.slice("/media/".length));
    if (filename !== basename(filename) || !/^[\w .()'-]+\.mp3$/i.test(filename)) return null;
    return join(root, "media", filename);
  }

  return null;
}

// ── docx export ─────────────────────────────────────────────

async function exportDocx(request, response) {
  const userId = await getSessionUser(request);
  let state;
  if (userId) {
    state = (await readUserState(userId)) || { words: [] };
  } else if (request.method === "POST") {
    // Non-logged-in users can POST their state
    try { state = await readJsonBody(request); } catch { state = { words: [] }; }
  } else {
    state = { words: [] };
  }

  if (!state.words || !state.words.length) {
    return json(response, 400, { error: "没有可导出的词汇" });
  }

  const words = state.words;
  const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const headerCell = (text, width) => new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading: { fill: "174638", type: ShadingType.CLEAR },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, font: "Noto Sans SC", size: 18, color: "FFFFFF" })] })],
  });

  const dataCell = (text, width) => new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text: String(text || ""), font: "Noto Sans SC", size: 18 })] })],
  });

  const colWidths = [1200, 700, 700, 2200, 2200, 1800, 1360];
  const headerTexts = ["单词", "词性", "分类", "中文释义", "英文释义", "写作搭配", "近义词"];

  const headerRow = new TableRow({
    tableHeader: true,
    children: headerTexts.map((t, i) => headerCell(t, colWidths[i])),
  });

  const dataRows = words.map((w) => {
    const def = w.definitions?.[0] || {};
    const colls = (w.collocations || []).map(c => c.phrase).join("; ");
    const syns = (w.synonyms || []).map(s => s.word).join("; ");
    return new TableRow({
      children: [
        dataCell(w.word, colWidths[0]),
        dataCell(w.partOfSpeech || "", colWidths[1]),
        dataCell(w.mode === "spelling" ? "拼写" : "识记", colWidths[2]),
        dataCell(def.zh || "", colWidths[3]),
        dataCell(def.en || "", colWidths[4]),
        dataCell(colls, colWidths[5]),
        dataCell(syns, colWidths[6]),
      ],
    });
  });

  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Noto Sans SC", size: 20 } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 16838, height: 11906, orientation: "landscape" },
          margin: { top: 720, right: 720, bottom: 720, left: 720 },
        },
      },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: "词研所 · TOEFL 词汇导出", bold: true, size: 36, font: "Noto Sans SC" })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
          children: [new TextRun({ text: `导出时间：${new Date().toLocaleDateString("zh-CN")}  ·  共 ${words.length} 个词`, size: 18, color: "888888", font: "Noto Sans SC" })],
        }),
        new Table({
          width: { size: 10160, type: WidthType.DXA },
          columnWidths: colWidths,
          rows: [headerRow, ...dataRows],
        }),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = `TOEFL-vocab-export-${new Date().toISOString().slice(0, 10)}.docx`;
  response.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent("TOEFL词汇导出")}_${new Date().toISOString().slice(0, 10)}.docx`,
    "Cache-Control": "no-store",
  });
  response.end(buffer);
}

// ── local OCR ───────────────────────────────────────────────

async function recognizeImage(request, response) {
  const startedAt = Date.now();
  try {
    const body = await readJsonBody(request, process.env.VERCEL ? 4_400_000 : 18_000_000);
    const mimeType = String(body.mimeType || "").toLowerCase();
    const imageBase64 = String(body.imageBase64 || "");
    const allowedTypes = new Set([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/bmp",
      "image/gif",
    ]);

    if (!allowedTypes.has(mimeType)) {
      return json(response, 400, { error: "仅支持 PNG、JPG、WebP、BMP 或 GIF 图片" });
    }
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(imageBase64)) {
      return json(response, 400, { error: "图片数据格式不正确" });
    }

    const image = Buffer.from(imageBase64, "base64");
    const maxImageBytes = process.env.VERCEL ? 3 * 1024 * 1024 : 12 * 1024 * 1024;
    if (!image.length || image.length > maxImageBytes) {
      return json(response, 413, { error: "图片处理后仍然过大，请裁剪后重试" });
    }
    if (!hasExpectedImageSignature(image, mimeType)) {
      return json(response, 400, { error: "图片内容与文件格式不匹配" });
    }

    console.info("[ocr] recognition started", { mimeType, bytes: image.length });
    const result = await enqueueOcr(image);
    const text = String(result.data?.text || "").trim();
    if (!text) return json(response, 422, { error: "图片中未识别到英文文字，请尝试更清晰、正向的图片" });

    console.info("[ocr] recognition completed", {
      elapsedMs: Date.now() - startedAt,
      confidence: Number(result.data?.confidence || 0),
      characters: text.length,
    });
    return json(response, 200, {
      text,
      confidence: Number(result.data?.confidence || 0),
    });
  } catch (error) {
    console.error("[ocr] recognition failed", {
      elapsedMs: Date.now() - startedAt,
      error: error?.message || String(error),
      stack: error?.stack,
    });
    return json(response, 500, { error: "图片识别失败，请换一张更清晰的图片重试" });
  }
}

function enqueueOcr(image) {
  const job = ocrQueue.then(async () => {
    try {
      if (!ocrWorkerPromise) {
        ocrWorkerPromise = createWorker("eng", 1, {
          langPath: join(root, "node_modules/@tesseract.js-data/eng/4.0.0_best_int"),
          cachePath: OCR_CACHE_DIR,
        });
      }
      const worker = await withTimeout(ocrWorkerPromise, 25_000, "OCR 模型加载超时");
      return await withTimeout(worker.recognize(image), 35_000, "OCR 图片识别超时");
    } catch (error) {
      const staleWorker = ocrWorkerPromise;
      ocrWorkerPromise = null;
      staleWorker?.then((worker) => worker.terminate()).catch(() => {});
      throw error;
    }
  });
  ocrQueue = job.catch(() => {});
  return job;
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function hasExpectedImageSignature(buffer, mimeType) {
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (mimeType === "image/gif") return buffer.subarray(0, 6).toString("ascii").startsWith("GIF8");
  if (mimeType === "image/bmp") return buffer.subarray(0, 2).toString("ascii") === "BM";
  if (mimeType === "image/webp") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

// ── proxy DeepSeek ───────────────────────────────────────────

async function proxyDeepSeek(request, response) {
  try {
    const body = await readJsonBody(request);
    let apiKey = String(body.apiKey || "").trim();
    const model = String(body.model || "deepseek-v4-flash");
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // A site-owner key is available only to signed-in users and is quota limited.
    if (!apiKey && sharedAiEnabled) {
      const userId = await getSessionUser(request);
      if (!userId) return json(response, 401, { error: "请先登录后使用站点提供的 AI" });
      const withinQuota = await persistence.consumeAiQuota(userId, 50);
      if (!withinQuota) {
        return json(response, 429, { error: "今天的共享 AI 调用次数已用完，请明天再试" });
      }
      apiKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
    }

    // Otherwise use the signed-in user's encrypted key.
    if (!apiKey) {
      const userId = await getSessionUser(request);
      if (userId) {
        const state = await readUserState(userId);
        if (state?.api_key_encrypted) apiKey = decryptApiKey(state.api_key_encrypted);
      }
    }

    if (!apiKey) return json(response, 400, { error: "缺少 DeepSeek API Key，请在设置中保存" });
    if (!messages.length) return json(response, 400, { error: "缺少生成内容" });
    const modelAliases = {
      "deepseek-chat": "deepseek-v4-flash",
      "deepseek-reasoner": "deepseek-v4-pro",
    };
    const upstreamModel = modelAliases[model] || model;
    if (!["deepseek-v4-flash", "deepseek-v4-pro"].includes(upstreamModel)) {
      return json(response, 400, { error: "不支持的模型" });
    }

    const upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: upstreamModel,
        messages,
        stream: false,
        temperature: 0.25,
      }),
    });

    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(text);
  } catch (error) {
    json(response, 502, { error: `无法连接 DeepSeek：${error.message}` });
  }
}

// ── dictionary ───────────────────────────────────────────────

async function lookupDictionaryAudio(url, response) {
  const word = String(url.searchParams.get("word") || "").toLowerCase();
  if (!/^[a-z][a-z'-]{1,48}$/.test(word)) {
    return json(response, 400, { error: "Invalid word" });
  }

  const source = await findAudioSource(word);
  if (!source) return json(response, 200, { audio: "" });
  return json(response, 200, {
    audio: source.kind === "local"
      ? source.url
      : `/api/audio?word=${encodeURIComponent(word)}`,
    source: source.source || (source.kind === "local" ? "本地词库" : "在线词典"),
  });
}

async function findAudioSource(word) {
  const localEntry = wordbankMap.get(word);
  if (localEntry?.audio) {
    const filename = basename(localEntry.audio);
    if (/^[\w .()'-]+\.mp3$/i.test(filename)) {
      return {
        kind: "local",
        url: `/media/${encodeURIComponent(filename)}`,
        source: localEntry.source || "本地词库",
      };
    }
  }

  if (audioCache.has(word)) return audioCache.get(word);
  const result = await tryFreeDictionaryAPI(word) || await tryWiktionaryAPI(word) || null;
  audioCache.set(word, result);
  return result;
}

async function streamWordAudio(request, url, response) {
  const word = String(url.searchParams.get("word") || "").toLowerCase();
  if (!/^[a-z][a-z'-]{1,48}$/.test(word)) {
    return json(response, 400, { error: "Invalid word" });
  }

  const source = await findAudioSource(word);
  if (!source) return json(response, 404, { error: "Audio not found" });

  if (source.kind === "local") {
    response.writeHead(302, {
      Location: source.url,
      "Cache-Control": "public, max-age=86400",
    });
    return response.end();
  }

  if (!isTrustedAudioUrl(source.url)) {
    return json(response, 502, { error: "Untrusted audio source" });
  }

  try {
    const upstream = await fetch(source.url, {
      headers: { "User-Agent": "TOEFL-Vocab-Studio/1.0" },
      redirect: "follow",
    });
    if (!upstream.ok) return json(response, 502, { error: "Audio source unavailable" });
    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.startsWith("audio/")) return json(response, 502, { error: "Invalid audio response" });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > 2_000_000) return json(response, 502, { error: "Audio file too large" });
    return sendAudioBuffer(request, response, body, contentType);
  } catch {
    return json(response, 502, { error: "Audio proxy failed" });
  }
}

function sendAudioBuffer(request, response, body, contentType) {
  const range = request.headers.range;
  const commonHeaders = {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400",
    "Accept-Ranges": "bytes",
  };

  if (!range) {
    response.writeHead(200, { ...commonHeaders, "Content-Length": body.length });
    return response.end(body);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { ...commonHeaders, "Content-Range": `bytes */${body.length}` });
    return response.end();
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= body.length) {
    response.writeHead(416, { ...commonHeaders, "Content-Range": `bytes */${body.length}` });
    return response.end();
  }

  const chunk = body.subarray(start, end + 1);
  response.writeHead(206, {
    ...commonHeaders,
    "Content-Length": chunk.length,
    "Content-Range": `bytes ${start}-${end}/${body.length}`,
  });
  return response.end(chunk);
}

function isTrustedAudioUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && [
      "api.dictionaryapi.dev",
      "upload.wikimedia.org",
      "commons.wikimedia.org",
    ].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function tryFreeDictionaryAPI(word) {
  try {
    const upstream = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      headers: { "User-Agent": "TOEFL-Vocab-Studio/1.0" },
    });
    if (!upstream.ok) return null;
    const entries = await upstream.json();
    const phonetics = Array.isArray(entries)
      ? entries.flatMap((entry) => (Array.isArray(entry.phonetics) ? entry.phonetics : []))
      : [];
    const us = phonetics.find((item) => typeof item.audio === "string" && item.audio.startsWith("http"));
    if (us) return { kind: "remote", url: us.audio, source: us.sourceUrl || "Free Dictionary API" };
  } catch { /* fall through */ }
  return null;
}

async function tryWiktionaryAPI(word) {
  try {
    const upstream = await fetch(
      `https://en.wiktionary.org/api/rest_v1/page/audio/${encodeURIComponent(word)}`,
      { headers: { "User-Agent": "TOEFL-Vocab-Studio/1.0" } }
    );
    if (!upstream.ok) return null;
    const data = await upstream.json();
    const items = data?.en || [];
    const audioUrl = items.find((item) => typeof item.url === "string" && item.url.startsWith("http"))?.url;
    if (audioUrl) return { kind: "remote", url: audioUrl, source: "Wiktionary" };
  } catch { /* fall through */ }
  return null;
}

// ── wordbank ─────────────────────────────────────────────────

async function lookupWordbank(request, response) {
  try {
    const body = await readJsonBody(request);
    const words = Array.isArray(body.words) ? body.words : [];
    const found = {};
    const missing = [];
    for (const w of words) {
      const key = String(w || "").toLowerCase().trim();
      if (!key) continue;
      const entry = wordbankMap.get(key);
      if (entry) {
        found[key] = {
          word: entry.word,
          partOfSpeech: entry.partOfSpeech,
          definitions: entry.definitions,
          irregularForms: entry.irregularForms || [],
          wordFamily: entry.wordFamily || [],
          collocations: entry.collocations || [],
          synonyms: entry.synonyms || [],
          audio: entry.audio
            ? `/media/${encodeURIComponent(basename(entry.audio))}`
            : "",
          source: entry.source || "本地词库",
        };
      } else {
        missing.push(key);
      }
    }
    return json(response, 200, { found, missing });
  } catch (error) {
    return json(response, 400, { error: error.message });
  }
}

async function lookupGlossary(request, response) {
  try {
    const body = await readJsonBody(request, 1_000_000);
    const words = Array.isArray(body.words) ? body.words : [];
    if (words.length > 5000) {
      return json(response, 413, { error: "一次最多查询 5000 个单词" });
    }
    const found = {};
    const missing = [];
    for (const value of words) {
      const key = String(value || "").toLowerCase().trim();
      if (!key || found[key]) continue;
      const wordbankEntry = wordbankMap.get(key);
      const glossaryEntry = glossaryMap.get(key);
      if (wordbankEntry) {
        found[key] = {
          word: key,
          partOfSpeech: wordbankEntry.partOfSpeech || glossaryEntry?.partOfSpeech || "",
          zh: wordbankEntry.definitions?.[0]?.zh || glossaryEntry?.zh || "",
          source: wordbankEntry.source || "本地词库",
        };
      } else if (glossaryEntry) {
        found[key] = glossaryEntry;
      } else {
        missing.push(key);
      }
    }
    return json(response, 200, { found, missing });
  } catch (error) {
    return json(response, 400, { error: error.message });
  }
}

async function lemmatizeWords(request, response) {
  try {
    const body = await readJsonBody(request, 1_000_000);
    const words = Array.isArray(body.words) ? body.words : [];
    if (words.length > 5000) {
      return json(response, 413, { error: "一次最多处理 5000 个不同单词" });
    }

    const lemmas = {};
    for (const value of words) {
      const word = normalizeToken(value);
      if (!word || lemmas[word]) continue;
      lemmas[word] = resolveLemma(word);
    }
    return json(response, 200, { lemmas });
  } catch (error) {
    return json(response, 400, { error: error.message || "词形还原失败" });
  }
}

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/(?:'s|s')$/i, "")
    .replace(/^'+|'+$/g, "");
}

function resolveLemma(word) {
  const irregular = {
    arose: "arise", arisen: "arise", became: "become", begun: "begin", began: "begin",
    broke: "break", broken: "break", brought: "bring", built: "build", bought: "buy",
    caught: "catch", chose: "choose", chosen: "choose", came: "come", dealt: "deal",
    drew: "draw", drawn: "draw", driven: "drive", drove: "drive", fell: "fall",
    fallen: "fall", found: "find", gave: "give", given: "give", grew: "grow",
    grown: "grow", held: "hold", kept: "keep", led: "lead", left: "leave",
    meant: "mean", met: "meet", paid: "pay", rose: "rise", risen: "rise",
    ran: "run", sent: "send", spoke: "speak", spoken: "speak", spent: "spend",
    stood: "stand", taught: "teach", told: "tell", understood: "understand",
    wore: "wear", worn: "wear", wrote: "write", written: "write",
  };
  if (irregular[word]) return irregular[word];
  if (wordbankMap.has(word) && !looksInflected(word)) return word;

  const candidates = inflectionCandidates(word);
  const derivedCandidates = candidates.filter((candidate) => candidate !== word);
  const wordbankMatch = derivedCandidates.find((candidate) => wordbankMap.has(candidate));
  const inflectionExceptions = new Set([
    "anything", "ceiling", "darling", "during", "evening", "everything",
    "king", "morning", "nothing", "offspring", "ring", "something",
    "spring", "sterling", "string", "thing", "unwilling", "willing",
  ]);
  if (!wordbankMatch && inflectionExceptions.has(word)) return word;
  return wordbankMatch || fallbackLemma(word);
}

function inflectionCandidates(word) {
  const candidates = [];
  const add = (value) => {
    if (value?.length >= 3 && !candidates.includes(value)) candidates.push(value);
  };

  if (word.endsWith("ying") && word.length > 4) {
    const root = word.slice(0, -4);
    add(`${root}ie`);
  }
  if (word.endsWith("ing") && word.length >= 6) {
    const root = word.slice(0, -3);
    if (/([b-df-hj-np-tv-z])\1$/.test(root)) add(root.slice(0, -1));
    add(`${root}e`);
    add(root);
  }
  if (word.endsWith("ied") && word.length >= 5) add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ed") && word.length >= 5) {
    const root = word.slice(0, -2);
    if (/([b-df-hj-np-tv-z])\1$/.test(root)) add(root.slice(0, -1));
    add(`${root}e`);
    add(root);
  }
  if (word.endsWith("ies") && word.length >= 5) add(`${word.slice(0, -3)}y`);
  if (word.endsWith("sses")) add(word.slice(0, -2));
  if (/(ches|shes|xes|zes|oes)$/.test(word)) add(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4) add(word.slice(0, -1));
  if (word.endsWith("ly") && word.length > 5) {
    add(word.slice(0, -2));
    if (word.endsWith("ily")) add(`${word.slice(0, -3)}y`);
  }
  if (word.endsWith("est") && word.length > 6) {
    const root = word.slice(0, -3);
    add(`${root}e`);
    add(root);
  }
  if (word.endsWith("er") && word.length > 5) {
    const root = word.slice(0, -2);
    add(`${root}e`);
    add(root);
  }

  add(word);
  return candidates;
}

function fallbackLemma(word) {
  if (word.endsWith("ies") && word.length >= 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ying") && word.length > 4) return `${word.slice(0, -4)}ie`;
  if (word.endsWith("ing") && word.length >= 6) {
    const root = word.slice(0, -3);
    if (/([b-df-hj-np-tv-z])\1$/.test(root)) return root.slice(0, -1);
    if (root.endsWith("at") || ["mak", "tak", "giv", "hav", "mov", "writ", "driv"].includes(root)) return `${root}e`;
    return root;
  }
  if (word.endsWith("ied") && word.length >= 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ed") && word.length >= 5) {
    const root = word.slice(0, -2);
    if (/([b-df-hj-np-tv-z])\1$/.test(root)) return root.slice(0, -1);
    if (root.endsWith("at") || ["us", "mov", "lov", "liv", "creat"].includes(root)) return `${root}e`;
    return root;
  }
  if (word.endsWith("s") && shouldStripFinalS(word)) return word.slice(0, -1);
  return word;
}

function looksInflected(word) {
  if (word.endsWith("ies") && word.length >= 5) return true;
  if (word.endsWith("ied") && word.length >= 5) return true;
  if (word.endsWith("ing") && word.length >= 6) return true;
  if (word.endsWith("ed") && word.length >= 5) return true;
  if (/(ches|shes|xes|zes|oes)$/.test(word)) return true;
  if (word.endsWith("s") && shouldStripFinalS(word)) return true;
  return false;
}

function shouldStripFinalS(word) {
  if (!word || word.length <= 4) return false;
  if (FINAL_S_BASE_EXCEPTIONS.test(word)) return false;
  return true;
}

// ── utils ────────────────────────────────────────────────────

function readJsonBody(request, maxBytes = 5_000_000) {
  if (request.body !== undefined && request.body !== null) {
    if (Buffer.isBuffer(request.body)) {
      if (request.body.length > maxBytes) return Promise.reject(new Error("Request too large"));
      try {
        return Promise.resolve(JSON.parse(request.body.toString("utf8") || "{}"));
      } catch {
        return Promise.reject(new Error("Invalid JSON"));
      }
    }
    if (typeof request.body === "string") {
      if (Buffer.byteLength(request.body) > maxBytes) return Promise.reject(new Error("Request too large"));
      try {
        return Promise.resolve(JSON.parse(request.body || "{}"));
      } catch {
        return Promise.reject(new Error("Invalid JSON"));
      }
    }
    if (typeof request.body === "object") return Promise.resolve(request.body);
  }

  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("Request too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}
