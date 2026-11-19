# Drafts: the Trainer's card

One card per Trainer run, read from the sealed folder (`results/<run>.json`, written by `bin/trainer.mjs`, and `approvals/`, written by a person with `bin/two-keys.mjs approve`): the everyday checks cleared at the start and on the best draft, the one sealed run, rounds and spend against their caps, and which of the two keys is there. A run reads "Waiting for you", "Approved by …" or "Cannot be kept: …".

No model is called by the card. **The card cannot approve or keep a draft: it has no such action.** Enter asks Main to show, in plain words, what the draft changes, and to change and approve nothing. Approving stays a command a person types.

## Try it without Herdr

```sh
node trainer/card/drafts.mjs show --sealed <sealed folder> --runs <folder holding <run>/candidate>
node trainer/card/drafts.mjs act <run> send-main --terminal <address> --dry   # prints what Enter would send
```

## Install (you run this; nothing installs itself)

`sh trainer/card/install.sh` copies the card into `${HERDR_APP_HOME:-~/.config/herdr-app}/mods/drafts` and checks it. Then add `{"type": "block", "content": {"mod": "drafts"}}` to a layout column.

## Settings

Default, then `~/.config/herdr-drafts/config.json` (or `HERDR_DRAFTS_CONFIG`), then `<project>/.herdr/drafts.json`, then the environment (`HERDR_DRAFTS_SEALED`, …; `RAP_SEALED_DIR` also sets the sealed folder).

| Key | Default | Meaning |
|---|---|---|
| `sealed` | `../sealed` | The sealed folder (absolute, or relative to the project) |
| `runs` | `trainer/runs` | Where each run's draft is kept, as `<runs>/<run>/candidate` |
| `refreshSeconds` | `10` | Seconds between reads |
| `maxDrafts` | `20` | How many runs are shown, newest first |

## Keys

↑/↓ select a run · Enter ask Main to show the change · R read now · Tab next widget · − collapse · Shift+O pop out · Shift+W close · Shift+arrows move · Esc back.

## Check

`sh trainer/card/fence.sh` (syntax, the shared rules' types, the tests).
