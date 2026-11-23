# acli read contracts

Read-only captures verified on **2026-11-02** using `acli version 1.3.40-stable`.
The behaviors below are observations of that version to recheck when updating acli.
Hosts, issue and project keys, people, ids, URLs, summaries, descriptions and other field
values are synthetic.
JSON structure, field names, value types and consistent issue relationships are retained.
Raw captures are private scratch data and are never committed.

Each JSON file records argv (after `acli`), exit code, stdout and stderr. Commands:

- `acli --version`
- `acli jira auth status` (authenticated and logged-out captures)
- `acli auth status`
- `acli jira workitem search --jql "key in (MC-2, MC-1, MC-6, MC-5, MC-4, MC-3) ORDER BY key ASC" --fields key,summary,description,priority --json --limit 1`
- The same search with `--limit 3`, and with `--limit 3 --paginate`.
- `acli jira workitem search --jql "key = MC-2 AND key != MC-2" --fields key,summary,description,priority --json --limit 1`
- `acli jira workitem search --jql "project = NOPE_404" --fields key,summary,description,priority --json --limit 1`
- `acli jira workitem view MC-2 --fields status --json`
- `acli jira workitem view MC-2 --fields '*all' --json`
- `acli jira workitem search --jql "key in (MC-2, MC-1, MC-6, MC-5, MC-4, MC-3) ORDER BY key ASC" --fields self --json --limit 1`
- `acli jira workitem search --bogus`

Search returns a bare array of Jira-shaped issues, including top-level `key` and `self`.
The captured `self` host is an internal Atlassian service host, distinct from the public
site printed by auth status. Its synthetic equivalent is
`jira-prod-us-0-0.prod.atl-paas.net`; this relationship must survive sanitization.
The read adapter recognizes only this HTTPS Jira service-host/issue-path format, derives
public browse links from the configured site and checks auth status before and after search.
Description is ADF. The selected fields include summary, description and priority.
An empty result exits zero and prints `[]`. Rejected JQL exits one and explains the
invalid project on stderr. Requesting `self` as a field is refused, even though normal
search results include it at the top level.

Both `--limit 3` and `--limit 3 --paginate` returned exactly three of the six matching
issues. `--paginate` honors the total limit; it is safe to combine it with the sweep
ceiling plus one probe row. The adapter uses it to allow multi-page reads within that bound.

Jira auth status prints `Site: example.atlassian.net` on stdout. Global `acli auth status`
still reports unauthorized with Jira-specific OAuth logged in. The adapter uses Jira status.
Both view captures contain `transitions: null`; `*all` exposes no transition list. Phase 2
must use the approved status-name resolve contract rather than assume a transition list exists.
