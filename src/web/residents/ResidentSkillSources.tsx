import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { RESIDENT_AGENTS } from "@shared/residents.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { useEffect, useState } from "react";
import type { ResidentSkillIndex, ResidentSkillSources } from "@shared/resident-skills.ts";
import { fetchResidentSkills, rescanResidentSkills, saveResidentSkillSources } from "./api.ts";

/** A fetched catalog: rescanning is an explicit action, never a browser polling loop. */
export function ResidentSkillSourcesPanel(): React.JSX.Element {
  const [index, setIndex] = useState<ResidentSkillIndex | null>(null);
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetchResidentSkills().then((value) => { if (live) setIndex(value); }).catch((err: unknown) => {
      if (live) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { live = false; };
  }, []);
  const apply = async (operation: () => Promise<ResidentSkillIndex>, added = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try { setIndex(await operation()); if (added) setPath(""); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const save = (config: ResidentSkillSources, added = false): void => {
    void apply(() => saveResidentSkillSources(config), added);
  };
  const unavailable = RESIDENT_AGENTS.filter((agent) => capabilitiesFor(agent).skillSelection === null)
    .map((agent) => AGENT_IDENTITY[agent].label).join(" and ");
  const needle = query.toLocaleLowerCase();
  const skills = index?.skills.filter((skill) => (!sourceId || skill.sourceId === sourceId)
    && `${skill.name} ${skill.description} ${skill.folder}`.toLocaleLowerCase().includes(needle)) ?? [];
  return (
    <section className="resident-editor resident-sources" aria-label="Skill sources">
      <header className="resident-editor-head">
        <div>
          <p className="workflow-eyebrow">Resident resources</p>
          <h3>Skill sources</h3>
          <p className="resident-editor-meta">{index ? `${index.skills.length} indexed skills across ${index.sources.length} sources` : "Loading skill sources…"}</p>
        </div>
        <button className="btn" disabled={busy || !index} onClick={() => { void apply(rescanResidentSkills); }}>Rescan</button>
      </header>
      <p className="resident-section-blurb">Browse the skills on this machine. Register a folder containing skill folders, each with a SKILL.md file.</p>
      {unavailable && <p className="resident-skill-notice">Resident skill selection is unavailable for {unavailable} until a launch control can keep the exact skill set frozen across resumes.</p>}
      {error && <p role="alert" className="resident-error">{error}</p>}
      <form className="resident-source-add" onSubmit={(event) => {
        event.preventDefault();
        if (index && path.trim() && !busy) save({ directories: [...index.config.directories, { id: `custom-${crypto.randomUUID()}`, path }] }, true);
      }}>
        <label className="field">
          <span className="field-label">Skill folder</span>
          <input className="field-input" value={path} disabled={busy || !index} onChange={(event) => setPath(event.target.value)} placeholder="~/my-skills" />
        </label>
        <button type="submit" className="btn" disabled={busy || !index || !path.trim()}>Add source</button>
      </form>
      <ul className="resident-source-list" aria-label="Registered skill sources">
        {index?.sources.map((source) => (
          <li key={source.id}>
            <div className="resident-source-heading">
              <strong>{source.label}</strong>
              <span className="resident-editor-meta">{index.skills.filter((skill) => skill.sourceId === source.id).length} skills</span>
              {source.custom && <button className="btn btn-quiet" disabled={busy} aria-label={`Remove source ${source.label}`} onClick={() => {
                save({ directories: index.config.directories.filter((row) => row.id !== source.id) });
                if (sourceId === source.id) setSourceId("");
              }}>Remove</button>}
            </div>
            {source.path && <code>{source.path}</code>}
            {source.problems.length > 0 && <details>
              <summary>{source.problems.length} {source.problems.length === 1 ? "problem" : "problems"}</summary>
              <ul>{source.problems.map((problem, i) => <li key={i}>{problem}</li>)}</ul>
            </details>}
          </li>
        ))}
      </ul>
      <div className="resident-skill-filters">
        <label className="field"><span className="field-label">Search skills</span><input className="field-input" value={query} onChange={(event) => setQuery(event.target.value)} type="search" /></label>
        <label className="field"><span className="field-label">Source</span><select className="field-input" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
          <option value="">All sources</option>
          {index?.sources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
        </select></label>
      </div>
      <p className="resident-editor-meta" role="status">{skills.length} matching skills</p>
      <ul className="resident-skill-list" aria-label="Indexed skills">
        {skills.slice(0, 200).map((skill) => <li key={skill.id}>
          <strong>{skill.name}</strong><p>{skill.description}</p><code>{skill.id}</code>
        </li>)}
      </ul>
      {skills.length > 200 && <p className="resident-section-blurb">Showing the first 200 matches. Narrow the search to see more.</p>}
    </section>
  );
}
