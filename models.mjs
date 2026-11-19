// The one place the model defaults live. Checked against `pi --list-models` on 2026-11-18.
// Each tool keeps its own override: DESK_MODEL, VISITOR_MODEL, AGENT_MODEL, JUDGE_MODEL (or --judge-model),
// TRAINER_MODEL (or --trainer-model).
/** The small model: the desk, the agents under check, the visitors, the Trainer. */
export const SMALL_MODEL = 'anthropic/claude-haiku-5-5';
/** The larger model that judges replies against expectations. */
export const JUDGE_MODEL = 'anthropic/claude-sonnet-5-5';
