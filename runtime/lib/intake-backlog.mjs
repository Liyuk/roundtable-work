import { ASK_CATEGORIES } from './machine.mjs';

/** Build an issue draft in the shape intake admits: goal, numbered acceptance, scope, dependencies, size. */
export function intakeRequestIssue({ title, goal, acceptance, outOfScope, dependsOn = [], files, lines }) {
  const body = [
    '## Goal', goal, '',
    '## Acceptance criteria', ...acceptance.map(({ run, expected }) => `- Run: \`${run}\`; Expected: ${expected}`), '',
    '## Out of scope', outOfScope, '',
    '## Dependencies', dependsOn.length ? dependsOn.map(number => `Depends on #${number}`).join('\n') : 'None.', '',
    '## Size estimate', `Changed lines: ${lines}`, `Files: ${files}`,
  ].join('\n');
  return { title, body, labels: ['type:feature', 'rt:go'] };
}

/** Create one issue per task, in order; tasks are independent unless they declare dependsOn; a task paused by a closed-list ask category also gets rt:ask. */
export async function createBacklog(goal, tasks, client) {
  const numbers = [];
  for (const task of tasks) {
    const draft = intakeRequestIssue({ ...task, goal: `${task.goal}\n\nPart of: ${goal}` });
    const { number } = await client.createIssue(draft.title, draft.body);
    for (const label of draft.labels) await client.addLabel(number, label);
    if (ASK_CATEGORIES.includes(task.ask)) await client.addLabel(number, 'rt:ask');
    numbers.push(number);
  }
  return numbers;
}
