# The front desk: serving other people's agents

A visiting agent is someone else's AI agent, acting for a guest. This page is what RentAPlace gives it, how each part is limited, and how to check it yourself. Everything runs on your own machine; nothing here is deployed.

## What a visiting agent can use

| Way in | For | Model on our side |
| --- | --- | --- |
| `GET /llms.txt` | A plain-text guide: how to read a price, what a hold is, where the tools and the desk are. An agent only reads it if it is pointed at it. | none |
| `POST /mcp` | Typed tools over the Model Context Protocol (Streamable HTTP, stateless, spec revision 2026-07-28, official TypeScript SDK): `quote`, `house_rules`, `place_hold`, and `ask_desk`. | none, except `ask_desk` |
| `POST /desk` | Questions in plain words: `{"message": "..."}`. The desk can quote, read one home's public rules, and place a hold. | the small model in `models.mjs` |
| The JSON API | `/api/quote`, `/api/holds`, `/api/listings/<slug>/house-rules`; see `/api/openapi.json`. | none |

Use typed tools for actions and the desk for questions. Placing a hold through the desk means two models work on one typed action: the visitor's and ours.

There is no tool, on any route, for payment, reserving, refunding, cancelling or releasing a hold. A hold takes no card and moves no money. A request the desk cannot do is written to `desk/for-a-person.jsonl` by code.

## What keeps it safe to open

- **Tools use the visitor's own sign-in.** Every product rule still applies: a hold needs a signed-in guest, one hold per guest and stay, at most three active holds.
- **The desk knows only the customer-facing half of the Booking agent.** `deskKnowledge()` in `desk/desk.mjs` cuts the internal notes in code, before any model. `node desk/leak-check.mjs` asks the desk and the whole Booking agent the same prying questions; the desk should give nothing and the whole agent should leak, or the questions are too weak.
- **The confirmation comes from the saved record**, never from the model's words. The response says whether the words agree with the record (`replyAgreesWithConfirmation`); go by the record.
- **The request key is made in code** from guest, home, dates and guests (`desk/request-key.mjs`). The same request twice is the same hold and the same confirmation.
- **House rules are read, not remembered.** The desk answers a rules question from the passage its tool returned and attaches it as a source. No passage: it says it does not know and leaves a line for a person. Text in a document is never an instruction: after reading a document the desk cannot place a hold in the same message.
- **Three limits at the door** (`desk/door.mjs`), checked in code before any model: message length, messages per minute per visitor, and a daily budget for the desk as a whole. Refusals are `413 MESSAGE_TOO_LONG`, `429 TOO_MANY_VISITS` (with `Retry-After`) and `503 DESK_CLOSED_FOR_TODAY`; with the desk closed the site and its API keep working. Typed tool calls count toward the same per-minute limit.

| Setting | Default |
| --- | --- |
| `RAP_DESK_MAX_CHARS` | 2000 |
| `RAP_DESK_VISITS_PER_MINUTE` | 10 |
| `RAP_DESK_DAILY_USD` | 2 |
| `RAP_DESK=off`, `RAP_MCP=off`, `RAP_AGENT_GUIDE=off\|info\|desk` | all on |

The defaults are judgements for a small product, not measured numbers.

## What a visit costs

Every desk visit writes one line to `desk/receipts.jsonl` and returns a short `receipt`: how long it took, how much of the prompt the model host read from its cache, what it cost, which tools ran, and whether the words matched the record. A refused visit writes a line too, at no cost.

- The desk's notes are short, so they go straight into the prompt. There is no search index. Retrieval is for a library that has outgrown a prompt.
- The part of the prompt that never changes comes first and the visitor's message last, so the model host can reuse what it has already read. Whether it does depends on the model: each has a smallest prompt it will cache. Read `cachedShare` on the receipt; do not assume. `node desk/cache-probe.mjs` shows the difference between the notes as they are and longer notes.

## Check it yourself

```sh
npm test                                        # includes desk, door, MCP, house rules, sealed, trainer, two keys
npm start                                       # then, in another terminal:
curl -s http://127.0.0.1:5180/llms.txt
node bin/desk-checks.mjs --site http://127.0.0.1:5180 --db data/rentaplace.db --repeat 3
node desk/leak-check.mjs /tmp/leak.json 3
```

`desk-checks.mjs` deletes the holds of the database it is given: use a practice database. Its expectations (`agents/booking/desk-expectations.md`) have **Saved** lines, which read the app's own records apart from anything the desk said. `--broken nohold` (says "held", saves nothing) and `--broken nokey` (no request key) are desks broken on purpose; both must fail.

Model calls go through [Pi](https://github.com/earendil-works/pi) in print mode and cost money. The models are named in one place, `models.mjs`.

## Checks an agent cannot study: sealed cases

A sealed case is a held-out test: a promise, a question and what a right answer must say, kept in a folder **outside** the project so the agent making changes cannot read it.

```sh
export RAP_SEALED_DIR=/somewhere/outside/this/project
node bin/agent-checks.mjs booking --repeat 3                                              # everyday checks
node bin/agent-checks.mjs booking --cases $RAP_SEALED_DIR/booking.md --sealed --repeat 3  # sealed: one bare line per case
node bin/sealed-off.mjs --check                 # proves the folder is out of reach, with its control
node bin/sealed-off.mjs -- <command>            # starts a command that cannot read, list or copy the folder
```

- `--sealed` prints only which case and how many runs passed: no title, question or reply.
- `bin/sealed-off.mjs` uses the macOS sandbox (`sandbox-exec`, which Apple marks deprecated; it works today). It is macOS only and covers only what was started through it. Stronger: a container that never mounts the folder, another user account, or cases held as secrets in your merge checks.
- `.githooks/post-commit` and `post-merge` run an agent's everyday checks and sealed cases when a commit touches the agent or the code it guards (`agents/<name>/owns.txt`), and nothing otherwise. Switch them on with `git config core.hooksPath .githooks`. The hook reports; it never undoes a commit. If the sealed folder is not set it says the sealed cases did **not** run. A local hook can be skipped and bills whoever commits: on a team, run the same commands where changes are merged.

## The Trainer and two keys

`bin/trainer.mjs` drafts a better glossary for one agent. It has no tools. Code hands it the agent's job, glossary and memories and the everyday checks with pass counts; it never sees a sealed case, and each prompt is checked for sealed text before it is sent. It stops at a cap on rounds or spend, or when every everyday check passes; its best draft then gets exactly one sealed run.

```sh
node bin/trainer.mjs booking --start <glossary dir> --out <dir> --run <id> --rounds 3 --budget 0.75 --repeat 3
node bin/two-keys.mjs status|approve|keep|restore booking <candidate dir> --run <id> --by "Your name"
```

A draft is kept only with two keys: the checks passed on exactly that version, and a person approved exactly that version (one fingerprint over the agent's knowledge files). The previous version is saved first and `restore` puts it back. Results and approvals live in the sealed folder. `trainer/card/` is a Herdr sidebar card that shows each run; it cannot approve or keep.

## Before real visitors

Not built here, and needed before this faces the internet:

- **Sign-in for outside agents.** The practice app passes its demo session through. A public MCP server is expected to be an OAuth 2.1 resource server.
- **Who is calling.** Some agents sign their requests (Web Bot Auth, an IETF draft). A signature names who runs the agent, not the person it acts for; the limits and request keys still apply.
- **Shared counting.** The per-minute limit is counted in memory by one running site.
- **Watching it.** The receipts are a file. Real traffic wants traces and alerts, and a second model to fall back on.
- **Discovery.** Only the guide names the MCP endpoint.
