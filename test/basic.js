const test = require('brittle')
const SimpleSeeder = require('../lib/simple-seeder.js')
const RAM = require('random-access-memory')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
const b4a = require('b4a')
const SeedBee = require('seedbee')

test('basic', async function (t) {
  t.plan(6)

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

test('rejected peer by firewall', async function (t) {
  t.plan(1)

  const { testnet } = await createResources(t)

  const store = new Corestore(RAM)

  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })

  const ss = new SimpleSeeder(store, swarm)
  t.teardown(() => ss.destroy())

  const core = store.get({ name: 'seedbee-firewall-test' })
  const seedBee = new SeedBee(core)
  await seedBee.ready()

  const notAllowed = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const allowedPeersKey = 'simple-seeder/allowed-peers'
  await seedBee.metadata.put(allowedPeersKey, [Buffer.alloc(32).toString('hex')])

  ss.on('peer-rejected', (remotePublicKey) => {
    t.is(remotePublicKey.toString('hex'), notAllowed.keyPair.publicKey.toString('hex'))
    swarm.destroy()
    notAllowed.destroy()
  })

  await ss.add(seedBee.core.key, { type: 'list' })

  notAllowed.join(seedBee.core.discoveryKey)
  await notAllowed.flush()
})

test('connected peer through firewall', async function (t) {
  t.plan(1)

  const { testnet } = await createResources(t)

  const store = new Corestore(RAM)

  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })

  const ss = new SimpleSeeder(store, swarm)
  t.teardown(() => ss.destroy())

  const core = store.get({ name: 'seedbee-firewall-test' })
  const seedBee = new SeedBee(core)
  await seedBee.ready()

  const allowed = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const allowedPeersKey = 'simple-seeder/allowed-peers'
  await seedBee.metadata.put(allowedPeersKey, [allowed.keyPair.publicKey.toString('hex')])

  ss.on('peer-connected', (remotePublicKey) => {
    t.is(remotePublicKey.toString('hex'), allowed.keyPair.publicKey.toString('hex'))
    swarm.destroy()
    allowed.destroy()
  })

  await ss.add(seedBee.core.key, { type: 'list' })

  allowed.join(seedBee.core.discoveryKey)
  await allowed.flush()
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
