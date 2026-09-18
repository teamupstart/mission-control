import { readFileSync, writeFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const phased = process.argv.includes('phased');
const name = phased ? 'phased-plan' : 'plan';
const source = readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');
const components = {
  img: ({ src, alt }) => {
    const bytes = readFileSync(new URL(src, import.meta.url));
    const data = `data:image/svg+xml;base64,${bytes.toString('base64')}`;
    return React.createElement('img', { src: data, alt });
  },
  table: ({ children }) => React.createElement('div', { className: 'table-scroll' }, React.createElement('table', null, children)),
};
const body = renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, source));
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Startup tour picker | Mission Control</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f7;--paper:#fff;--fg:#182332;--muted:#536173;--line:#d7dde5;--accent:#946015}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1220px;margin:40px auto;padding:44px 52px;background:var(--paper);border:1px solid var(--line);border-radius:18px;min-width:0}h1{font-size:42px;letter-spacing:-1.2px;line-height:1.12;margin:8px 0 24px}h2{font-size:25px;line-height:1.3;margin-top:46px;border-top:1px solid var(--line);padding-top:30px}h3{font-size:21px;margin:34px 0 16px}p,li{max-width:94ch}li{margin:7px 0}a{color:var(--accent)}img{display:block;width:100%;height:auto;border-radius:12px;border:1px solid var(--line)}.table-scroll{max-width:100%;overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid var(--line);padding:12px;text-align:left;vertical-align:top;min-width:150px}th{background:var(--bg)}pre{overflow:auto;padding:16px;background:var(--bg);border-radius:8px}code{font-size:.88em;overflow-wrap:anywhere}.kicker{font-size:11px;letter-spacing:2px;color:var(--accent);font-weight:750;text-transform:uppercase}footer{margin-top:36px;color:var(--muted);font-size:12px}@media(prefers-color-scheme:dark){:root{--bg:#0a0c0f;--paper:#14181e;--fg:#e7ebf1;--muted:#939eae;--line:#303946;--accent:#f6a733}}@media(max-width:700px){main{margin:0;border:0;border-radius:0;padding:26px 16px}h1{font-size:32px}h2{font-size:23px}body{font-size:15px}}
</style></head><body><main><div class="kicker">Mission Control · Plan review</div>${body}<footer>Source: ${name}.md. Self-contained review page. Mockups illustrate proposed behavior.</footer></main></body></html>\n`;
const path = new URL(`./${name}.html`, import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== html) throw new Error(`${name}.html is stale`);
  console.log(`${name}.html matches ${name}.md and its mockup sources`);
} else writeFileSync(path, html);
