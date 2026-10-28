// Frozen acquire operation from released v0.3.14-alpha (a97faced).
import {assert} from '../../common.js';
const fleetKey = 'io.lobby-goblin.fleet', roleKey = 'io.lobby-goblin.role';
export async function acquireV014(plan) {
    // Docker names provide an engine-wide exclusive claim, including operators
    // using two copies of the same installation directory. This container never
    // starts and has no mounts or credentials; it is only an ownership record.
    const name = 'lobby-goblin-management-lock-' + plan.fleet;
    let claim = await this.inspect(name, {optional: true});
    if (!claim) {
      const result = await this.request(
        'POST',
        '/containers/create?' + new URLSearchParams({name}),
        {
          Image: plan.imageId,
          Labels: {
            [fleetKey]: plan.fleet,
            [roleKey]: 'management-lock',
            'io.lobby-goblin.management-update': plan.id,
          },
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            RestartPolicy: {Name: 'no'},
          },
        },
      );
      claim = await this.inspect(result.Id);
    }
    assert(
      !claim.State.Running &&
        claim.Config.Labels?.[fleetKey] === plan.fleet &&
        claim.Config.Labels?.[roleKey] === 'management-lock' &&
        claim.Config.Labels?.['io.lobby-goblin.management-update'] ===
          plan.id &&
        !claim.Mounts?.length,
      'Another operator owns this fleet update. Inspect the retained claim before recovery.',
      409,
    );
  }
