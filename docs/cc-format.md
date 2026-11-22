# Claude Code — Dateiformate (Stand 2026-11-10)

## Transcripts: `~/.claude/projects/<projekt>/<sessionId>.jsonl`

- `<projekt>` = cwd, bei dem `/` und `.` zu `-` werden (`/home/silence/dev/kev.dev` → `-home-silence-dev-kev-dev`).
  Das lässt sich **nicht** eindeutig zurückrechnen → den echten Pfad aus dem Feld `cwd` der Einträge lesen.
- Eine JSON-Zeile pro Eintrag, Feld `type` sagt, was es ist:

| type | wichtige Felder |
|---|---|
| `user` | `message.content` (String oder Block-Array), `cwd`, `sessionId`, `timestamp`, `isSidechain`, `gitBranch`, `toolUseResult` (wenn es ein Tool-Ergebnis ist) |
| `assistant` | `message` (API-Message), `cwd`, `sessionId`, `timestamp`, `requestId` |
| `attachment` | `attachment`, `cwd`, `timestamp` |
| `ai-title` | `aiTitle` — von CC erzeugter Titel |
| `last-prompt` | `lastPrompt` |
| `mode`, `permission-mode`, `atis-latch`, `file-history-snapshot` | interne Zustände |

Erster echter User-Prompt = erster `user`-Eintrag, dessen `message.content` ein String ist
(Tool-Ergebnisse sind Arrays mit `tool_result`).

## Subagents: `~/.claude/projects/<projekt>/<sessionId>/subagents/`

- `agent-<agentId>.jsonl` — gleiches Format, Einträge mit `isSidechain: true` und `agentId`.
  Der erste `user`-Eintrag ist der Prompt an den Subagent.
- `agent-<agentId>.meta.json` — z. B.
  `{"agentType":"general-purpose","description":"Security review shop branch","toolUseId":"toolu_…","spawnDepth":1,"requestShape":"background","requestNonInteractive":true}`

## Hook-Payloads (kommen als JSON auf stdin)

### Stop — echt mitgeschnitten (`claude -p` mit Test-Settings)

```json
{"session_id":"7ff9d39e-…","transcript_path":"/home/silence/.claude/projects/<projekt>/<id>.jsonl",
 "cwd":"/…","prompt_id":"d1f06503-…","permission_mode":"default","hook_event_name":"Stop",
 "stop_hook_active":false,"last_assistant_message":"ok","background_tasks":[],"session_crons":[]}
```

### Notification — nicht mitgeschnitten

Feuert in `-p`-Läufen nicht. Laut Doku: dieselben Basisfelder (`session_id`, `transcript_path`, `cwd`,
`hook_event_name: "Notification"`) plus `message` (und `notification_type`). Wird beim ersten echten
Lauf von Step 3 nachgeprüft.
