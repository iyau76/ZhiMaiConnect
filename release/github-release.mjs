import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { fetch, ProxyAgent } from 'undici';
const dispatcher = new ProxyAgent({
  uri: process.env.HTTPS_PROXY || 'http://127.0.0.1:10809',
  // 安装包有一百多 MB，经代理上传时 GitHub 要收完才回响应头，默认 300 秒会撞
  // HeadersTimeoutError；上传其实已经落库，只是客户端等不到回执。放宽到 30 分钟。
  headersTimeout: 30 * 60 * 1000,
  bodyTimeout: 30 * 60 * 1000,
});
const repo = 'iyau76/ZhiMaiConnect';
const tag = process.env.ZHIMAI_RELEASE_TAG || 'v0.2.0-preview.1';
const credential = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});
const token = credential.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9);
if (!token) throw Error('No stored GitHub credential');
async function api(path, method = 'GET', body) {
  const res = await fetch('https://api.github.com' + path, {
    dispatcher, method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw Error(`GitHub ${method} ${path}: ${res.status}`);
  return res.json();
}
const prefix = `/repos/${repo}`;
const releases = await api(prefix + '/releases');
let release = releases.find(item => item.tag_name === tag);
const action = process.argv[2] || 'inspect';
if (action === 'inspect') {
  console.log(JSON.stringify({ releases: releases.map(r => ({ id:r.id, tag:r.tag_name, draft:r.draft })), main: (await api(prefix + '/commits/main')).sha }));
} else if (action === 'create') {
  if (release) throw Error('Release already exists; inspect before proceeding');
  release = await api(prefix + '/releases', 'POST', {
    tag_name: tag, target_commitish: process.env.ZHIMAI_RELEASE_COMMIT || '8327c23a098b36678f87801e801bda8f30dae98d',
    name: `知脉 Connect ${tag.slice(1).split('-')[0]} · Windows / Android 预览版`,
    body: readFileSync(process.env.ZHIMAI_RELEASE_NOTES || 'release/PUBLIC_RELEASE.md', 'utf8'), draft:true, prerelease:true,
  });
  console.log(JSON.stringify({ id:release.id, draft:release.draft }));
} else if (action === 'upload') {
  if (!release?.draft) throw Error('Expected existing draft release');
  for (const file of process.argv.slice(3)) {
    const name = basename(file);
    if (release.assets.some(a => a.name === name)) throw Error(`Asset already exists: ${name}`);
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    const res = await fetch(release.upload_url.split('{')[0] + '?name=' + encodeURIComponent(name), {
      dispatcher, method:'POST', headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/octet-stream', 'Content-Length':String(statSync(file).size) },
      body:createReadStream(file), duplex:'half',
    });
    if (!res.ok) throw Error(`Upload ${name}: ${res.status}`);
    const asset = await res.json();
    if (asset.size !== statSync(file).size || asset.state !== 'uploaded' || asset.digest !== 'sha256:' + sha) throw Error(`Asset verification failed: ${name}`);
    console.log(JSON.stringify({ name, size:asset.size, digest:asset.digest }));
  }
} else if (action === 'publish') {
  if (!release?.draft || release.assets.length < 2) throw Error('Expected draft with exactly 3 verified assets');
  const result = await api(prefix + '/releases/' + release.id, 'PATCH', { draft:false, prerelease:true, make_latest:'false' });
  console.log(result.html_url);
} else if (action === 'verify') {
  if (!release || release.draft) throw Error('Release not public');
  for (const asset of release.assets) {
    const res = await fetch(asset.browser_download_url, { dispatcher });
    if (!res.ok) throw Error(`Anonymous download ${asset.name}: ${res.status}`);
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of res.body) { hash.update(chunk); size += chunk.length; }
    const digest = 'sha256:' + hash.digest('hex');
    if (digest !== asset.digest || size !== asset.size) throw Error('Public download mismatch');
    console.log(JSON.stringify({ name:asset.name, size, digest, anonymousDownload:'PASS' }));
  }
} else throw Error('Unknown action');
await dispatcher.close();
