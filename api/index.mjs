import { handleRequest } from "../server.mjs";

export default async function handler(request, response) {
  return handleRequest(request, response);
}
import { createPersistence } from "../persistence.mjs";

const root = new URL("../", import.meta.url).pathname;

export default async function handler(req, res) {
  // 设置 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const persistence = await createPersistence(root);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // 简单路由示例
    if (path === '/api/health' && req.method === 'GET') {
      res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
      return;
    }

    // 其他路由... 根据你的实际需求添加

    res.status(404).json({ error: 'Not found' });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
