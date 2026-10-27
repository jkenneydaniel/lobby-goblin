import {assert} from '../common.js';
import {DocumentRepository} from './storage/document-repository.js';

export function releaseSettings(value) {
  assert(value?.version === 1 && typeof value.enabled === 'boolean' &&
    ['stable', 'preview'].includes(value.channel) && Number.isSafeInteger(value.revision) && value.revision >= 0,
  'Release check settings are invalid. Preserve them for review.', 503);
  return value;
}
export class ReleaseSettings {
  constructor(root, {enabled = true, channel = 'preview'} = {}) {
    this.repository = new DocumentRepository(root, {
      profile: 'accounts', namespace: 'configuration', key: 'release-checks', file: 'release-checks.json', schemaVersion: 1,
      empty: {version: 1, enabled, channel, revision: 0}, decode: releaseSettings,
    });
  }
  async read() { return (await this.repository.read()).value; }
  async save(input) {
    assert(typeof input?.enabled === 'boolean' && ['stable', 'preview'].includes(input.channel) && Number.isSafeInteger(input.revision), 'Choose release checks and a valid release channel.');
    return this.repository.transaction(async (value, commit) => {
      assert(input.revision === value.revision, 'Release check settings changed in another session. Reload before saving.', 409);
      Object.assign(value, {enabled: input.enabled, channel: input.channel, revision: value.revision + 1});
      await commit(); return value;
    });
  }
}
