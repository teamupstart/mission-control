import { readFileSync, writeFileSync } from 'node:fs';
import { dashboardSpecs, allPanels, makeDashboard, recordingRules } from './dashboards.ts';
const outputs = new Map<string, string>();
for (const spec of dashboardSpecs) outputs.set(`observability/grafana/dashboards/${spec.uid}.json`, JSON.stringify(makeDashboard(spec), null, 2) + '\n');
// JSON is valid YAML; no additional YAML serializer or build dependency is needed.
outputs.set('observability/prometheus/cohorts.yml', JSON.stringify(recordingRules(), null, 2) + '\n');
outputs.set('observability/grafana/panel-manifest.json', JSON.stringify(dashboardSpecs.map((s) => ({
  uid: s.uid, question: s.title, panels: allPanels(s).map((p, i) => ({ id: i + 2, ...p,
    filters: ['environment', 'installation', ...(p.filter && ['runs', 'reviews', 'tasks'].includes(p.filter) ? [`${p.filter}_axis`, `${p.filter}_slice`] : [])],
    test: 'test/telemetry-dashboards-stack.integration.ts and e2e/specs/telemetry-dashboards.spec.ts' })),
  tracePanel: { id: 900, query: makeDashboard(s).panels.at(-1)!.targets, sources: ['mission.* spans'], filters: ['environment', 'installation', 'time'], test: 'e2e/specs/telemetry-dashboards.spec.ts' },
})), null, 2) + '\n');
for (const [path, contents] of outputs) {
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== contents) throw new Error(`Regenerate ${path}: npm run observability:generate`);
  } else writeFileSync(path, contents);
}
console.log(`${outputs.size} dashboard, manifest and rule artifacts ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
