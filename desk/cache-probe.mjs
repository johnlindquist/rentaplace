// Does the model host reuse a stable prefix? Same knowledge twice: as the desk has it (short), and padded past the host's minimum.
import { askPlain, deskKnowledge } from './desk.mjs';
const k = deskKnowledge();
const filler = Array.from({ length: 220 }, (_, i) => `- House note ${i + 1}: the ${['lake', 'mill', 'casita', 'cabin'][i % 4]} home keeps its usual arrangements for linen, keys and rubbish collection in week ${i + 1}.`).join('\n');
const out = [];
for (const [name, system] of [['as built', k], ['longer notes', `${k}\n\n## More notes\n${filler}`]]) {
  for (const q of ['How long does a hold last?', 'Does a hold take a card?', 'What happens when a hold runs out?']) {
    const t = Date.now(), r = await askPlain(`${system}\n\nThe visitor is signed in as the guest Test.`, q);
    out.push({ name, ms: Date.now() - t, ...r.usage, cost: r.cost }); console.log(JSON.stringify(out.at(-1)));
  }
}
