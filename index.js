#!/usr/bin/env node

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperbundle = require('hyperbundle')
const HypercoreId = require('hypercore-id-encoding')
const Seeders = require('@hyperswarm/seeders')
const minimist = require('minimist')
const goodbye = require('graceful-goodbye')
const fsp = require('fs/promises')
const configs = require('tiny-configs')

const argv = minimist(process.argv.slice(2), {
  alias: {
    key: 'k',
    bundle: 'b',
    seeder: 's'
  }
})

start().catch(err => {
  console.error(err)
  process.exit(1)
})

async function start () {
  const secretKey = argv['secret-key']
  const store = new Corestore(argv.storage || './corestore')
  const swarm = new Hyperswarm({
    seed: secretKey ? HypercoreId.decode(secretKey) : undefined,
    keyPair: secretKey ? undefined : await store.createKeyPair('simple-seeder-swarm')
  })

  console.log('Starting with with public key', HypercoreId.encode(swarm.keyPair.publicKey))

  const keys = [].concat(argv.key || [])
  const bundles = [].concat(argv.bundle || [])
  const seeders = [].concat(argv.seeder || [])

  if (argv.file) {
    const seeds = await fsp.readFile(argv.file)
    for (const [type, key] of configs.parse(seeds, { split: ' ', length: 2 })) {
      if (type === 'key') keys.push(key)
      else if (type === 'bundle') bundles.push(key)
      else if (type === 'seeder') seeders.push(key)
      else throw new Error('Invalid seed type: ' + type)
    }
  }

  let connections = 0

  swarm.on('connection', onsocket)

  swarm.listen()

  for (const key of keys) {
    downloadCore(key)
  }
  for (const key of bundles) {
    downloadBundle(key)
  }

  for (const s of seeders) {
    const publicKey = HypercoreId.decode(s)
    const id = HypercoreId.encode(publicKey)
    const keyPair = await store.createKeyPair('simple-seeder-swarm@' + id)
    const sw = new Seeders(publicKey, {
      dht: swarm.dht,
      keyPair: keyPair
    })

    console.log('Seeder swarm for ' + s + ' listening on ' + HypercoreId.encode(keyPair.publicKey))

    sw.join()
    sw.on('connection', onsocket)
    sw.on('update', function (record) {
      console.log('seeder change for ' + s + ':', record)
    })

    goodbye(() => sw.destroy())

    if (!bundles.includes(s)) {
      downloadBundle(s, false)
    }
  }

  async function downloadBundle (key, announce) {
    const bundleId = HypercoreId.encode(HypercoreId.decode(key))
    const bundle = new Hyperbundle(store, HypercoreId.decode(key))
    bundle.on('blobs', blobs => downloadCore(blobs.core, bundleId, false))
    console.log('downloading bundle', bundleId)
    downloadCore(bundle.core, null, announce)
  }

  async function downloadCore (core, bundleId, announce) {
    core = typeof core === 'string' ? store.get(HypercoreId.decode(core)) : core
    await core.ready()
    const id = HypercoreId.encode(core.key)
    console.log('downloading core', id)

    if (announce !== false) {
      console.log('announcing', id)
      swarm.join(core.discoveryKey)
    }
    core.download()

    core.on('download', function (index) {
      const bundleDataTag = bundleId ? 'with bundle ' + bundleId : ''
      console.log('downloaded block', index, 'from', id, bundleDataTag)
    })
  }

  goodbye(() => swarm.destroy())

  function onsocket (socket) {
    const p = HypercoreId.encode(socket.remotePublicKey)

    connections++

    console.log('Connection opened', p, '(total ' + connections + ')')
    store.replicate(socket)
    socket.on('error', function (err) {
      console.log(err)
    })
    socket.on('close', function () {
      connections--
      console.log('Connection closed', p, '(total ' + connections + ')')
    })
  }

  await swarm.dht.ready()

  console.log()
  console.log('Node info:')
  console.log('- remote host:', swarm.dht.host)
  console.log('- remote port:', swarm.dht.port)
  console.log('- firewalled:', swarm.dht.firewalled)
  console.log('- nat type:', swarm.dht.port ? 'consistent' : 'random')
  console.log()
}
