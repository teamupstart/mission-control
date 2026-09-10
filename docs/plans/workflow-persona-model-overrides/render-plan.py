"""Render these plans offline using only Python's standard library."""
from pathlib import Path
import html
import re
import sys

ROOT = Path(__file__).parent


def inline(text):
    text = html.escape(text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    return re.sub(r"\[([^]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)


def render(source):
    blocks = []
    for block in source.strip().split("\n\n"):
        lines = block.splitlines()
        heading = re.fullmatch(r"(#{1,6}) (.+)", block)
        if heading:
            level = len(heading[1])
            blocks.append(f"<h{level}>{inline(heading[2])}</h{level}>")
        elif all(line.startswith("|") for line in lines):
            rows = [[inline(cell.strip()) for cell in line.strip("|").split("|")] for line in lines]
            head = "".join(f"<th>{cell}</th>" for cell in rows[0])
            body = "".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows[2:])
            blocks.append(f'<div class="wide"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>')
        elif all(re.match(r"(?:- |\d+\. )", line) for line in lines):
            tag = "ul" if lines[0].startswith("- ") else "ol"
            items = "".join("<li>" + inline(re.sub(r"^(?:- |\d+\. )", "", line)) + "</li>" for line in lines)
            blocks.append(f"<{tag}>{items}</{tag}>")
        else:
            blocks.append(f"<p>{inline(block)}</p>")
    return "\n".join(blocks)


FLOW = '''<div class="wide"><svg viewBox="0 0 900 220" role="img" aria-label="Before: dashboard to published Persona defaults to engine and runner. After: dashboard saves node override, publishing freezes it beside Persona defaults, engine selects override or defaults, and runner records actual execution.">
<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="currentColor"/></marker></defs>
<g fill="none" stroke="currentColor" marker-end="url(#arrow)"><path d="M200 64H240M440 64H480M680 64H720M200 169H240M440 169H480M680 169H720"/></g>
<g fill="var(--paper)" stroke="var(--line)"><rect x="10" y="35" width="190" height="60" rx="8"/><rect x="240" y="35" width="200" height="60" rx="8"/><rect x="480" y="35" width="200" height="60" rx="8"/><rect x="720" y="35" width="170" height="60" rx="8"/><rect x="10" y="140" width="190" height="60" rx="8"/><rect x="240" y="140" width="200" height="60" rx="8"/><rect x="480" y="140" width="200" height="60" rx="8"/><rect x="720" y="140" width="170" height="60" rx="8"/></g>
<g fill="currentColor" font-size="13" text-anchor="middle"><text x="45" y="22">Before</text><text x="45" y="127">After</text><text x="105" y="62">Dashboard</text><text x="105" y="80">Persona reference</text><text x="340" y="62">Published version</text><text x="340" y="80">Persona defaults</text><text x="580" y="62">Workflow engine</text><text x="580" y="80">Resolve defaults</text><text x="805" y="62">LLM runner</text><text x="805" y="80">Record execution</text><text x="105" y="167">Dashboard</text><text x="105" y="185">Reference + override</text><text x="340" y="167">Published version</text><text x="340" y="185">Snapshot + override</text><text x="580" y="167">Workflow engine</text><text x="580" y="185">Override or defaults</text><text x="805" y="167">LLM runner</text><text x="805" y="185">Record execution</text></g></svg></div>'''

CSS = '''
:root{color-scheme:light dark;--bg:#f1f4f8;--paper:#fff;--ink:#172536;--line:#cbd5e1;--accent:#195cab}
@media(prefers-color-scheme:dark){:root{--bg:#0c1420;--paper:#152132;--ink:#e1eaf5;--line:#3c5068;--accent:#90c4ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}main{max-width:1060px;margin:36px auto;padding:30px clamp(18px,5vw,56px);background:var(--paper);border:1px solid var(--line);border-radius:14px;min-width:0}h1{font-size:clamp(28px,4vw,42px);line-height:1.15}h2{margin-top:36px;padding-top:20px;border-top:1px solid var(--line);font-size:23px}h3{font-size:19px}a{color:var(--accent)}li{margin:9px 0}code{font-size:.87em;background:var(--bg);padding:2px 4px;border-radius:3px}.wide{max-width:100%;overflow:auto;margin:20px 0}table{width:100%;border-collapse:collapse;min-width:580px}td,th{padding:12px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--bg)}svg{display:block;min-width:740px;width:100%;font-family:system-ui,sans-serif}footer{margin-top:35px;font-size:13px} @media(max-width:600px){main{margin:0;border:0;border-radius:0}}
'''

for name in (['phased-plan'] if 'phased' in sys.argv else ['plan']):
    source = (ROOT / f'{name}.md').read_text()
    body = render(source)
    if '<h2>Execution flow</h2>' in body:
        body = body.replace('<h2>Execution flow</h2>', '<h2>Execution flow</h2>' + FLOW)
    title = html.escape(source.splitlines()[0].removeprefix('# '))
    output = f'<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title><style>{CSS}</style></head><body><main>{body}<footer>Source: <a href="{name}.md">{name}.md</a></footer></main></body></html>\n'
    path = ROOT / f'{name}.html'
    if '--check' in sys.argv:
        assert path.read_text() == output, f'{path.name} is stale'
    else:
        path.write_text(output)
    print(f'{path.relative_to(Path.cwd())}: source/render match')
