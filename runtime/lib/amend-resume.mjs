// The daemon's amend resume: runs the stored agent session with the owner's text as the next prompt. Fails closed.
import { createAdapterLauncher, selectAdapter } from './agent-adapter.mjs';

/** Returns `resume({ sessionId, text })`; throws when the launched agent does not exit with 0. */
export function makeAmendResume({ workspace, adapterName, spawnFn }) {
  const adapter = selectAdapter(adapterName);
  const launch = createAdapterLauncher({ adapter, command: adapter.name, spawnFn });
  return async ({ sessionId, text }) => {
    const code = await launch({ workspace, sessionId, resume: true, prompt: text });
    if (code !== 0) throw new Error(`amend resume exited with code ${code}`);
  };
}
