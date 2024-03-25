const test = require('brittle')
const SimpleSeeder = require('../lib/simple-seeder.js')
const RAM = require('random-access-memory')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
const b4a = require('b4a')

test('basic', async function (t) {
  t.plan(10)

  const { testnet, seeds } = await createResources(t)

  const store = new Corestore(RAM)

  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarm.on('connection', (socket) => store.replicate(socket))
  t.teardown(() => swarm.destroy())

  const ss = new SimpleSeeder(store, swarm)
  t.teardown(() => ss.destroy())

  for (const seed of seeds) {
    const info = await ss.add(seed.key, seed.value)
    t.is(info.seeders, null)
    // DEVNOTE: testing the inflightRanges is over-testing,
    // as processing it correctly is the responsibility of corestore.
    // However, it's added here anyway because the seeder
    // was the original reason for adding that option, and
    // a mistake there can result in re-introducing that
    // hard-to-debug cascading failure
    if (info.type === 'core') {
      t.alike(info.instance.inflightRange, [16, 16], 'correct inflight range for core')
    } else if (info.type === 'bee') {
      t.alike(info.instance.core.inflightRange, [16, 16], 'correct infight range for bee')
    } else if (info.type === 'drive') {
      await info.instance.get('/a.txt') // Hack to get the blobs loaded
      t.alike(info.instance.db.core.inflightRange, [16, 16], 'correct inflight range for drive db core')
      t.alike(info.instance.blobs.core.inflightRange, [16, 16], 'correct inflight range for blobs db core')
    } else {
      throw new Error('Unexpected type, likely a bug in the test')
    }
  }

  t.alike(await ss.get(seeds.core.key).instance.get(0), b4a.from('ab'))
  t.alike(await ss.get(seeds.bee.key).instance.get('/a'), { seq: 1, key: b4a.from('/a'), value: b4a.from('ab') })
  t.alike(await ss.get(seeds.drive.key).instance.get('/a.txt'), b4a.from('ab'))
})

test('seeders option', async function (t) {
  t.plan(3)

  const { testnet, seeds } = await createResources(t)

  const store = new Corestore(RAM)

  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarm.on('connection', (socket) => store.replicate(socket))
  t.teardown(() => swarm.destroy())

  const ss = new SimpleSeeder(store, swarm)
  t.teardown(() => ss.destroy())

  for (const seed of seeds) {
    const info = await ss.add(seed.key, { ...seed.value, seeders: true })
    t.ok(info.seeders)
  }
})

test('closing a drive should not close the store in use', async function (t) {
  const { testnet, seeds } = await createResources(t)

  const store = new Corestore(RAM)

  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarm.on('connection', (socket) => store.replicate(socket))
  t.teardown(() => swarm.destroy())

  const ss = new SimpleSeeder(store, swarm)
  t.teardown(() => ss.destroy())

  await ss.add(seeds.drive.key, seeds.drive.value)
  await ss.remove(seeds.drive.key)

  await ss.add(seeds.core.key, seeds.core.value)
})

// TODO: decouple more and improve teardown
async function createResources (t) {
  const testnet = await createTestnet(3)
  t.teardown(() => testnet.destroy(), { order: Infinity })

  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  t.teardown(() => swarm.destroy())

  const store = new Corestore(RAM)
  t.teardown(() => store.close())

  const core = store.get({ name: 'a' })
  const bee = new Hyperbee(store.get({ name: 'b' }))
  const drive = new Hyperdrive(store.namespace('c'))

  t.teardown(() => core.close())
  t.teardown(() => bee.close())
  t.teardown(() => drive.close())

  await core.append('ab')
  await core.append('cd')

  await bee.put('/a', 'ab')
  await bee.put('/b', 'cd')

  await drive.put('/a.txt', 'ab')
  await drive.put('/b.txt', 'cd')

  const done = store.findingPeers()
  swarm.on('connection', (socket) => store.replicate(socket))
  swarm.join(core.discoveryKey)
  swarm.join(bee.core.discoveryKey)
  swarm.join(drive.discoveryKey)
  await swarm.flush().then(done, done) // Waits for announcing

  // TODO: another helper for a bee list
  const seeds = []

  seeds.push({ key: core.id, value: { type: 'core' } })
  seeds.push({ key: bee.core.id, value: { type: 'bee' } })
  seeds.push({ key: drive.id, value: { type: 'drive' } })

  seeds.core = seeds[0]
  seeds.bee = seeds[1]
  seeds.drive = seeds[2]

  return { testnet, seeds, resources: { core, bee, drive } }
}
