import { createPersistence } from "../persistence.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

export default async function handler(req, res) {
  // 只响应 /api/ 开头的请求
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith("/api/")) {
    res.status(404).end();
    return;
  }

  // CORS 头
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const persistence = await createPersistence(root);
    // 这里你可以添加具体的 API 路由，比如登录、获取单词等
    // 目前简单返回健康检查
    if (url.pathname === "/api/health") {
      res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
      return;
    }
    // 其他 API 路径返回 404
    res.status(404).json({ error: "API endpoint not found" });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
}
