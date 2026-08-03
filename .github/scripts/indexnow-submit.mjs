// Notify IndexNow after the Square sync commit is publicly available.
// The key is public by design and must also be hosted on the storefront.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VALID_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const VALID_KEY = /^[A-Fa-f0-9]{32,64}$/;
const LISTING_PATH = /^data\/listings\/(lst_[A-Za-z0-9_-]{4,100})\.json$/;

export function buildIndexNowUrls(host, changedPaths) {
  if (!VALID_HOST.test(host)) throw new Error('INDEXNOW_HOST is invalid');
  const urls = new Set([`https://${host}/`, `https://${host}/sitemap.xml`]);
  for (const path of changedPaths) {
    const match = String(path).replaceAll('\\', '/').match(LISTING_PATH);
    if (match) urls.add(`https://${host}/listing/${match[1]}`);
  }
  return [...urls];
}

export async function submitIndexNow({ host, key, changedPaths, fetchImpl = fetch }) {
  if (!VALID_KEY.test(key)) throw new Error('INDEXNOW_KEY must be 32-64 hexadecimal characters');
  const urlList = buildIndexNowUrls(host, changedPaths);
  const response = await fetchImpl('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host,
      key,
      keyLocation: `https://${host}/${key}.txt`,
      urlList,
    }),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`IndexNow submission failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  return { status: response.status, urlList };
}

export async function main() {
  const host = String(process.env.INDEXNOW_HOST || '').trim().toLowerCase();
  const key = String(process.env.INDEXNOW_KEY || '').trim();
  const base = process.argv[2] || 'HEAD^';
  const changedPaths = execFileSync(
    'git', ['diff', '--name-only', base, 'HEAD', '--', 'data/listings'], { encoding: 'utf8' },
  ).split(/\r?\n/).filter(Boolean);
  const result = await submitIndexNow({ host, key, changedPaths });
  console.log(`IndexNow accepted ${result.urlList.length} URL(s) with HTTP ${result.status}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
