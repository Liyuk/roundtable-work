// Deterministic read-only snapshot of the supervisor's inputs. Every source is injected; the only
// GitHub methods used are listIssues, listPulls, listChecks(headSha) and listComments(issue).
import { parseHeartbeat } from './heartbeat.mjs';

/** @returns {Promise<object>} snapshot; `heartbeat` is the parseHeartbeat result (ok or missing/malformed). */
export async function collect({ now, issue, readHeartbeat, readDaemonState, readDaemonLog, github }) {
  const heartbeat = parseHeartbeat(await readHeartbeat());
  const pulls = await github.listPulls();
  const checks = Object.fromEntries(await Promise.all(pulls.map(async (pull) => [pull.number, await github.listChecks(pull.headSha)])));
  const progress = heartbeat.ok ? heartbeat.value.lastMaterialProgress : null;
  return {
    now,
    daemon: { state: await readDaemonState(), log: await readDaemonLog() },
    heartbeat,
    github: { issues: await github.listIssues(), pulls, checks, comments: await github.listComments(issue) },
    sinceLastMaterialProgressMs: progress ? now - progress.at : null,
  };
}
