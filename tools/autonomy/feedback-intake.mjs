// Data-only extraction. No filesystem, shell, network, credentials or model API.
export const repository = 'jkenneydaniel/lobby-goblin';
export const maxInputBytes = 65536;

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a source record.');
  if (Object.keys(value).some(key => !keys.includes(key)))
    throw new Error('Unexpected source field.');
}

function text(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum)
    throw new Error('Invalid or oversized source text.');
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').toWellFormed();
}

export function redact(value) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]')
    .replace(/\b(?:authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"',;]+/gi, '[REDACTED CREDENTIAL]');
}

export function extractCandidate(source) {
  record(source, ['repository', 'kind', 'number', 'comment_id', 'title', 'body']);
  if (source.repository !== repository) throw new Error('Repository rejected.');
  if (!['issue', 'issue_comment', 'pull_request', 'review', 'review_comment', 'log'].includes(source.kind))
    throw new Error('Source kind rejected.');
  if (!Number.isSafeInteger(source.number) || source.number < 1)
    throw new Error('Source number rejected.');
  const hasComment = ['issue_comment', 'review', 'review_comment'].includes(source.kind);
  if (hasComment && (!Number.isSafeInteger(source.comment_id) || source.comment_id < 1))
    throw new Error('Source ID rejected.');
  if (!hasComment && source.comment_id != null) throw new Error('Unexpected source ID.');
  const body = text(source.body, 32768);
  const title = text(source.title ?? '', 512);
  const redactedBody = redact(body);
  const redactedTitle = redact(title);
  const excerpt = [...redactedBody].slice(0, 4000).join('');
  const path = source.kind === 'log' ? `actions/runs/${source.number}`
    : `${source.kind === 'issue' || source.kind === 'issue_comment' ? 'issues' : 'pull'}/${source.number}`;
  const anchor = source.kind === 'issue_comment' ? `#issuecomment-${source.comment_id}`
    : source.kind === 'review' ? `#pullrequestreview-${source.comment_id}`
      : source.kind === 'review_comment' ? `#discussion_r${source.comment_id}` : '';
  return {
    version: 1,
    trust: 'untrusted_data',
    source: {repository, kind: source.kind, number: source.number, comment_id: source.comment_id ?? null,
      url: `https://github.com/${repository}/${path}${anchor}`},
    problem: redactedTitle,
    evidence_excerpt: excerpt,
    requested_outcome: null,
    suggested_acceptance_criteria: [],
    requested_actions: [],
    requires_source_verification: true,
    redacted: redactedBody !== body || redactedTitle !== title,
    truncated: excerpt.length < redactedBody.length,
  };
}

export function parseCandidate(input) {
  if (Buffer.byteLength(input, 'utf8') > maxInputBytes) throw new Error('Input too large.');
  return extractCandidate(JSON.parse(input));
}
