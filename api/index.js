export default async function handler(req, res) {
  // 允许跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // 测试端点
  if (url.pathname === '/api/health') {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
    return;
  }

  // 根 API 路径
  if (url.pathname === '/api' || url.pathname === '/api/') {
    res.status(200).json({ message: 'API is running' });
    return;
  }

  res.status(404).json({ error: 'Not found' });
}
