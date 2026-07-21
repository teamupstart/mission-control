/**
 * Verbatim cmux output, captured from a live cmux 0.64.20 on macOS 26.
 *
 * The rule from `claude-panes.ts` applies without exception: RECAPTURE, never hand-write.
 * Every claim `cmux-adapter.test.ts` makes about what this backend reports is only worth
 * something if these bytes are what it actually said, and the most important of them is a
 * defect - hand-editing the tree would quietly turn the regression test below into a test of
 * someone's idea of cmux.
 *
 * What this capture happens to contain, all of it real:
 *
 *   - two cmux WINDOWS, which is what makes `tree --all` necessary: `workspace list` is
 *     scoped to one window and answers for 3 of these 7 workspaces.
 *   - four workspaces holding exactly one terminal surface, each reporting its own tty.
 *   - `mc-tty2`, holding two terminal surfaces, where cmux reports `ttys032` for a process
 *     that `ps` puts on `ttys031` and `null` for the surface that really owns `ttys032`.
 *     That is the mis-attribution `parseTree` refuses to pass on, captured in the act.
 *   - `mc-probe`, two terminals plus a BROWSER surface - a surface kind with a url where a
 *     terminal has a tty, which is not a pane anything can type into.
 *   - `Terminal`, two terminal surfaces that never got a pty at all.
 */

/** `cmux tree --all --json --id-format both` - every window, every workspace, every surface. */
export const CMUX_TREE = String.raw`
{
  "active" : {
    "is_browser_surface" : false,
    "pane_id" : "295CEA4A-7F1A-497A-8C9B-4F3F53A41141",
    "pane_ref" : "pane:8",
    "surface_id" : "411A3606-EA5D-4244-9B48-02375C1FFD35",
    "surface_ref" : "surface:9",
    "surface_type" : "terminal",
    "tab_id" : "411A3606-EA5D-4244-9B48-02375C1FFD35",
    "tab_ref" : "tab:9",
    "window_id" : "60AE9E8E-937A-4CAA-A561-C51F6F2CE753",
    "window_ref" : "window:2",
    "workspace_id" : "C272A385-F62E-442A-A247-F1D53B09B68A",
    "workspace_ref" : "workspace:6"
  },
  "caller" : null,
  "windows" : [
    {
      "active" : true,
      "current" : true,
      "id" : "60AE9E8E-937A-4CAA-A561-C51F6F2CE753",
      "index" : 0,
      "key" : false,
      "ref" : "window:2",
      "selected_workspace_id" : "C272A385-F62E-442A-A247-F1D53B09B68A",
      "selected_workspace_ref" : "workspace:6",
      "visible" : true,
      "workspace_count" : 4,
      "workspaces" : [
        {
          "active" : false,
          "description" : null,
          "id" : "F28DFB9F-6566-44D6-B45E-E005F3FE18F2",
          "index" : 0,
          "panes" : [
            {
              "active" : false,
              "focused" : true,
              "id" : "3A3DD914-31B6-4835-8C27-4E6FFAE23FC2",
              "index" : 0,
              "ref" : "pane:5",
              "selected_surface_id" : "9F7A4D31-B2D4-41A8-A6AC-37ADEA71A62A",
              "selected_surface_ref" : "surface:5",
              "surface_count" : 1,
              "surface_ids" : [
                "9F7A4D31-B2D4-41A8-A6AC-37ADEA71A62A"
              ],
              "surface_refs" : [
                "surface:5"
              ],
              "surfaces" : [
                {
                  "active" : false,
                  "focused" : true,
                  "here" : false,
                  "id" : "9F7A4D31-B2D4-41A8-A6AC-37ADEA71A62A",
                  "index" : 0,
                  "index_in_pane" : 0,
                  "pane_id" : "3A3DD914-31B6-4835-8C27-4E6FFAE23FC2",
                  "pane_ref" : "pane:5",
                  "ref" : "surface:5",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "jordanmance@Jordans-MacBook-Pro:/private/tmp/claude-501/-Users-jordanmance--mission-control-worktrees-b661d74d-44e2-4515-99a2-852600ddb85a/25ded35c-5803-4258-8c52-af95a0882bd0/scratchpad",
                  "tty" : "ttys028",
                  "type" : "terminal",
                  "url" : null
                }
              ]
            }
          ],
          "pinned" : false,
          "ref" : "workspace:4",
          "selected" : false,
          "title" : "jordanmance@Jordans-MacBook-Pro:/private/tmp/claude-501/-Users-jordanmance--mission-control-worktrees-b661d74d-44e2-4515-99a2-852600ddb85a/25ded35c-5803-4258-8c52-af95a0882bd0/scratchpad"
        },
        {
          "active" : true,
          "description" : null,
          "id" : "C272A385-F62E-442A-A247-F1D53B09B68A",
          "index" : 1,
          "panes" : [
            {
              "active" : true,
              "focused" : true,
              "id" : "295CEA4A-7F1A-497A-8C9B-4F3F53A41141",
              "index" : 0,
              "ref" : "pane:8",
              "selected_surface_id" : "411A3606-EA5D-4244-9B48-02375C1FFD35",
              "selected_surface_ref" : "surface:9",
              "surface_count" : 1,
              "surface_ids" : [
                "411A3606-EA5D-4244-9B48-02375C1FFD35"
              ],
              "surface_refs" : [
                "surface:9"
              ],
              "surfaces" : [
                {
                  "active" : true,
                  "focused" : true,
                  "here" : false,
                  "id" : "411A3606-EA5D-4244-9B48-02375C1FFD35",
                  "index" : 0,
                  "index_in_pane" : 0,
                  "pane_id" : "295CEA4A-7F1A-497A-8C9B-4F3F53A41141",
                  "pane_ref" : "pane:8",
                  "ref" : "surface:9",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "jordanmance@Jordans-MacBook-Pro:/tmp",
                  "tty" : "ttys030",
                  "type" : "terminal",
                  "url" : null
                }
              ]
            }
          ],
          "pinned" : false,
          "ref" : "workspace:6",
          "selected" : true,
          "title" : "jordanmance@Jordans-MacBook-Pro:/tmp"
        },
        {
          "active" : false,
          "description" : null,
          "id" : "075E99D6-F1A2-4B56-A943-4EBDE4AEF336",
          "index" : 2,
          "panes" : [
            {
              "active" : false,
              "focused" : true,
              "id" : "E5C3DDD1-D335-4C95-BAE2-BEA554E6D221",
              "index" : 0,
              "ref" : "pane:9",
              "selected_surface_id" : "83AA75E4-1F08-4933-B486-D2FC86AAF5F8",
              "selected_surface_ref" : "surface:10",
              "surface_count" : 1,
              "surface_ids" : [
                "83AA75E4-1F08-4933-B486-D2FC86AAF5F8"
              ],
              "surface_refs" : [
                "surface:10"
              ],
              "surfaces" : [
                {
                  "active" : false,
                  "focused" : true,
                  "here" : false,
                  "id" : "83AA75E4-1F08-4933-B486-D2FC86AAF5F8",
                  "index" : 0,
                  "index_in_pane" : 0,
                  "pane_id" : "E5C3DDD1-D335-4C95-BAE2-BEA554E6D221",
                  "pane_ref" : "pane:9",
                  "ref" : "surface:10",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "sleep 12345",
                  "tty" : "ttys032",
                  "type" : "terminal",
                  "url" : null
                }
              ]
            },
            {
              "active" : false,
              "focused" : false,
              "id" : "D3B67E37-F7C4-44DA-8ED1-0DB2DC28DA4C",
              "index" : 1,
              "ref" : "pane:10",
              "selected_surface_id" : "F0EA1CCB-AE36-4CC7-B7EA-76B2AED611F9",
              "selected_surface_ref" : "surface:11",
              "surface_count" : 1,
              "surface_ids" : [
                "F0EA1CCB-AE36-4CC7-B7EA-76B2AED611F9"
              ],
              "surface_refs" : [
                "surface:11"
              ],
              "surfaces" : [
                {
                  "active" : false,
                  "focused" : false,
                  "here" : false,
                  "id" : "F0EA1CCB-AE36-4CC7-B7EA-76B2AED611F9",
                  "index" : 1,
                  "index_in_pane" : 0,
                  "pane_id" : "D3B67E37-F7C4-44DA-8ED1-0DB2DC28DA4C",
                  "pane_ref" : "pane:10",
                  "ref" : "surface:11",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "jordanmance@Jordans-MacBook-Pro:/tmp",
                  "tty" : null,
                  "type" : "terminal",
                  "url" : null
                }
              ]
            }
          ],
          "pinned" : false,
          "ref" : "workspace:7",
          "selected" : false,
          "title" : "mc-tty2"
        },
        {
          "active" : false,
          "description" : null,
          "id" : "6B290B19-074B-4C87-83AC-DFAE44619893",
          "index" : 3,
          "panes" : [
            {
              "active" : false,
              "focused" : true,
              "id" : "22896A91-6021-4D18-8147-6E5B7651BF0E",
              "index" : 0,
              "ref" : "pane:6",
              "selected_surface_id" : "7C031DF3-22E3-4FCA-8AA7-148948A13016",
              "selected_surface_ref" : "surface:6",
              "surface_count" : 1,
              "surface_ids" : [
                "7C031DF3-22E3-4FCA-8AA7-148948A13016"
              ],
              "surface_refs" : [
                "surface:6"
              ],
              "surfaces" : [
                {
                  "active" : false,
                  "focused" : true,
                  "here" : false,
                  "id" : "7C031DF3-22E3-4FCA-8AA7-148948A13016",
                  "index" : 0,
                  "index_in_pane" : 0,
                  "pane_id" : "22896A91-6021-4D18-8147-6E5B7651BF0E",
                  "pane_ref" : "pane:6",
                  "ref" : "surface:6",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "Terminal",
                  "tty" : null,
                  "type" : "terminal",
                  "url" : null
                }
              ]
            },
            {
              "active" : false,
              "focused" : false,
              "id" : "13364740-26BC-4859-BC46-0229990B8395",
              "index" : 1,
              "ref" : "pane:7",
              "selected_surface_id" : "1376D50E-2A72-4496-A8CA-832F41E3468B",
              "selected_surface_ref" : "surface:7",
              "surface_count" : 1,
              "surface_ids" : [
                "1376D50E-2A72-4496-A8CA-832F41E3468B"
              ],
              "surface_refs" : [
                "surface:7"
              ],
              "surfaces" : [
                {
                  "active" : false,
                  "focused" : false,
                  "here" : false,
                  "id" : "1376D50E-2A72-4496-A8CA-832F41E3468B",
                  "index" : 1,
                  "index_in_pane" : 0,
                  "pane_id" : "13364740-26BC-4859-BC46-0229990B8395",
                  "pane_ref" : "pane:7",
                  "ref" : "surface:7",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "Terminal",
                  "tty" : null,
                  "type" : "terminal",
                  "url" : null
                }
              ]
            }
          ],
          "pinned" : false,
          "ref" : "workspace:5",
          "selected" : false,
          "title" : "Terminal"
        }
      ]
    },
    {
      "active" : false,
      "current" : false,
      "id" : "42A9E69D-EAED-4D5C-91BC-BFC929CEADE8",
      "index" : 1,
      "key" : false,
      "ref" : "window:1",
      "selected_workspace_id" : "D0D87E8D-6410-4155-8305-81A4F1306A67",
      "selected_workspace_ref" : "workspace:3",
      "visible" : true,
      "workspace_count" : 3,
      "workspaces" : [
        {
          "active" : false,
          "description" : null,
          "id" : "6750BEF2-7074-412F-989B-AF56D1C257A6",
          "index" : 0,
          "panes" : [
            {
              "active" : false,
              "focused" : true,
              "id" : "484E0D96-1740-439C-A088-617708D01CE8",
              "index" : 0,
              "ref" : "pane:1",
              "selected_surface_id" : "5F08E6A9-5A9A-4905-8721-1C23AE52BA1A",
              "selected_surface_ref" : "surface:1",
              "surface_count" : 1,
              "surface_ids" : [
                "5F08E6A9-5A9A-4905-8721-1C23AE52BA1A"
              ],
              "surface_refs" : [
                "surface:1"
              ],
              "surfaces" : [
                {
                  "active" : false,
                  "focused" : true,
                  "here" : false,
                  "id" : "5F08E6A9-5A9A-4905-8721-1C23AE52BA1A",
                  "index" : 0,
                  "index_in_pane" : 0,
                  "pane_id" : "484E0D96-1740-439C-A088-617708D01CE8",
                  "pane_ref" : "pane:1",
                  "ref" : "surface:1",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "~",
                  "tty" : "ttys021",
                  "type" : "terminal",
                  "url" : null
                }
              ]
            }
          ],
          "pinned" : false,
          "ref" : "workspace:1",
          "selected" : false,
          "title" : "~"
        },
        {
          "active" : false,
          "description" : null,
          "id" : "D0D87E8D-6410-4155-8305-81A4F1306A67",
          "index" : 1,
          "panes" : [
            {
              "active" : false,
              "focused" : true,
              "id" : "A8B7751C-E6E8-4D27-AC7C-2B99B47CF250",
              "index" : 0,
              "ref" : "pane:3",
              "selected_surface_id" : "7B318DE7-CC2F-4606-89C0-7AFF10F2904E",
              "selected_surface_ref" : "surface:3",
              "surface_count" : 2,
              "surface_ids" : [
                "7B318DE7-CC2F-4606-89C0-7AFF10F2904E",
                "953717BD-4E91-4663-A5AE-5A1302DC8FAA"
              ],
              "surface_refs" : [
                "surface:3",
                "surface:8"
              ],
              "surfaces" : [
                {
                  "active" : false,
                  "focused" : true,
                  "here" : false,
                  "id" : "7B318DE7-CC2F-4606-89C0-7AFF10F2904E",
                  "index" : 0,
                  "index_in_pane" : 0,
                  "pane_id" : "A8B7751C-E6E8-4D27-AC7C-2B99B47CF250",
                  "pane_ref" : "pane:3",
                  "ref" : "surface:3",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "python3",
                  "tty" : "ttys026",
                  "type" : "terminal",
                  "url" : null
                },
                {
                  "active" : false,
                  "focused" : false,
                  "here" : false,
                  "id" : "953717BD-4E91-4663-A5AE-5A1302DC8FAA",
                  "index" : 1,
                  "index_in_pane" : 1,
                  "pane_id" : "A8B7751C-E6E8-4D27-AC7C-2B99B47CF250",
                  "pane_ref" : "pane:3",
                  "ref" : "surface:8",
                  "selected" : false,
                  "selected_in_pane" : false,
                  "title" : "Example Domain",
                  "tty" : null,
                  "type" : "browser",
                  "url" : "https://example.com/"
                }
              ]
            },
            {
              "active" : false,
              "focused" : false,
              "id" : "67780B4F-0124-43DF-9675-5E0E52149288",
              "index" : 1,
              "ref" : "pane:4",
              "selected_surface_id" : "7F4F8A9C-CFD0-4E17-9C46-7F214E7920AE",
              "selected_surface_ref" : "surface:4",
              "surface_count" : 1,
              "surface_ids" : [
                "7F4F8A9C-CFD0-4E17-9C46-7F214E7920AE"
              ],
              "surface_refs" : [
                "surface:4"
              ],
              "surfaces" : [
                {
                  "active" : false,
                  "focused" : false,
                  "here" : false,
                  "id" : "7F4F8A9C-CFD0-4E17-9C46-7F214E7920AE",
                  "index" : 2,
                  "index_in_pane" : 0,
                  "pane_id" : "67780B4F-0124-43DF-9675-5E0E52149288",
                  "pane_ref" : "pane:4",
                  "ref" : "surface:4",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "/tmp",
                  "tty" : null,
                  "type" : "terminal",
                  "url" : null
                }
              ]
            }
          ],
          "pinned" : false,
          "ref" : "workspace:3",
          "selected" : true,
          "title" : "mc-probe"
        },
        {
          "active" : false,
          "description" : null,
          "id" : "E8CD9CEC-7479-4691-9C66-646B58B8E24D",
          "index" : 2,
          "panes" : [
            {
              "active" : false,
              "focused" : true,
              "id" : "3A134019-EA47-433C-877B-958BFE3563E8",
              "index" : 0,
              "ref" : "pane:2",
              "selected_surface_id" : "D279059C-2886-4111-9F71-AF7249C5D6AA",
              "selected_surface_ref" : "surface:2",
              "surface_count" : 1,
              "surface_ids" : [
                "D279059C-2886-4111-9F71-AF7249C5D6AA"
              ],
              "surface_refs" : [
                "surface:2"
              ],
              "surfaces" : [
                {
                  "active" : false,
                  "focused" : true,
                  "here" : false,
                  "id" : "D279059C-2886-4111-9F71-AF7249C5D6AA",
                  "index" : 0,
                  "index_in_pane" : 0,
                  "pane_id" : "3A134019-EA47-433C-877B-958BFE3563E8",
                  "pane_ref" : "pane:2",
                  "ref" : "surface:2",
                  "selected" : true,
                  "selected_in_pane" : true,
                  "title" : "…/-Users-jordanmance--mission-control-worktrees-b661d74d-44e2-4515-99a2-852600ddb85a/25ded35c-5803-4258-8c52-af95a0882bd0/scratchpad",
                  "tty" : "ttys027",
                  "type" : "terminal",
                  "url" : null
                }
              ]
            }
          ],
          "pinned" : false,
          "ref" : "workspace:2",
          "selected" : false,
          "title" : "0"
        }
      ]
    }
  ]
}
`;

/** `cmux workspace list --json --id-format both --window window:1` - one window's directories. */
export const CMUX_WORKSPACES_WINDOW_1 = String.raw`
{
  "window_id" : "42A9E69D-EAED-4D5C-91BC-BFC929CEADE8",
  "window_ref" : "window:1",
  "workspaces" : [
    {
      "current_directory" : "/Users/jordanmance",
      "custom_color" : null,
      "custom_title" : null,
      "description" : null,
      "has_custom_title" : false,
      "id" : "6750BEF2-7074-412F-989B-AF56D1C257A6",
      "index" : 0,
      "latest_conversation_message" : null,
      "latest_submitted_at" : null,
      "latest_submitted_message" : null,
      "listening_ports" : [

      ],
      "pinned" : false,
      "ref" : "workspace:1",
      "remote" : {
        "active_terminal_sessions" : 0,
        "conflicted_ports" : [

        ],
        "connected" : false,
        "daemon" : {
          "capabilities" : [

          ],
          "detail" : null,
          "name" : null,
          "remote_path" : null,
          "state" : "unavailable",
          "version" : null
        },
        "destination" : null,
        "detail" : null,
        "detected_ports" : [

        ],
        "enabled" : false,
        "forwarded_ports" : [

        ],
        "has_identity_file" : false,
        "has_ssh_options" : false,
        "heartbeat" : {
          "age_seconds" : null,
          "count" : 0,
          "last_seen_at" : null
        },
        "local_proxy_port" : null,
        "persistent_daemon_slot" : null,
        "port" : null,
        "proxy" : {
          "error_code" : null,
          "host" : null,
          "port" : null,
          "schemes" : [
            "socks5",
            "http_connect"
          ],
          "state" : "unavailable",
          "url" : null
        },
        "state" : "disconnected",
        "transport" : null
      },
      "selected" : false,
      "title" : "~"
    },
    {
      "current_directory" : "/private/tmp/claude-501/-Users-jordanmance--mission-control-worktrees-b661d74d-44e2-4515-99a2-852600ddb85a/25ded35c-5803-4258-8c52-af95a0882bd0/scratchpad",
      "custom_color" : null,
      "custom_title" : "mc-probe",
      "description" : null,
      "has_custom_title" : true,
      "id" : "D0D87E8D-6410-4155-8305-81A4F1306A67",
      "index" : 1,
      "latest_conversation_message" : null,
      "latest_submitted_at" : null,
      "latest_submitted_message" : null,
      "listening_ports" : [

      ],
      "pinned" : false,
      "ref" : "workspace:3",
      "remote" : {
        "active_terminal_sessions" : 0,
        "conflicted_ports" : [

        ],
        "connected" : false,
        "daemon" : {
          "capabilities" : [

          ],
          "detail" : null,
          "name" : null,
          "remote_path" : null,
          "state" : "unavailable",
          "version" : null
        },
        "destination" : null,
        "detail" : null,
        "detected_ports" : [

        ],
        "enabled" : false,
        "forwarded_ports" : [

        ],
        "has_identity_file" : false,
        "has_ssh_options" : false,
        "heartbeat" : {
          "age_seconds" : null,
          "count" : 0,
          "last_seen_at" : null
        },
        "local_proxy_port" : null,
        "persistent_daemon_slot" : null,
        "port" : null,
        "proxy" : {
          "error_code" : null,
          "host" : null,
          "port" : null,
          "schemes" : [
            "socks5",
            "http_connect"
          ],
          "state" : "unavailable",
          "url" : null
        },
        "state" : "disconnected",
        "transport" : null
      },
      "selected" : true,
      "title" : "mc-probe"
    },
    {
      "current_directory" : "/private/tmp/claude-501/-Users-jordanmance--mission-control-worktrees-b661d74d-44e2-4515-99a2-852600ddb85a/25ded35c-5803-4258-8c52-af95a0882bd0/scratchpad",
      "custom_color" : null,
      "custom_title" : "0",
      "description" : null,
      "has_custom_title" : true,
      "id" : "E8CD9CEC-7479-4691-9C66-646B58B8E24D",
      "index" : 2,
      "latest_conversation_message" : null,
      "latest_submitted_at" : null,
      "latest_submitted_message" : null,
      "listening_ports" : [

      ],
      "pinned" : false,
      "ref" : "workspace:2",
      "remote" : {
        "active_terminal_sessions" : 0,
        "conflicted_ports" : [

        ],
        "connected" : false,
        "daemon" : {
          "capabilities" : [

          ],
          "detail" : null,
          "name" : null,
          "remote_path" : null,
          "state" : "unavailable",
          "version" : null
        },
        "destination" : null,
        "detail" : null,
        "detected_ports" : [

        ],
        "enabled" : false,
        "forwarded_ports" : [

        ],
        "has_identity_file" : false,
        "has_ssh_options" : false,
        "heartbeat" : {
          "age_seconds" : null,
          "count" : 0,
          "last_seen_at" : null
        },
        "local_proxy_port" : null,
        "persistent_daemon_slot" : null,
        "port" : null,
        "proxy" : {
          "error_code" : null,
          "host" : null,
          "port" : null,
          "schemes" : [
            "socks5",
            "http_connect"
          ],
          "state" : "unavailable",
          "url" : null
        },
        "state" : "disconnected",
        "transport" : null
      },
      "selected" : false,
      "title" : "0"
    }
  ]
}
`;

/** `cmux workspace list --json --id-format both --window window:2`. */
export const CMUX_WORKSPACES_WINDOW_2 = String.raw`
{
  "window_id" : "60AE9E8E-937A-4CAA-A561-C51F6F2CE753",
  "window_ref" : "window:2",
  "workspaces" : [
    {
      "current_directory" : "/private/tmp/claude-501/-Users-jordanmance--mission-control-worktrees-b661d74d-44e2-4515-99a2-852600ddb85a/25ded35c-5803-4258-8c52-af95a0882bd0/scratchpad",
      "custom_color" : null,
      "custom_title" : null,
      "description" : null,
      "has_custom_title" : false,
      "id" : "F28DFB9F-6566-44D6-B45E-E005F3FE18F2",
      "index" : 0,
      "latest_conversation_message" : null,
      "latest_submitted_at" : null,
      "latest_submitted_message" : null,
      "listening_ports" : [

      ],
      "pinned" : false,
      "ref" : "workspace:4",
      "remote" : {
        "active_terminal_sessions" : 0,
        "conflicted_ports" : [

        ],
        "connected" : false,
        "daemon" : {
          "capabilities" : [

          ],
          "detail" : null,
          "name" : null,
          "remote_path" : null,
          "state" : "unavailable",
          "version" : null
        },
        "destination" : null,
        "detail" : null,
        "detected_ports" : [

        ],
        "enabled" : false,
        "forwarded_ports" : [

        ],
        "has_identity_file" : false,
        "has_ssh_options" : false,
        "heartbeat" : {
          "age_seconds" : null,
          "count" : 0,
          "last_seen_at" : null
        },
        "local_proxy_port" : null,
        "persistent_daemon_slot" : null,
        "port" : null,
        "proxy" : {
          "error_code" : null,
          "host" : null,
          "port" : null,
          "schemes" : [
            "socks5",
            "http_connect"
          ],
          "state" : "unavailable",
          "url" : null
        },
        "state" : "disconnected",
        "transport" : null
      },
      "selected" : false,
      "title" : "jordanmance@Jordans-MacBook-Pro:/private/tmp/claude-501/-Users-jordanmance--mission-control-worktrees-b661d74d-44e2-4515-99a2-852600ddb85a/25ded35c-5803-4258-8c52-af95a0882bd0/scratchpad"
    },
    {
      "current_directory" : "/tmp",
      "custom_color" : null,
      "custom_title" : null,
      "description" : null,
      "has_custom_title" : false,
      "id" : "C272A385-F62E-442A-A247-F1D53B09B68A",
      "index" : 1,
      "latest_conversation_message" : null,
      "latest_submitted_at" : null,
      "latest_submitted_message" : null,
      "listening_ports" : [

      ],
      "pinned" : false,
      "ref" : "workspace:6",
      "remote" : {
        "active_terminal_sessions" : 0,
        "conflicted_ports" : [

        ],
        "connected" : false,
        "daemon" : {
          "capabilities" : [

          ],
          "detail" : null,
          "name" : null,
          "remote_path" : null,
          "state" : "unavailable",
          "version" : null
        },
        "destination" : null,
        "detail" : null,
        "detected_ports" : [

        ],
        "enabled" : false,
        "forwarded_ports" : [

        ],
        "has_identity_file" : false,
        "has_ssh_options" : false,
        "heartbeat" : {
          "age_seconds" : null,
          "count" : 0,
          "last_seen_at" : null
        },
        "local_proxy_port" : null,
        "persistent_daemon_slot" : null,
        "port" : null,
        "proxy" : {
          "error_code" : null,
          "host" : null,
          "port" : null,
          "schemes" : [
            "socks5",
            "http_connect"
          ],
          "state" : "unavailable",
          "url" : null
        },
        "state" : "disconnected",
        "transport" : null
      },
      "selected" : true,
      "title" : "jordanmance@Jordans-MacBook-Pro:/tmp"
    },
    {
      "current_directory" : "/tmp",
      "custom_color" : null,
      "custom_title" : "mc-tty2",
      "description" : null,
      "has_custom_title" : true,
      "id" : "075E99D6-F1A2-4B56-A943-4EBDE4AEF336",
      "index" : 2,
      "latest_conversation_message" : null,
      "latest_submitted_at" : null,
      "latest_submitted_message" : null,
      "listening_ports" : [

      ],
      "pinned" : false,
      "ref" : "workspace:7",
      "remote" : {
        "active_terminal_sessions" : 0,
        "conflicted_ports" : [

        ],
        "connected" : false,
        "daemon" : {
          "capabilities" : [

          ],
          "detail" : null,
          "name" : null,
          "remote_path" : null,
          "state" : "unavailable",
          "version" : null
        },
        "destination" : null,
        "detail" : null,
        "detected_ports" : [

        ],
        "enabled" : false,
        "forwarded_ports" : [

        ],
        "has_identity_file" : false,
        "has_ssh_options" : false,
        "heartbeat" : {
          "age_seconds" : null,
          "count" : 0,
          "last_seen_at" : null
        },
        "local_proxy_port" : null,
        "persistent_daemon_slot" : null,
        "port" : null,
        "proxy" : {
          "error_code" : null,
          "host" : null,
          "port" : null,
          "schemes" : [
            "socks5",
            "http_connect"
          ],
          "state" : "unavailable",
          "url" : null
        },
        "state" : "disconnected",
        "transport" : null
      },
      "selected" : false,
      "title" : "mc-tty2"
    },
    {
      "current_directory" : "/private/tmp/claude-501/-Users-jordanmance--mission-control-worktrees-b661d74d-44e2-4515-99a2-852600ddb85a/25ded35c-5803-4258-8c52-af95a0882bd0/scratchpad",
      "custom_color" : null,
      "custom_title" : null,
      "description" : null,
      "has_custom_title" : false,
      "id" : "6B290B19-074B-4C87-83AC-DFAE44619893",
      "index" : 3,
      "latest_conversation_message" : null,
      "latest_submitted_at" : null,
      "latest_submitted_message" : null,
      "listening_ports" : [

      ],
      "pinned" : false,
      "ref" : "workspace:5",
      "remote" : {
        "active_terminal_sessions" : 0,
        "conflicted_ports" : [

        ],
        "connected" : false,
        "daemon" : {
          "capabilities" : [

          ],
          "detail" : null,
          "name" : null,
          "remote_path" : null,
          "state" : "unavailable",
          "version" : null
        },
        "destination" : null,
        "detail" : null,
        "detected_ports" : [

        ],
        "enabled" : false,
        "forwarded_ports" : [

        ],
        "has_identity_file" : false,
        "has_ssh_options" : false,
        "heartbeat" : {
          "age_seconds" : null,
          "count" : 0,
          "last_seen_at" : null
        },
        "local_proxy_port" : null,
        "persistent_daemon_slot" : null,
        "port" : null,
        "proxy" : {
          "error_code" : null,
          "host" : null,
          "port" : null,
          "schemes" : [
            "socks5",
            "http_connect"
          ],
          "state" : "unavailable",
          "url" : null
        },
        "state" : "disconnected",
        "transport" : null
      },
      "selected" : false,
      "title" : "Terminal"
    }
  ]
}
`;

