import { useEffect, useRef, useState } from "react";
import { managedPlanPreview, type ManagedPlanRevision } from "@shared/managed-plans.ts";
import { HTML_PREVIEW_LINK_MESSAGE, HTML_PREVIEW_SANDBOX, htmlPreviewSource, inlinePreviewStyles } from "../lib/htmlPreview.ts";
import { Markdown } from "./Markdown.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** Same sandbox as Files and Archives, with exact bundle membership for navigation. */
export function ManagedPlanReader({ id, revision }: { id: string; revision: number }): React.JSX.Element {
  const [plan, setPlan] = useState<ManagedPlanRevision | null>(null);
  const [file, setFile] = useState("plan.html");
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const base = `/api/plans/${encodeURIComponent(id)}/${revision}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(base, { signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setPlan(body);
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [base]);
  useEffect(() => {
    if (!plan) return;
    const controller = new AbortController();
    setText(null); setError(null);
    const read = async (name: string): Promise<string> => {
      const response = await fetch(`${base}/files/${encodeURIComponent(name)}`, { signal: controller.signal });
      if (!response.ok) throw new Error((await response.json()).error);
      return response.text();
    };
    void read(file).then(async (body) => {
      if (file.endsWith(".html")) {
        body = await inlinePreviewStyles(body, file, async (name) => plan.manifest.files.some((f) => f.name === name) ? read(name) : null);
      }
      if (!controller.signal.aborted) setText(body);
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [base, file, plan]);
  useEffect(() => {
    const follow = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== HTML_PREVIEW_LINK_MESSAGE || typeof event.data.href !== "string") return;
      const href = event.data.href as string;
      if (/^[a-z]+:|^\/\//i.test(href) || href.startsWith("#")) return;
      const name = new URL(href, "https://plan.invalid/").pathname.slice(1);
      if (plan?.manifest.files.some((f) => f.name === name)) setFile(name);
    };
    window.addEventListener("message", follow);
    return () => window.removeEventListener("message", follow);
  }, [plan]);
  const source = plan?.manifest.files.find((f) => f.name === file)?.source;
  return <main className="managed-plan-reader">
    <header>
      <Tooltip label="Return to the Mission Control dashboard"><a href="/">Mission Control</a></Tooltip>
      <h1>{plan?.manifest.slug ?? "Managed plan"}</h1>
      <p>Revision {revision} · {plan?.manifest.policy.commitPlanHtml ? "Markdown and HTML included in Git" : "Markdown in Git; HTML retained locally"}</p>
      {plan && revision > 1 && <nav aria-label="Plan revision history"><Tooltip label={`Open the retained plan at revision ${revision - 1}`}><a href={managedPlanPreview(id, revision - 1)}>Previous revision</a></Tooltip></nav>}
      <p>Saved for review. Publication still requires the planning pull request to merge.</p>
      {source && <p>Rendering of <Tooltip label="Read the source Markdown saved with this rendering"><button className="btn" onClick={() => setFile(source)}>{source}</button></Tooltip> at this exact revision.</p>}
      <nav aria-label="Plan revision files">{plan?.manifest.files.map((entry) => <Tooltip key={entry.name} label={`Read ${entry.name} from revision ${revision}`}><button className="btn" aria-current={file === entry.name ? "page" : undefined} onClick={() => setFile(entry.name)}>{entry.name}</button></Tooltip>)}</nav>
    </header>
    {error && <p role="alert">{error}</p>}
    {text !== null && !error && (file.endsWith(".html") ? <iframe ref={frame} title={`Plan preview: ${file}`} sandbox={HTML_PREVIEW_SANDBOX} srcDoc={htmlPreviewSource(text)} /> : file.endsWith(".md") ? <article className="markdown" onClick={(event) => {
      const href = (event.target as Element).closest("a")?.getAttribute("href");
      if (!href || /^[a-z]+:|^\/\//i.test(href) || href.startsWith("#")) return;
      const name = new URL(href, "https://plan.invalid/").pathname.slice(1);
      if (plan?.manifest.files.some((f) => f.name === name)) { event.preventDefault(); setFile(name); }
    }}><Markdown>{text}</Markdown></article> : <pre>{text}</pre>)}
  </main>;
}

/** Explicit refresh avoids a new browser poll or another session-file namespace. */
export function ManagedPlanLinks({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [plans, setPlans] = useState<ManagedPlanRevision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plans`, { signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setPlans(body); setError(null);
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [sessionId, refresh]);
  return <section aria-label="Managed plans">
    <Tooltip label="Load the latest saved plan revisions for this session's repositories"><button className="btn" onClick={() => setRefresh((n) => n + 1)}>Refresh managed plans</button></Tooltip>
    {error && <p role="alert">{error}</p>}
    {plans.map((plan) => <p key={plan.manifest.planId}><Tooltip label="Open this exact saved plan revision in a new tab"><a href={plan.preview} target="_blank" rel="noreferrer">{plan.manifest.slug} · revision {plan.manifest.revision}</a></Tooltip></p>)}
  </section>;
}
