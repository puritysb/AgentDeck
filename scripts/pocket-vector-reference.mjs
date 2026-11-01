import fs from 'node:fs';
import path from 'node:path';
/** Run the actual Node producer. Native tests replay the same inputs/goldens. */
export function runPocketVector(testcase, root, api) {
  const priorZone = process.env.TZ;
  process.env.TZ = testcase.timeZone;
  const statePath = path.join(root, 'pocket-autonomy.json');
  if (testcase.initialState) fs.writeFileSync(statePath, JSON.stringify(testcase.initialState));
  let config = testcase.config ?? {};
  let engine = new api.AutonomousPocketEngine({ statePath, config });
  let cards = [];
  const output = [];
  try {
    for (const step of testcase.steps) {
      const context = { sessions: step.sessions ?? testcase.sessions ?? [], glance: step.glance ?? testcase.glance, now: step.now };
      let result;
      if (step.op === 'build') {
        cards = api.buildModuleCards(context, engine.modules());
        result = cards;
        if (step.delivered) engine.observeDelivery(cards, step.now, 'xteink_x3');
      } else if (step.op === 'observe') engine.observeDelivery([], step.now, 'xteink_x3');
      else if (step.op === 'answer') {
        const cardId = step.cardId ?? cards.find(card => card.cardId.includes(`:auto:${step.kind}:`))?.cardId;
        if (!cardId) throw new Error(`fixture ${testcase.name}: missing ${step.kind}`);
        result = api.applyModuleChoice({ cardId, action: 'card_choice', choiceId: step.choiceId }, context, engine.modules());
      } else if (step.op === 'configure') { config = step.config; engine.configure(api.parsePocketAutonomyConfig({ pocketAutonomy: config })); }
      else if (step.op === 'reload') { engine.flush(); engine = new api.AutonomousPocketEngine({ statePath, config }); }
      engine.flush();
      output.push({ ...(result !== undefined ? { result } : {}), diagnostics: engine.diagnostics(), state: JSON.parse(fs.readFileSync(statePath, 'utf8')) });
    }
    return output;
  } finally {
    engine.flush();
    if (priorZone === undefined) delete process.env.TZ; else process.env.TZ = priorZone;
  }
}
