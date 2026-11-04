/**
 * Real-harness investigation of wider resident skill isolation controls.
 * Uses disposable homes and loopback mock model providers. Never spends model tokens.
 * Success confirms the documented counterexamples, NOT a supported capability.
 * Run: node --import tsx scripts/probe-resident-skills-wider.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { initializeExecutableEnvironment, locateExecutable } from "../src/server/executables/locator.ts";
import { AppServerClient } from "../src/server/harness/codex/app-server/client.ts";
import { spawnAppServer } from "../src/server/harness/codex/sdk-deps.ts";
await initializeExecutableEnvironment();
const claude = await locateExecutable("claude");
const codex = await locateExecutable("codex");
if (!claude || !codex)
    throw new Error("Both real harness installations are required.");
const binaries = { claude: claude.path, codex: codex.path };
const versionHome = mkdtempSync(join(tmpdir(), "mc-skill-versions-"));
try {
    mkdirSync(join(versionHome, ".codex"));
    for (const [harness, executable] of Object.entries(binaries)) {
        const env = { PATH: process.env.PATH, HOME: versionHome, CODEX_HOME: join(versionHome, ".codex"), CLAUDE_CONFIG_DIR: join(versionHome, ".claude") };
        console.log(JSON.stringify({ harness, version: execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10000, env }).trim(), executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex") }));
    }
} finally {
    rmSync(versionHome, { recursive: true, force: true });
}
async function probeClaudeFilters(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'mc-wider-probe-'));
    const home = join(root, 'home'), cwd = join(root, 'repo'), plugin = join(root, 'plugin');
    for (const p of [home, cwd, join(plugin, '.claude-plugin')])
        mkdirSync(p, { recursive: true });
    function skill(path: string, name: string, body: string) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: PROBE_DESCRIPTION_${name}\n---\n${body}\n`); }
    skill(join(home, '.claude/skills/native-user'), 'native-user', 'NATIVE_USER_CONTENT');
    skill(join(cwd, '.claude/skills/native-project'), 'native-project', 'NATIVE_PROJECT_CONTENT');
    skill(join(plugin, 'skills/snapshot-selected'), 'snapshot-selected', 'FROZEN_SNAPSHOT_CONTENT');
    writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'frozen' }));
    const nativePlugin = join(root, 'native-plugin');
    mkdirSync(join(nativePlugin, '.claude-plugin'), { recursive: true });
    skill(join(nativePlugin, 'skills/native-plugin'), 'native-plugin', 'NATIVE_PLUGIN_CONTENT');
    writeFileSync(join(nativePlugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'native', commands: { inline: { content: 'NATIVE_INLINE_COMMAND_CONTENT', description: 'Native inline command fixture' } } }));
    writeFileSync(join(cwd, 'CLAUDE.md'), 'REPOSITORY_INSTRUCTIONS_SENTINEL');
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { PHASE4_NON_SKILL_SENTINEL: 'retained' } }));
    let bodies: any[] = [];
    let desired = '';
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const c of req)
            raw += c;
        const body = JSON.parse(raw || '{}');
        if (req.url?.includes('count_tokens')) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ input_tokens: 20 }));
            return;
        }
        bodies.push(body);
        const tool = bodies.length === 1 && desired;
        const content = tool ? { type: 'tool_use', id: 'probe-call', name: 'Skill', input: { skill: desired } } : { type: 'text', text: 'LOCAL_PROBE_DONE' };
        const msg = { id: 'msg-probe', type: 'message', role: 'assistant', model: body.model, content: [content], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 5 } };
        if (!body.stream) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(msg));
            return;
        }
        res.setHeader('content-type', 'text/event-stream');
        const emit = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        emit('message_start', { message: { ...msg, content: [], stop_reason: null } });
        emit('content_block_start', { index: 0, content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' } });
        emit('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } });
        emit('content_block_stop', { index: 0 });
        emit('message_delta', { delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
        emit('message_stop', {});
        res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'local-fixture-only', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
    try {
        for (const [label, extra, target, prompt] of [
            ['sdk-allowlist-selected', { skills: ['frozen:snapshot-selected'] }, 'frozen:snapshot-selected', 'Run the local probe.'],
            ['sdk-allowlist-native', { skills: ['frozen:snapshot-selected'] }, 'native-project', 'Run the local probe.'],
            ['sdk-allowlist-slash', { skills: ['frozen:snapshot-selected'] }, '', '/native-project'],
            ['managed-plugin-only', { managedSettings: { strictPluginOnlyCustomization: ['skills'] }, settings: { disableBundledSkills: true } }, 'frozen:snapshot-selected', 'Run the local probe.'],
            ['managed-with-native-plugin', { managedSettings: { strictPluginOnlyCustomization: ['skills'] }, settings: { disableBundledSkills: true }, plugins: [{ type: 'local', path: plugin }, { type: 'local', path: nativePlugin }] }, 'native:native-plugin', 'Run the local probe.'],
            ['managed-allowlist-inline', { managedSettings: { strictPluginOnlyCustomization: ['skills'] }, settings: { disableBundledSkills: true }, skills: ['frozen:snapshot-selected'], plugins: [{ type: 'local', path: plugin }, { type: 'local', path: nativePlugin }] }, '', '/native:inline'],
            ['wildcard-skill-overrides', { settings: { disableBundledSkills: true, skillOverrides: { '*': 'off', 'frozen:snapshot-selected': 'on' } }, plugins: [{ type: 'local', path: plugin }, { type: 'local', path: nativePlugin }] }, '', '/native:inline'],
            ['plugin-permission-deny', { settings: { disableBundledSkills: true, permissions: { deny: ['Skill(native:*)'] } }, plugins: [{ type: 'local', path: plugin }, { type: 'local', path: nativePlugin }] }, '', '/native:inline'],
        ] as const) {
            bodies = [];
            desired = target;
            const handle = query({ prompt, options: { cwd, env, pathToClaudeCodeExecutable: binaries.claude, settingSources: ['user', 'project', 'local'], plugins: [{ type: 'local', path: plugin }], maxTurns: 4, model: 'sonnet', ...extra } as any });
            const timer = setTimeout(() => handle.close(), 45000);
            const messages: any[] = [];
            try {
                const commands = (await handle.supportedCommands()).map(c => c.name);
                for await (const m of handle)
                    messages.push(m);
                const text = JSON.stringify(bodies);
                assert.equal(messages.findLast(m => m.type === 'result')?.subtype, 'success', label);
                const expectedNative = label === 'sdk-allowlist-slash';
                const expectedPlugin = label === 'managed-with-native-plugin';
                const expectedInline = ['managed-allowlist-inline', 'wildcard-skill-overrides', 'plugin-permission-deny'].includes(label);
                assert.equal(text.includes('NATIVE_PROJECT_CONTENT'), expectedNative, label);
                assert.equal(text.includes('NATIVE_PLUGIN_CONTENT'), expectedPlugin, label);
                assert.equal(text.includes('NATIVE_INLINE_COMMAND_CONTENT'), expectedInline, label);
                assert.equal(text.includes('FROZEN_SNAPSHOT_CONTENT'), ['sdk-allowlist-selected', 'managed-plugin-only'].includes(label), label);
                assert.ok(text.includes('REPOSITORY_INSTRUCTIONS_SENTINEL'), label);
                console.log(JSON.stringify({ label, commands: commands.filter(n => /native|snapshot/.test(n)), requests: bodies.length, firstNativeDescription: JSON.stringify(bodies[0]).includes('PROBE_DESCRIPTION_native-project'), firstSnapshotDescription: JSON.stringify(bodies[0]).includes('PROBE_DESCRIPTION_snapshot-selected'), nativeContent: text.includes('NATIVE_PROJECT_CONTENT'), nativePluginContent: text.includes('NATIVE_PLUGIN_CONTENT'), nativeInlineContent: text.includes('NATIVE_INLINE_COMMAND_CONTENT'), snapshotContent: text.includes('FROZEN_SNAPSHOT_CONTENT'), repoInstructions: text.includes('REPOSITORY_INSTRUCTIONS_SENTINEL'), result: messages.filter(m => m.type === 'result').map(m => ({ subtype: m.subtype, result: m.result, errors: m.errors })) }));
            }
            finally {
                clearTimeout(timer);
                handle.close();
            }
        }
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
        rmSync(root, { recursive: true, force: true });
    }
}
async function probeCodexFilters(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'mc-codex-wider-'));
    const home = join(root, 'home'), cwd = join(root, 'repo'), overlay = join(root, 'overlay');
    for (const p of [home, cwd, overlay])
        mkdirSync(p, { recursive: true });
    function skill(path: string, name: string, body: string) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: PROBE_DESCRIPTION_${name}\n---\n${body}\n`); }
    skill(join(home, '.agents/skills/native-user'), 'native-user', 'NATIVE_USER_CONTENT');
    skill(join(cwd, '.agents/skills/native-project'), 'native-project', 'NATIVE_PROJECT_CONTENT');
    skill(join(overlay, 'skills/snapshot-selected'), 'snapshot-selected', 'FROZEN_SNAPSHOT_CONTENT');
    const externalSkill = join(root, 'external-selected');
    skill(externalSkill, 'external-selected', 'EXTERNAL_SELECTED_CONTENT');
    writeFileSync(join(cwd, 'AGENTS.md'), 'REPOSITORY_INSTRUCTIONS_SENTINEL');
    const profile = join(root, 'skills.sb'), wrapper = join(root, 'codex-isolated');
    const frozen = realpathSync(join(overlay, 'skills'));
    writeFileSync(profile, `(version 1)\n(allow default)\n(deny file-read-data (require-all (regex #"/SKILL[.]md$") (require-not (subpath ${JSON.stringify(frozen)}))))\n(deny file-write* (subpath ${JSON.stringify(frozen)}))\n`);
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${quote(profile)} ${quote(binaries.codex)} "$@"\n`, { mode: 0o700 });
    let bodies: any[] = [];
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const c of req)
            raw += c;
        if (!raw) {
            res.setHeader('content-type', 'application/json');
            res.end('{}');
            return;
        }
        bodies.push(JSON.parse(raw));
        res.setHeader('content-type', 'text/event-stream');
        const emit = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        const item = { id: 'msg-probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'LOCAL_PROBE_DONE', annotations: [] }] };
        emit('response.created', { response: { id: 'resp-probe', status: 'in_progress', output: [] } });
        emit('response.output_item.done', { output_index: 0, item });
        emit('response.completed', { response: { id: 'resp-probe', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
        res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    const args = ['-c', 'model_provider="local_probe"', '-c', `model_providers.local_probe={name="local_probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`, '-c', 'skills.bundled.enabled=false', '-c', 'features.shell_snapshot=false'];
    try {
        for (const [label, extra, prompt] of [
            ['codex-default', [], 'Run the local probe.'],
            ['codex-no-instructions', ['-c', 'skills.include_instructions=false'], 'Run the local probe.'],
            ['codex-no-instructions-invoked', ['-c', 'skills.include_instructions=false'], '$native-project'],
            ['codex-feature-disabled', ['-c', 'features.skills=false'], 'Run the local probe.'],
            ['codex-seatbelt', [], 'Run the local probe.'],
            ['codex-seatbelt-native', [], '$native-project'],
            ['codex-seatbelt-selected', [], '$snapshot-selected'],
            ['codex-explicit-path', ['-c', `skills.config=[{path=${JSON.stringify(externalSkill)},enabled=true}]`], '$external-selected'],
        ] as const) {
            if (label.startsWith('codex-seatbelt') && process.platform !== 'darwin')
                continue;
            bodies = [];
            const notifications: any[] = [];
            let complete = () => { };
            const done = new Promise<void>(r => complete = r);
            const client = new AppServerClient(spawnAppServer(label.startsWith('codex-seatbelt') ? wrapper : binaries.codex, [...args, ...extra], cwd, { PATH: process.env.PATH, HOME: home, CODEX_HOME: overlay }), {
                request(method, id) { client.respondError(id, -32601, `No approvals in probe: ${method}`); },
                notification(method, params) { notifications.push({ method, params }); if (method === 'turn/completed')
                    complete(); }
            });
            const pumping = client.pump();
            const timer = setTimeout(() => { void client.close(); complete(); }, 30000);
            try {
                await client.request('initialize', { clientInfo: { name: 'wider_probe', version: '1' }, capabilities: { experimentalApi: true } });
                const skills = await client.request('skills/list', { cwds: [cwd], forceReload: true });
                const started: any = await client.request('thread/start', { cwd, model: 'gpt-5.4', approvalPolicy: 'never', sandbox: 'read-only' });
                await client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: prompt, text_elements: [] }] });
                await done;
                const text = JSON.stringify(bodies);
                const names = (skills as any).data.flatMap((d: any) => d.skills.map((s: any) => s.name));
                if (label === 'codex-explicit-path') assert.ok(!names.includes('external-selected'), label);
                if (label.startsWith('codex-seatbelt')) assert.deepEqual(names, ['snapshot-selected'], label);
                assert.equal(notifications.findLast(n => n.method === 'turn/completed')?.params.turn.status, 'completed', label);
                assert.equal(text.includes('NATIVE_PROJECT_CONTENT'), label === 'codex-no-instructions-invoked', label);
                assert.equal(text.includes('FROZEN_SNAPSHOT_CONTENT'), label === 'codex-seatbelt-selected', label);
                assert.equal(text.includes('PROBE_DESCRIPTION_native-project'), !label.startsWith('codex-seatbelt') && label !== 'codex-no-instructions', label);
                assert.ok(text.includes('REPOSITORY_INSTRUCTIONS_SENTINEL'), label);
                console.log(JSON.stringify({ label, skills: (skills as any).data.flatMap((d: any) => d.skills.map((s: any) => s.name)), requests: bodies.length, nativeDescription: text.includes('PROBE_DESCRIPTION_native-project'), snapshotDescription: text.includes('PROBE_DESCRIPTION_snapshot-selected'), nativeContent: text.includes('NATIVE_PROJECT_CONTENT'), snapshotContent: text.includes('FROZEN_SNAPSHOT_CONTENT'), repoInstructions: text.includes('REPOSITORY_INSTRUCTIONS_SENTINEL'), completed: notifications.findLast(n => n.method === 'turn/completed')?.params.turn.status }));
            }
            finally {
                clearTimeout(timer);
                await client.close();
                await pumping;
            }
        }
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
        rmSync(root, { recursive: true, force: true });
    }
}
async function probeCodexSeatbelt(): Promise<void> {
    if (process.platform !== "darwin") {
        console.log("macOS filesystem candidate: unmeasured on this platform; capability remains null.");
        return;
    }
    const root = mkdtempSync(join(tmpdir(), 'mc-codex-isolation-'));
    const home = join(root, 'home'), cwd = join(root, 'repo'), native = join(home, '.codex'), selected = join(root, 'selected');
    for (const p of [home, cwd, native, join(native, 'sessions')])
        mkdirSync(p, { recursive: true });
    function skill(path: string, name: string, body: string) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: DESC_${name}\n---\n${body}\n`); }
    skill(join(home, '.agents/skills/user'), 'native-user', 'ORIGINAL_USER_CONTENT');
    skill(join(cwd, '.agents/skills/project'), 'native-project', 'ORIGINAL_PROJECT_CONTENT');
    skill(selected, 'snapshot-selected', 'FROZEN_SELECTED_CONTENT');
    writeFileSync(join(cwd, 'AGENTS.md'), 'REPO_INSTRUCTIONS_SENTINEL');
    const mcp = join(root, 'mcp.mjs');
    writeFileSync(mcp, `import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const q=JSON.parse(line);if(q.id===undefined)continue;const result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'preserved-fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:'preserved_tool',description:'PRESERVED_MCP_TOOL',inputSchema:{type:'object',properties:{}}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}`);
    let bodies: any[] = [], authSeen = false, execute = false;
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const c of req)
            raw += c;
        if (!raw) {
            res.end('{}');
            return;
        }
        const body = JSON.parse(raw);
        bodies.push(body);
        authSeen ||= req.headers.authorization === 'Bearer LOCAL_AUTH_FIXTURE';
        res.setHeader('content-type', 'text/event-stream');
        const emit = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        const item = execute && bodies.length === 1 ? { id: 'fc-probe', type: 'function_call', call_id: 'probe-call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf "%s\\n" "$PHASE4_NON_SKILL_SENTINEL"; pwd; cat AGENTS.md', max_output_tokens: 1000 }) } : { id: 'msg-probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'LOCAL_DONE', annotations: [] }] };
        emit('response.created', { response: { id: 'resp-probe', status: 'in_progress', output: [] } });
        emit('response.output_item.done', { output_index: 0, item });
        emit('response.completed', { response: { id: 'resp-probe', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
        res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    writeFileSync(join(native, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'LOCAL_AUTH_FIXTURE' }));
    writeFileSync(join(native, 'config.toml'), `model="gpt-5.4"\nmodel_provider="local_probe"\nmodel_reasoning_effort="low"\ncli_auth_credentials_store="file"\n[model_providers.local_probe]\nname="local_probe"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=true\n[shell_environment_policy.set]\nPHASE4_NON_SKILL_SENTINEL="RETAINED_ENV_SENTINEL"\n[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(mcp)}]\n`);
    const env = { PATH: process.env.PATH, HOME: home };
    const active = new Set<{
        close(): Promise<void>;
    }>();
    function connect(executable: string, codexHome: string, args: string[] = []) {
        let done = () => { };
        let completion: any;
        const client = new AppServerClient(spawnAppServer(executable, args, cwd, { ...env, CODEX_HOME: codexHome }), { request(method, id) { client.respondError(id, -32601, `Unexpected request ${method}`); }, notification(method, p: any) { if (method === 'turn/completed') {
                completion = p;
                done();
            } } });
        const pumping = client.pump();
        const connection = { client, pumping, async init() { await client.request('initialize', { clientInfo: { name: 'isolation_probe', version: '1' }, capabilities: { experimentalApi: true } }); }, async turn(threadId: string, text: string, tool = false) { bodies = []; completion = undefined; execute = tool; const finished = new Promise<void>(r => done = r); const timer = setTimeout(() => { void client.close(); done(); }, 30000); try {
                await client.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
                await finished;
                assert.equal(completion?.turn.status, 'completed');
            }
            finally {
                clearTimeout(timer);
            } return JSON.stringify(bodies); }, async close() { await client.close(); await pumping; active.delete(connection); } };
        active.add(connection);
        return connection;
    }
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    try {
        const baseline = connect(binaries.codex, native);
        await baseline.init();
        const baselineConfig: any = await baseline.client.request('config/read', { includeLayers: false });
        const defaults: any = await baseline.client.request('skills/list', { cwds: [cwd], forceReload: true });
        const baselineThread: any = await baseline.client.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' });
        const baselineTool = await baseline.turn(baselineThread.thread.id, 'Check the fixture tool.', true);
        assert.ok(baselineTool.includes('RETAINED_ENV_SENTINEL'), 'baseline tool must work before attributing failure to the outer sandbox');
        await baseline.close();
        const enabled = defaults.data.flatMap((d: any) => d.skills).filter((s: any) => s.enabled);
        for (const inherit of [false, true]) {
            const snapshot = join(root, inherit ? 'inherit-on' : 'inherit-off'), overlay = join(root, inherit ? 'overlay-on' : 'overlay-off');
            mkdirSync(snapshot);
            mkdirSync(overlay);
            if (inherit)
                for (const s of enabled)
                    cpSync(dirname(s.path), join(snapshot, s.name), { recursive: true });
            cpSync(selected, join(snapshot, 'snapshot-selected'), { recursive: true });
            for (const entry of readdirSync(native)) {
                if (entry !== 'skills')
                    symlinkSync(join(native, entry), join(overlay, entry));
            }
            symlinkSync(snapshot, join(overlay, 'skills'));
            const manifest = realpathSync(snapshot), profile = join(overlay, 'isolation.sb'), wrapper = join(overlay, 'codex');
            writeFileSync(profile, `(version 1)\n(allow default)\n(deny file-read-data (require-all (regex #"/SKILL[.]md$") (require-not (subpath ${JSON.stringify(manifest)}))))\n(deny file-write* (subpath ${JSON.stringify(manifest)}))\n`);
            writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${quote(profile)} ${quote(binaries.codex)} "$@"\n`, { mode: 0o700 });
            const args = ['-c', 'skills.bundled.enabled=false', '-c', 'features.shell_snapshot=false'];
            const run = connect(wrapper, overlay, args);
            await run.init();
            const config: any = await run.client.request('config/read', { includeLayers: false });
            for (const key of ['model', 'model_provider', 'model_reasoning_effort', 'cli_auth_credentials_store', 'shell_environment_policy', 'mcp_servers'])
                assert.deepEqual(config.config[key], baselineConfig.config[key], key);
            const listed: any = await run.client.request('skills/list', { cwds: [cwd], forceReload: true });
            const names = listed.data.flatMap((d: any) => d.skills).filter((s: any) => s.enabled).map((s: any) => s.name).sort();
            const expected = [...(inherit ? enabled.map((s: any) => s.name) : []), 'snapshot-selected'].sort();
            assert.deepEqual(names, expected);
            const started: any = await run.client.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' });
            authSeen = false;
            const initial = await run.turn(started.thread.id, '$snapshot-selected');
            assert.ok(initial.includes('FROZEN_SELECTED_CONTENT'));
            assert.ok(initial.includes('REPO_INSTRUCTIONS_SENTINEL'));
            assert.ok(initial.includes('PRESERVED_MCP_TOOL'));
            assert.ok(authSeen);
            await run.turn(started.thread.id, 'Check the fixture tool.', true);
            const outputs = bodies.flatMap(b => b.input ?? []).filter(i => i.type === 'function_call_output').map(i => i.output).join('\n');
            assert.ok(outputs.includes('sandbox-exec: sandbox_apply: Operation not permitted'), 're-evaluate the candidate if native tool sandbox nesting starts working');
            await run.close();
            skill(join(cwd, '.agents/skills/late'), 'late-native', 'LATE_NATIVE_CONTENT');
            skill(join(cwd, '.agents/skills/project'), 'native-project', 'EDITED_NATIVE_CONTENT');
            rmSync(join(home, '.agents/skills/user'), { recursive: true, force: true });
            skill(selected, 'snapshot-selected', 'EDITED_SELECTED_CONTENT');
            const resumed = connect(wrapper, overlay, args);
            await resumed.init();
            const listedResume: any = await resumed.client.request('skills/list', { cwds: [cwd], forceReload: true });
            assert.deepEqual(listedResume.data.flatMap((d: any) => d.skills).filter((s: any) => s.enabled).map((s: any) => s.name).sort(), expected);
            await resumed.client.request('thread/resume', { threadId: started.thread.id, cwd, approvalPolicy: 'never', sandbox: 'read-only' });
            const after = await resumed.turn(started.thread.id, '$snapshot-selected');
            assert.ok(after.includes('FROZEN_SELECTED_CONTENT'));
            assert.ok(!after.includes('EDITED_SELECTED_CONTENT'));
            assert.ok(!after.includes('LATE_NATIVE_CONTENT'));
            assert.ok(!after.includes('EDITED_NATIVE_CONTENT'));
            await resumed.close();
            console.log(JSON.stringify({ inheritDefaults: inherit, names, exactDiscovery: true, selectedInvocation: true, selectedResumeFrozen: true, nativeDiscoveryMutationIgnored: true, fixtureFileAuthPreserved: authSeen, fixtureNonSkillConfigEqual: true, repoInstructions: true, mcpTool: true, baselineSandboxTool: true, nestedSandboxTool: false, toolError: 'sandbox-exec: sandbox_apply: Operation not permitted', capability: null }));
            skill(selected, 'snapshot-selected', 'FROZEN_SELECTED_CONTENT');
            skill(join(home, '.agents/skills/user'), 'native-user', 'ORIGINAL_USER_CONTENT');
            skill(join(cwd, '.agents/skills/project'), 'native-project', 'ORIGINAL_PROJECT_CONTENT');
            rmSync(join(cwd, '.agents/skills/late'), { recursive: true });
        }
    }
    finally {
        for (const connection of active)
            await connection.close();
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
        rmSync(root, { recursive: true, force: true });
    }
}
await probeClaudeFilters();
await probeCodexFilters();
await probeCodexSeatbelt();
console.log("Wider probes completed: no mechanism passes the full isolation-and-preservation contract. Both skillSelection cells remain null.");
