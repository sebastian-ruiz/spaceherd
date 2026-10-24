import { createServer } from 'node:http';
import { getForecast } from './forecast';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/forecast') {
    res.writeHead(404).end();
    return;
  }
  try {
    const forecast = await getForecast(url.searchParams.get('city') ?? 'London');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(forecast));
  } catch (err) {
    res.writeHead(502).end(String(err));
  }
});

server.listen(3000, () => console.log('listening on :3000'));
