// Security trigger set: the security (Gate 2 cross-check) pass runs only when a changed path matches.
// A path matches when one of its tokens (split on "/", ".", "_", "-") is listed below.
// Categories: auth, network, secrets, external input, deployment.
const TOKENS = new Set([
  // auth
  'auth', 'oauth', 'login', 'session', 'password', 'rbac', 'permission', 'permissions',
  // network
  'network', 'http', 'https', 'socket', 'proxy', 'webhook', 'listener',
  // secrets
  'secret', 'secrets', 'credential', 'credentials', 'token', 'tokens', 'env', 'key', 'keys', 'pem',
  // external input
  'intake', 'ingest', 'inbox', 'parse', 'parser', 'input', 'inputs',
  // deployment
  'deploy', 'deployment', 'docker', 'dockerfile', 'systemd', 'launchd',
]);

/** True when any changed path touches the security trigger set; pure and path-based. */
export function securityTriggers(changedFiles = []) {
  return changedFiles.some(file => file.toLowerCase().split(/[/._-]/).some(token => TOKENS.has(token)));
}
