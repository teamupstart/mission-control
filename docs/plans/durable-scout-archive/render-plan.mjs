import { readFileSync, writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const isPhased = process.argv[2] === "phased";
const sourceName = isPhased ? "phased-plan.md" : "plan.md";
const outputName = isPhased ? "phased-plan.html" : "plan.html";
const sourcePath = new URL(`./${sourceName}`, import.meta.url);
const outputPath = new URL(`./${outputName}`, import.meta.url);
const source = readFileSync(sourcePath, "utf8");

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function textOf(children) {
  return React.Children.toArray(children)
    .map((child) => (typeof child === "string" ? child : child?.props ? textOf(child.props.children) : ""))
    .join("");
}

const components = {
  h1: ({ children }) => React.createElement("h1", { id: slug(textOf(children)) }, children),
  h2: ({ children }) => React.createElement("h2", { id: slug(textOf(children)) }, children),
  h3: ({ children }) => React.createElement("h3", { id: slug(textOf(children)) }, children),
  a: ({ href, children }) => React.createElement(
    "a",
    {
      href,
      target: href?.startsWith("http") ? "_blank" : undefined,
      rel: href?.startsWith("http") ? "noreferrer" : undefined,
    },
    children,
  ),
};

let body = renderToStaticMarkup(
  React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, source),
);

const deletionFlow = `
<figure class="flow deletion" aria-labelledby="deletion-flow-title">
  <figcaption id="deletion-flow-title">Delete one scout from the Scouts UI</figcaption>
  <svg viewBox="0 0 1200 300" role="img" aria-label="The user chooses Delete scout, types DELETE, and submits the bound archive key. The daemon verifies the generated path, atomically moves the bundle to trash, removes derived index rows, and refreshes the UI. Verification failures keep the modal and scout open.">
    <defs>
      <marker id="delete-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <g class="edges">
      <path d="M180 88H220"/><path d="M380 88H420"/><path d="M580 88H620"/><path d="M780 88H820"/><path d="M980 88H1020"/>
      <path d="M1100 128V198"/><path d="M900 128V198"/><path class="failure" d="M700 128V198"/>
    </g>
    <g class="node" transform="translate(20 48)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Delete scout</text><text class="sub" x="80" y="53">header or row action</text></g>
    <g class="node verify" transform="translate(220 48)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Confirm</text><text class="sub" x="80" y="51">type DELETE</text><text class="sub" x="80" y="67">bind archive key</text></g>
    <g class="node" transform="translate(420 48)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Delete route</text><text class="sub" x="80" y="53">daemon-owned action</text></g>
    <g class="node verify" transform="translate(620 48)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Verify</text><text class="sub" x="80" y="51">confirmation · identity</text><text class="sub" x="80" y="67">generated containment</text></g>
    <g class="node retry" transform="translate(820 48)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Move to trash</text><text class="sub" x="80" y="53">atomic local move</text></g>
    <g class="node db" transform="translate(1020 48)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Remove index</text><text class="sub" x="80" y="53">derived rows only</text></g>
    <g class="node done" transform="translate(1020 198)"><rect width="160" height="65" rx="13"/><text x="80" y="27">Refresh Scouts</text><text class="sub" x="80" y="47">select next · keep filters</text></g>
    <g class="node" transform="translate(820 198)"><rect width="160" height="65" rx="13"/><text x="80" y="27">Cleanup</text><text class="sub" x="80" y="47">remove trash entry</text></g>
    <g class="node retry" transform="translate(620 198)"><rect width="160" height="65" rx="13"/><text x="80" y="27">Keep open</text><text class="sub" x="80" y="47">specific failure reason</text></g>
  </svg>
  <p>Deletion targets the composite archive key and the server-verified local path. It never cascades through task or session records.</p>
</figure>`;

const dataFlow = `
<figure class="flow" aria-labelledby="data-flow-title">
  <figcaption id="data-flow-title">Portable scout library data and request flow</figcaption>
  <svg viewBox="0 0 1200 440" role="img" aria-label="A scout submits a self-contained HTML report and explicit supporting artifacts. Mission Control captures them into the portable library before task completion. Filesystem copy or sync can add immutable bundles from other producers. A background reconciler indexes only new and changed bundles in disposable SQLite, while the Scouts page reads bounded routes from the daemon.">
    <defs>
      <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <g class="edges">
      <path d="M202 90H250"/><path d="M440 90H492"/><path d="M682 90H740"/><path d="M930 90H988"/>
      <path d="M345 140V214"/><path d="M587 214V140"/><path d="M202 362H740"/>
      <path d="M835 322V140"/><path d="M740 348C682 348 682 128 682 128"/>
    </g>
    <g class="node scout" transform="translate(22 50)"><rect width="180" height="80" rx="14"/><text x="90" y="32">Scout session</text><text class="sub" x="90" y="51">HTML report</text><text class="sub" x="90" y="67">+ explicit artifacts</text></g>
    <g class="node manager" transform="translate(250 40)"><rect width="190" height="100" rx="14"/><text x="95" y="34">ScoutArchiveManager</text><text class="sub" x="95" y="57">capture · contain · hash</text><text class="sub" x="95" y="75">publish before task terminal</text></g>
    <g class="node bundle" transform="translate(492 40)"><rect width="190" height="100" rx="14"/><text x="95" y="32">Portable library</text><text class="sub" x="95" y="54">producer / archive</text><text class="sub" x="95" y="72">self-describing bundles</text></g>
    <g class="node reconcile" transform="translate(740 40)"><rect width="190" height="100" rx="14"/><text x="95" y="34">Reconciler</text><text class="sub" x="95" y="57">bootstrap · watch · cadence</text><text class="sub" x="95" y="75">new and changed only</text></g>
    <g class="node db" transform="translate(988 50)"><rect width="190" height="80" rx="14"/><text x="95" y="32">SQLite index</text><text class="sub" x="95" y="54">disposable search cache</text></g>
    <g class="node done" transform="translate(250 214)"><rect width="190" height="80" rx="14"/><text x="95" y="32">TaskManager</text><text class="sub" x="95" y="54">complete after bundle verify</text></g>
    <g class="node copy" transform="translate(492 214)"><rect width="190" height="80" rx="14"/><text x="95" y="32">Filesystem copy / sync</text><text class="sub" x="95" y="54">other users · any local tool</text></g>
    <g class="node ui" transform="translate(22 322)"><rect width="180" height="80" rx="14"/><text x="90" y="32">Scouts page</text><text class="sub" x="90" y="54">search · report · evidence</text></g>
    <g class="node api" transform="translate(740 322)"><rect width="190" height="80" rx="14"/><text x="95" y="32">Daemon HTTP</text><text class="sub" x="95" y="54">bounded list and detail</text></g>
    <text class="label" x="226" y="78">submit</text><text class="label" x="466" y="78">atomic publish</text><text class="label" x="711" y="78">discover</text><text class="label" x="960" y="78">upsert</text>
    <text class="label" x="605" y="350">query</text><text class="label" x="706" y="213">contained reads</text>
  </svg>
  <p>Completed bundles remain usable without their source task, session, or database row. SQLite accelerates discovery and search but never owns the evidence.</p>
</figure>`;

const publicationFlow = `
<figure class="flow publication" aria-labelledby="publication-flow-title">
  <figcaption id="publication-flow-title">Filesystem-first publication before task completion</figcaption>
  <svg viewBox="0 0 1180 275" role="img" aria-label="The manager reserves a stable operation key, writes a staging bundle, verifies the manifest and digests, atomically publishes the bundle, and then permits task completion. Publication also notifies the background reconciler, which can retry disposable indexing independently. Verification failures preserve the task and resources for a safe retry.">
    <defs>
      <marker id="publish-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <g class="edges">
      <path d="M180 91H218"/><path d="M368 91H406"/><path d="M556 91H594"/><path d="M744 91H790"/>
      <path d="M669 130V181"/><path d="M820 214H866"/><path class="failure" d="M481 131V224H270"/>
    </g>
    <g class="node" transform="translate(30 52)"><rect width="150" height="78" rx="13"/><text x="75" y="31">Reserve</text><text class="sub" x="75" y="53">operation key</text></g>
    <g class="node" transform="translate(218 52)"><rect width="150" height="78" rx="13"/><text x="75" y="31">Stage</text><text class="sub" x="75" y="53">write bundle</text></g>
    <g class="node verify" transform="translate(406 52)"><rect width="150" height="78" rx="13"/><text x="75" y="31">Verify</text><text class="sub" x="75" y="53">manifest · digests</text></g>
    <g class="node bundle" transform="translate(594 52)"><rect width="150" height="78" rx="13"/><text x="75" y="31">Publish</text><text class="sub" x="75" y="53">atomic rename</text></g>
    <g class="node done" transform="translate(790 52)"><rect width="170" height="78" rx="13"/><text x="85" y="31">Complete</text><text class="sub" x="85" y="53">task may close</text></g>
    <g class="node reconcile" transform="translate(594 181)"><rect width="226" height="65" rx="13"/><text x="113" y="27">Notify reconciler</text><text class="sub" x="113" y="47">index may retry independently</text></g>
    <g class="node db" transform="translate(866 181)"><rect width="222" height="65" rx="13"/><text x="111" y="27">Upsert search cache</text><text class="sub" x="111" y="47">derived from final bundle</text></g>
    <g class="node retry" transform="translate(55 194)"><rect width="215" height="65" rx="13"/><text x="108" y="27">Retry safely</text><text class="sub" x="108" y="47">keep task and resources</text></g>
  </svg>
  <p>Task completion depends on a verified final bundle, not on a cache row. Search indexing can retry without risking the scout evidence.</p>
</figure>`;

const reconciliationFlow = `
<figure class="flow reconciliation" aria-labelledby="reconciliation-flow-title">
  <figcaption id="reconciliation-flow-title">Incremental background reconciliation</figcaption>
  <svg viewBox="0 0 1200 290" role="img" aria-label="Bootstrap, filesystem hints, and a recurring cadence trigger manifest discovery. Cached fingerprints let unchanged bundles skip indexing. New or changed bundles settle, validate, and upsert. Missing indexed paths are removed, and a changed batch emits one browser invalidation event.">
    <defs>
      <marker id="reconcile-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <g class="edges">
      <path d="M186 86H222"/><path d="M382 86H418"/><path d="M578 86H614"/><path d="M774 86H810"/><path d="M970 86H1006"/>
      <path d="M498 126V191"/><path d="M302 126V191"/><path d="M1086 126V202"/><path d="M382 224H1006"/>
    </g>
    <g class="node" transform="translate(22 46)"><rect width="164" height="80" rx="13"/><text x="82" y="30">Trigger</text><text class="sub" x="82" y="51">bootstrap · watch</text><text class="sub" x="82" y="67">60-second cadence</text></g>
    <g class="node" transform="translate(222 46)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Discover</text><text class="sub" x="80" y="53">manifest paths</text></g>
    <g class="node verify" transform="translate(418 46)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Compare</text><text class="sub" x="80" y="53">cached fingerprint</text></g>
    <g class="node" transform="translate(614 46)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Settle</text><text class="sub" x="80" y="53">stable copied bundle</text></g>
    <g class="node" transform="translate(810 46)"><rect width="160" height="80" rx="13"/><text x="80" y="31">Validate</text><text class="sub" x="80" y="53">schema · paths · digests</text></g>
    <g class="node db" transform="translate(1006 46)"><rect width="170" height="80" rx="13"/><text x="85" y="31">Upsert</text><text class="sub" x="85" y="53">derived search rows</text></g>
    <g class="node skip" transform="translate(418 191)"><rect width="160" height="65" rx="13"/><text x="80" y="27">Skip</text><text class="sub" x="80" y="47">unchanged bodies</text></g>
    <g class="node retry" transform="translate(222 191)"><rect width="160" height="65" rx="13"/><text x="80" y="27">Remove stale</text><text class="sub" x="80" y="47">missing cache path</text></g>
    <g class="node done" transform="translate(1006 202)"><rect width="170" height="65" rx="13"/><text x="85" y="27">Notify UI</text><text class="sub" x="85" y="47">one event per batch</text></g>
    <text class="label" x="596" y="73">new / changed</text><text class="label" x="525" y="163">unchanged</text><text class="label" x="330" y="163">missing</text>
  </svg>
  <p>A normal startup reads directory and manifest fingerprints but reparses only changed content. With an empty database, the same loop reconstructs the index automatically.</p>
</figure>`;

const phasedFlow = `
<figure class="flow phases" aria-labelledby="phased-flow-title">
  <figcaption id="phased-flow-title">Merge-aware implementation and value flow</figcaption>
  <svg viewBox="0 0 1200 390" role="img" aria-label="The planning pull request releases Phase 1, the portable library and disposable index. Phase 1 releases Phase 2, required scout capture and completion. Phase 2 releases Phase 3, the Scouts history interface. Each phase leaves an independently operable result.">
    <defs>
      <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>
    </defs>
    <g class="edges">
      <path d="M204 105H260"/><path d="M504 105H560"/><path d="M804 105H860"/>
      <path d="M382 150V248"/><path d="M682 150V248"/><path d="M982 150V248"/>
    </g>
    <g class="node" transform="translate(24 65)"><rect width="180" height="80" rx="14"/><text x="90" y="31">Planning PR</text><text class="sub" x="90" y="53">approved contracts merge</text></g>
    <g class="node manager" transform="translate(260 55)"><rect width="244" height="100" rx="14"/><text x="122" y="32">Phase 1</text><text class="sub" x="122" y="54">portable library</text><text class="sub" x="122" y="72">+ disposable index</text></g>
    <g class="node verify" transform="translate(560 55)"><rect width="244" height="100" rx="14"/><text x="122" y="32">Phase 2</text><text class="sub" x="122" y="54">required capture</text><text class="sub" x="122" y="72">+ ordered completion</text></g>
    <g class="node bundle" transform="translate(860 55)"><rect width="244" height="100" rx="14"/><text x="122" y="32">Phase 3</text><text class="sub" x="122" y="54">Scouts history</text><text class="sub" x="122" y="72">+ report reader</text></g>
    <g class="node" transform="translate(260 248)"><rect width="244" height="82" rx="14"/><text x="122" y="30">Foreign bundles work</text><text class="sub" x="122" y="53">API discovery and rebuild</text></g>
    <g class="node" transform="translate(560 248)"><rect width="244" height="82" rx="14"/><text x="122" y="30">New scouts persist</text><text class="sub" x="122" y="53">HTML before cleanup</text></g>
    <g class="node done" transform="translate(860 248)"><rect width="244" height="82" rx="14"/><text x="122" y="30">Operators recover answers</text><text class="sub" x="122" y="53">search · read · delete</text></g>
    <text class="label" x="231" y="92">publishes paths</text><text class="label" x="532" y="92">consumes C1-C5</text><text class="label" x="832" y="92">consumes C1-C9</text>
  </svg>
  <p>The graph is serial because each phase consumes durable contracts from its direct prerequisite. Every merge still leaves a usable, testable repository.</p>
</figure>`;

const diagrams = isPhased
  ? [phasedFlow]
  : [deletionFlow, dataFlow, publicationFlow, reconciliationFlow];
const mermaidBlock = /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/g;
const mermaidBlocks = body.match(mermaidBlock) ?? [];
if (mermaidBlocks.length !== diagrams.length) {
  throw new Error(
    `${sourceName} contains ${mermaidBlocks.length} Mermaid blocks, but the renderer defines ` +
      `${diagrams.length} inline SVG diagrams`,
  );
}
let diagramIndex = 0;
body = body.replace(
  mermaidBlock,
  () => diagrams[diagramIndex++],
);

const toc = isPhased
  ? [
      ["Decisions", "incorporated-human-decisions"],
      ["Repository findings", "repository-findings-that-changed-the-route"],
      ["Phase map", "phase-map"],
      ["Dependency flow", "dependency-and-delivery-flow"],
      ["Contracts", "cross-phase-contracts"],
      ["Merge strategy", "merge-order-and-compatibility-strategy"],
      ["Verification", "final-verification-strategy"],
      ["Audit", "complete-cross-phase-audit"],
    ]
  : [
      ["Outcome", "outcome"],
      ["Current state", "what-the-repository-does-today"],
      ["Recommendation", "recommendation"],
      ["User experience", "user-experience"],
      ["Capture contract", "capture-contract"],
      ["Data flow", "data-and-request-flow"],
      ["Persistence", "persistence-and-lifecycle"],
      ["HTTP and SSE", "http-and-live-synchronization"],
      ["Repository map", "repository-changes"],
      ["Security", "security-and-privacy"],
      ["Verification", "verification"],
      ["Acceptance", "acceptance-criteria"],
      ["Approved decisions", "approved-decisions"],
    ];

const page = isPhased
  ? {
      title: "Durable scout archive phased plan",
      kicker: "Mission Control · merge-aware implementation plan",
      heading: "Build the scout archive in three safe merges",
      copy: "Establish the portable library first, make every scout publish a verified HTML artifact second, then add the permanent search and review experience.",
      tabs: ["Portable library", "Required capture", "Scouts UI"],
      path: "Phase 1 → Phase 2 → Phase 3",
    }
  : {
      title: "Durable scout archive plan",
      kicker: "Mission Control · product and engineering plan",
      heading: "Durable scout archive",
      copy: "Keep each investigation useful after its session and worktree close, share immutable bundles through ordinary filesystem tools, and rebuild search from the portable library whenever needed.",
      tabs: ["HTML report", "Support files", "Manifest"],
      path: "~/.mission-control/scouts/<producer-id>/<archive-id>/",
    };

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${page.title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg:#f2f4f7;--paper:#fff;--paper2:#f7f8fa;--ink:#1c232d;--muted:#626d7c;
      --dim:#7b8593;--line:#dce1e7;--line2:#e9edf1;--blue:#2c73c8;--green:#16815d;
      --amber:#a66508;--red:#bd3933;--purple:#7252b9;--code:#eef2f6;
      --shadow:0 18px 54px rgba(28,35,45,.10);
      --sans:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
    }
    @media (prefers-color-scheme:dark) {
      :root {
        --bg:#0a0c0f;--paper:#14181e;--paper2:#0f1318;--ink:#e7ebf1;--muted:#939eae;
        --dim:#7c8798;--line:#29313b;--line2:#202730;--blue:#4a9eff;--green:#35c08a;
        --amber:#f6a733;--red:#f85149;--purple:#a371f7;--code:#1a2028;
        --shadow:0 20px 58px rgba(0,0,0,.38);
      }
    }
    *{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg)}
    body{margin:0;min-width:0;background:radial-gradient(900px 520px at 88% -12%,color-mix(in srgb,var(--blue) 11%,transparent),transparent 62%),var(--bg);color:var(--ink);font:15px/1.68 var(--sans)}
    a{color:var(--blue);text-underline-offset:3px}a:hover{color:color-mix(in srgb,var(--blue) 75%,var(--ink))}
    .mast{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 90%,transparent);backdrop-filter:blur(16px)}
    .mast-inner{max-width:1380px;margin:auto;padding:42px clamp(20px,5vw,66px) 35px}
    .kicker{margin:0 0 8px;color:var(--blue);font:800 11px/1.2 var(--mono);letter-spacing:.15em;text-transform:uppercase}
    .mast h1{max-width:850px;margin:0;font-size:clamp(35px,5.5vw,64px);line-height:1.06;letter-spacing:-.045em}
    .mast-copy{max-width:850px;margin:16px 0 0;color:var(--muted);font-size:17px}
    .evidence-tabs{display:flex;flex-wrap:wrap;gap:0;margin-top:24px}
    .evidence-tabs span{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--line);background:var(--paper2);color:var(--muted);font:700 11px/1 var(--mono)}
    .evidence-tabs span:first-child{border-radius:9px 0 0 9px}.evidence-tabs span:last-child{border-radius:0 9px 9px 0}.evidence-tabs span+span{border-left:0}
    .evidence-tabs i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 14%,transparent)}
    .path{margin-top:16px;color:var(--dim);font:12px/1.5 var(--mono)}
    .layout{display:grid;grid-template-columns:220px minmax(0,930px);gap:34px;max-width:1240px;margin:0 auto;padding:30px 18px 92px}
    nav{position:sticky;top:18px;align-self:start;max-height:calc(100vh - 36px);overflow:auto;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--paper);box-shadow:var(--shadow)}
    nav b{display:block;margin:0 0 9px;color:var(--dim);font:800 10px/1.2 var(--mono);letter-spacing:.12em;text-transform:uppercase}
    nav a{display:block;padding:6px 8px;border-radius:7px;color:var(--muted);text-decoration:none;font-size:12px}nav a:hover{color:var(--ink);background:var(--paper2)}
    article{min-width:0;padding:10px clamp(18px,4vw,54px) 60px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:var(--shadow)}
    article>h1:first-child{display:none}h2{margin:48px 0 13px;padding-top:7px;border-top:1px solid var(--line);font-size:25px;line-height:1.25;letter-spacing:-.025em}h2:first-of-type{margin-top:22px;border-top:0}
    h3{margin:30px 0 9px;font-size:18px;line-height:1.35;letter-spacing:-.012em}h4{margin:22px 0 7px}
    p{margin:8px 0 14px}ul,ol{padding-left:24px}li{margin:5px 0}strong{color:var(--ink)}
    code{padding:2px 5px;border:1px solid var(--line2);border-radius:5px;background:var(--code);color:var(--blue);font:12.5px/1.45 var(--mono);overflow-wrap:anywhere}
    pre{max-width:100%;overflow:auto;margin:17px 0;padding:15px 17px;border:1px solid var(--line);border-radius:11px;background:var(--paper2)}pre code{padding:0;border:0;background:none;color:var(--ink);white-space:pre}
    table{display:block;width:100%;max-width:100%;overflow-x:auto;margin:18px 0;border-collapse:collapse;font-size:13px}th,td{padding:9px 11px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--paper2);font-size:11px}
    blockquote{margin:18px 0;padding:10px 16px;border-left:3px solid var(--blue);background:color-mix(in srgb,var(--blue) 6%,var(--paper));color:var(--muted)}
    #approved-decisions{margin-top:56px;padding:22px 24px;border:1px solid color-mix(in srgb,var(--green) 48%,var(--line));border-radius:14px;background:color-mix(in srgb,var(--green) 6%,var(--paper));color:var(--ink)}
    .flow{max-width:100%;margin:22px 0;padding:16px;overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--paper2)}
    .flow figcaption{margin-bottom:13px;font-weight:760}.flow svg{display:block;width:100%;height:auto;min-width:760px}.flow p{margin:12px 3px 1px;color:var(--muted);font-size:12px}
    .flow .edges path{fill:none;stroke:var(--dim);stroke-width:1.7;marker-end:url(#flow-arrow)}.deletion .edges path{marker-end:url(#delete-arrow)}.publication .edges path{marker-end:url(#publish-arrow)}.reconciliation .edges path{marker-end:url(#reconcile-arrow)}.deletion .edges .failure,.publication .edges .failure{stroke:var(--red)}
    .flow .node rect{fill:var(--paper);stroke:var(--line);stroke-width:1.5}.flow .node.manager rect{fill:color-mix(in srgb,var(--blue) 10%,var(--paper));stroke:var(--blue)}
    .flow .node.bundle rect,.flow .node.done rect{fill:color-mix(in srgb,var(--green) 8%,var(--paper));stroke:var(--green)}.flow .node.db rect{stroke:var(--purple)}.flow .node.verify rect{stroke:var(--amber)}.flow .node.retry rect{stroke:var(--red);stroke-dasharray:5 4}
    .flow text{fill:var(--ink);font:650 13px var(--sans);text-anchor:middle}.flow text.sub{fill:var(--muted);font-size:10px;font-weight:480}.flow text.label{fill:var(--dim);font:500 9px var(--mono)}
    footer{display:flex;justify-content:space-between;gap:20px;max-width:1240px;margin:0 auto 36px;padding:0 18px;color:var(--dim);font:11px/1.5 var(--mono)}
    @media(max-width:880px){.layout{grid-template-columns:1fr}.layout nav{position:static;display:flex;gap:4px;max-height:none;overflow-x:auto}.layout nav b{display:none}.layout nav a{white-space:nowrap}article{padding-inline:20px}}
    @media(max-width:560px){.mast-inner{padding-top:30px}.evidence-tabs span{flex:1;justify-content:center}.layout{padding-inline:8px}article{border-radius:13px}.path{overflow-wrap:anywhere}th,td{min-width:130px}th:first-child,td:first-child{min-width:44px}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
    @media print{body{background:#fff}.mast,article,nav{box-shadow:none}.layout{display:block;max-width:none}.layout nav{display:none}article{border:0}.flow svg{min-width:0}footer{display:none}}
  </style>
</head>
<body>
  <header class="mast">
    <div class="mast-inner">
      <p class="kicker">${page.kicker}</p>
      <h1>${page.heading}</h1>
      <p class="mast-copy">${page.copy}</p>
      <div class="evidence-tabs" aria-label="${isPhased ? "Implementation phases" : "Archive contents"}">${page.tabs.map((label) => `<span><i></i>${label}</span>`).join("")}</div>
      <p class="path">${page.path.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>
    </div>
  </header>
  <div class="layout">
    <nav aria-label="Plan sections"><b>On this page</b>${toc.map(([label, id]) => `<a href="#${id}">${label}</a>`).join("")}</nav>
    <article>${body}</article>
  </div>
  <footer><span>Source of truth: ${sourceName}</span><span>Offline render · no external requests</span></footer>
</body>
</html>`;

writeFileSync(outputPath, html);
